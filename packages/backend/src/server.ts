import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUI from '@fastify/swagger-ui'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import Redis from 'ioredis'
import { validateEnv } from './lib/env.js'
import { prisma, ownerPrisma, setTenantContext } from './middleware/rls.js'
import { flushTraces, initLangfuse, shutdownLangfuse } from './observability/langfuse.js'
import { adminRoutes } from './routes/admin.js'
import { aiProxyRoutes } from './routes/ai-proxy.js'
import { analyticsRoutes } from './routes/analytics.js'
import { appStaticRoutes } from './routes/app-static.js'
import { appRoutes } from './routes/apps.js'
import { authRoutes } from './routes/auth.js'
import { chatRoutes } from './routes/chat.js'
import { chatbridgeCompletionsRoutes } from './routes/chatbridge-completions.js'
import { classroomRoutes } from './routes/classrooms.js'
import { collabRoutes } from './routes/collab.js'
import { consentRoutes } from './routes/consent.js'
import { healthRoutes } from './routes/health.js'
import { websocketRoutes } from './routes/websocket.js'

const envToLogger = {
  development: { level: 'debug' },
  production: { level: 'info' },
  test: { level: 'warn' },
}

export async function buildServer() {
  const env = (process.env.NODE_ENV ?? 'development') as keyof typeof envToLogger

  const server = Fastify({
    logger: envToLogger[env] ?? envToLogger.development,
  })

  // Plugins
  await server.register(cors, {
    origin: process.env.CORS_ORIGINS?.split(',') ?? ['http://localhost:1212', 'http://localhost:3000'],
    credentials: true,
  })

  // F2: Rate limiter with Redis store
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380'
  const rateLimitRedis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  })
  // Suppress unhandled error events — rate-limit plugin handles errors via skipOnError
  rateLimitRedis.on('error', () => {})
  // Attempt connection but don't block if Redis is down (rate limiting falls back to in-memory)
  try {
    await rateLimitRedis.connect()
  } catch {
    server.log.warn('Redis unavailable for rate-limit store — falling back to in-memory')
  }

  await server.register(rateLimit, {
    global: false, // Per-route configuration
    max: 60,
    timeWindow: '1 minute',
    redis: rateLimitRedis,
    skipOnError: true, // Don't 500 if Redis is down — allow request through
    nameSpace: env === 'test'
      ? `chatbridge-rl-${Date.now()}-${Math.random().toString(36).slice(2)}-`
      : 'chatbridge-rl-',
  })

  await server.register(websocket)

  // OpenAPI / Swagger (L-001: NEVER disable)
  await server.register(swagger, {
    openapi: {
      info: {
        title: 'ChatBridge v2 API',
        version: '1.0.0',
        description: 'K-12 AI chat platform with third-party app integration',
      },
      servers: [{ url: '/api/v1' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  })

  await server.register(swaggerUI, {
    routePrefix: '/docs',
  })

  // F1: Canonical /openapi.json route alias
  server.get('/openapi.json', async (_request, reply) => {
    const spec = server.swagger()
    return reply.send(spec)
  })

  // Routes (with per-route rate limits)
  await server.register(healthRoutes, { prefix: '/api/v1' })
  await server.register(authRoutes, { prefix: '/api/v1' })
  await server.register(classroomRoutes, { prefix: '/api/v1' })
  await server.register(chatRoutes, { prefix: '/api/v1' })
  await server.register(appRoutes, { prefix: '/api/v1' })
  await server.register(websocketRoutes, { prefix: '/api/v1' })
  await server.register(collabRoutes, { prefix: '/api/v1' })
  await server.register(adminRoutes, { prefix: '/api/v1' })
  await server.register(consentRoutes, { prefix: '/api/v1' })
  await server.register(analyticsRoutes, { prefix: '/api/v1' })
  await server.register(aiProxyRoutes, { prefix: '/api/v1' })
  await server.register(chatbridgeCompletionsRoutes, { prefix: '/api/v1' })
  await server.register(appStaticRoutes, { prefix: '/api/v1' })

  // RLS middleware: SET LOCAL app.tenant_id for authenticated requests
  // This ensures every DB query is scoped to the correct tenant (FERPA compliance).
  // withTenantContext() is also available for explicit per-route transactional use.
  server.addHook('onRequest', async (request) => {
    const user = (request as any).user as { districtId?: string } | undefined
    if (user?.districtId) {
      await setTenantContext(user.districtId)
    }
  })

  // Audit trail: log every request (FERPA compliance)
  // Do NOT log request/response bodies (privacy)
  // IMPORTANT: Uses withTenantContext() to set RLS tenant within a transaction.
  // The bare prisma client's SET LOCAL has expired by the time onResponse fires
  // (it was transaction-scoped in onRequest), so we must re-establish tenant
  // context inside a fresh transaction here.
  server.addHook('onResponse', async (request, reply) => {
    const user = (request as any).user as { userId?: string; districtId?: string } | undefined
    // Only audit authenticated requests to avoid noisy health-check logs
    if (user?.userId && user?.districtId) {
      const latencyMs = Math.round(reply.elapsedTime)
      try {
        const { withTenantContext } = await import('./middleware/rls.js')
        await withTenantContext(user.districtId, async (tx) => {
          await tx.auditEvent.create({
            data: {
              districtId: user.districtId!,
              userId: user.userId!,
              action: request.method,
              resourceType: 'http_request',
              resourceId: request.url.split('?')[0], // Strip query params (may contain tokens)
              metadata: {
                statusCode: reply.statusCode,
                latencyMs,
              },
            },
          })
        })
      } catch {
        // Non-blocking: audit failure must not break the response
        request.log.warn('Failed to write audit event')
      }
    }
  })

  // Cleanup Redis on server close
  server.addHook('onClose', async () => {
    try { await rateLimitRedis.quit() } catch { /* ignore */ }
  })

  return server
}

/**
 * Register built-in apps via Prisma at startup (equivalent to POST /apps/register).
 * A6: Chess app must be registered at startup, not just manually seeded.
 */
export async function registerBuiltInApps() {
  const CHESS_APP_ID = '00000000-0000-4000-e000-000000000001'
  const CHESS_TOOLS = [
    { name: 'start_game', description: 'Start a new chess game', inputSchema: { type: 'object' } },
    { name: 'make_move', description: 'Make a chess move', inputSchema: { type: 'object', properties: { move: { type: 'string' } } } },
    { name: 'get_legal_moves', description: 'Get legal moves for current position', inputSchema: { type: 'object', properties: { fen: { type: 'string' } } } },
  ]

  const CHESS_DATA = {
    id: CHESS_APP_ID,
    name: 'Chess',
    description: 'Interactive chess learning app with AI opponent and move analysis',
    toolDefinitions: CHESS_TOOLS,
    uiManifest: { url: '/api/v1/apps/chess/ui/', width: 600, height: 600, sandboxAttrs: ['allow-scripts'] },
    permissions: { scopes: ['read:board_state', 'write:moves'] },
    complianceMetadata: { coppa: true, ferpa: true, piiCollected: false, dataRetentionDays: 90 },
    version: '1.0.0',
    reviewStatus: 'approved' as const,
  }

  // Update ALL existing "Chess" apps (by name) so legacy apps with different IDs are also patched
  await ownerPrisma.app.updateMany({
    where: { name: 'Chess' },
    data: {
      toolDefinitions: CHESS_DATA.toolDefinitions,
      reviewStatus: CHESS_DATA.reviewStatus,
    },
  })

  // Upsert canonical chess app by its fixed ID
  await ownerPrisma.app.upsert({
    where: { id: CHESS_APP_ID },
    create: CHESS_DATA,
    update: {
      name: CHESS_DATA.name,
      description: CHESS_DATA.description,
      toolDefinitions: CHESS_DATA.toolDefinitions,
      uiManifest: CHESS_DATA.uiManifest,
      permissions: CHESS_DATA.permissions,
      complianceMetadata: CHESS_DATA.complianceMetadata,
      version: CHESS_DATA.version,
      reviewStatus: CHESS_DATA.reviewStatus,
    },
  })
}

// Start server
async function start() {
  // F4: Validate required env vars before anything else
  validateEnv()

  // Initialize observability
  initLangfuse()

  const server = await buildServer()
  const port = parseInt(process.env.PORT ?? '3001', 10)
  const host = process.env.HOST ?? '0.0.0.0'

  try {
    await server.listen({ port, host })

    // A6: Register built-in apps at startup (not just via seed)
    await registerBuiltInApps()
    server.log.info('Built-in apps registered')

    server.log.info(`ChatBridge v2 API running on ${host}:${port}`)
    server.log.info(`Swagger UI: http://localhost:${port}/docs`)
    server.log.info(`OpenAPI JSON: http://localhost:${port}/docs/json`)

    // Graceful shutdown — flush observability, close server
    const shutdown = async (signal: string) => {
      server.log.info(`${signal} received — shutting down gracefully`)
      await shutdownLangfuse()
      await server.close()
      process.exit(0)
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

// Only run when executed directly (not when imported as a module in tests)
if (process.env.NODE_ENV !== 'test') {
  start()
}
