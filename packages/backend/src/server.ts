import Fastify from 'fastify'
import { initLangfuse, flushTraces } from './observability/langfuse.js'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import swagger from '@fastify/swagger'
import swaggerUI from '@fastify/swagger-ui'
import { healthRoutes } from './routes/health.js'
import { authRoutes } from './routes/auth.js'
import { classroomRoutes } from './routes/classrooms.js'
import { chatRoutes } from './routes/chat.js'
import { appRoutes } from './routes/apps.js'
import { websocketRoutes } from './routes/websocket.js'
import { collabRoutes } from './routes/collab.js'
import { adminRoutes } from './routes/admin.js'
import { analyticsRoutes } from './routes/analytics.js'
import { aiProxyRoutes } from './routes/ai-proxy.js'
import { appStaticRoutes } from './routes/app-static.js'

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

  await server.register(rateLimit, {
    global: false, // Per-route configuration
    max: 60,
    timeWindow: '1 minute',
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
    },
  })

  await server.register(swaggerUI, {
    routePrefix: '/docs',
  })

  // Routes
  await server.register(healthRoutes, { prefix: '/api/v1' })
  await server.register(authRoutes, { prefix: '/api/v1' })
  await server.register(classroomRoutes, { prefix: '/api/v1' })
  await server.register(chatRoutes, { prefix: '/api/v1' })
  await server.register(appRoutes, { prefix: '/api/v1' })
  await server.register(websocketRoutes, { prefix: '/api/v1' })
  await server.register(collabRoutes, { prefix: '/api/v1' })
  await server.register(adminRoutes, { prefix: '/api/v1' })
  await server.register(analyticsRoutes, { prefix: '/api/v1' })
  await server.register(aiProxyRoutes, { prefix: '/api/v1' })
  await server.register(appStaticRoutes, { prefix: '/api/v1' })

  return server
}

// Start server
async function start() {
  // Initialize observability
  initLangfuse()

  const server = await buildServer()
  const port = parseInt(process.env.PORT ?? '3001', 10)
  const host = process.env.HOST ?? '0.0.0.0'

  try {
    await server.listen({ port, host })
    server.log.info(`ChatBridge v2 API running on ${host}:${port}`)
    server.log.info(`Swagger UI: http://localhost:${port}/docs`)
    server.log.info(`OpenAPI JSON: http://localhost:${port}/docs/json`)
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
