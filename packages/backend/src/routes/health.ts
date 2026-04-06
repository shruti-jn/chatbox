import type { FastifyInstance } from 'fastify'
import Redis from 'ioredis'
import { prisma } from '../middleware/rls.js'

// Health check that reports product CAPABILITY status, not just infra connectivity (L-002)
export async function healthRoutes(server: FastifyInstance) {
  server.get('/health', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
            timestamp: { type: 'string' },
            capabilities: {
              type: 'object',
              properties: {
                database: { type: 'object', properties: { status: { type: 'string' }, latency_ms: { type: 'number' } } },
                redis: { type: 'object', properties: { status: { type: 'string' }, latency_ms: { type: 'number' } } },
                anthropic_api: { type: 'object', properties: { status: { type: 'string' } } },
                langfuse: { type: 'object', properties: { status: { type: 'string' } } },
                weather: { type: 'object', properties: { status: { type: 'string' } } },
              },
            },
          },
        },
      },
    },
  }, async (_request, _reply) => {
    const capabilities: Record<string, { status: string; latency_ms?: number }> = {}

    // Database check — real Prisma query, not a stub (L-002)
    try {
      const start = Date.now()
      await prisma.$queryRaw`SELECT 1`
      capabilities.database = { status: 'up', latency_ms: Date.now() - start }
    } catch {
      capabilities.database = { status: 'down' }
    }

    // F5: Redis check — actually ping Redis
    {
      let redis: Redis | null = null
      try {
        const start = Date.now()
        const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380'
        redis = new Redis(redisUrl, {
          maxRetriesPerRequest: 1,
          lazyConnect: true,
          connectTimeout: 2000,
          enableOfflineQueue: false,
        })
        // Suppress unhandled error events (we handle errors in catch)
        redis.on('error', () => {})
        await redis.connect()
        const pong = await redis.ping()
        const latency = Date.now() - start
        capabilities.redis = pong === 'PONG'
          ? { status: 'up', latency_ms: latency }
          : { status: 'down' }
      } catch {
        capabilities.redis = { status: 'down' }
      } finally {
        if (redis) {
          try { redis.disconnect() } catch { /* ignore */ }
        }
      }
    }

    // Anthropic API check
    capabilities.anthropic_api = {
      status: process.env.ANTHROPIC_API_KEY ? 'configured' : 'not_configured',
    }

    // Langfuse check
    capabilities.langfuse = {
      status: process.env.LANGFUSE_PUBLIC_KEY ? 'configured' : 'not_configured',
    }

    // Weather API check
    capabilities.weather = {
      status: process.env.OPENWEATHER_API_KEY ? 'configured' : 'not_configured',
    }

    // Overall status: worst capability determines status
    const statuses = Object.values(capabilities).map((c) => c.status)
    let overall: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
    if (statuses.includes('down')) overall = 'degraded'
    if (statuses.filter((s) => s === 'down').length > 1) overall = 'unhealthy'

    return {
      status: overall,
      timestamp: new Date().toISOString(),
      capabilities,
    }
  })
}
