import type { FastifyInstance } from 'fastify'

// Health check that reports product CAPABILITY status, not just infra connectivity (L-002)
export async function healthRoutes(server: FastifyInstance) {
  server.get('/health', {
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
              },
            },
          },
        },
      },
    },
  }, async (_request, _reply) => {
    const capabilities: Record<string, { status: string; latency_ms?: number }> = {}

    // Database check
    try {
      const start = Date.now()
      // TODO: Replace with actual Prisma query when DB is connected
      // await prisma.$queryRaw`SELECT 1`
      capabilities.database = { status: 'up', latency_ms: Date.now() - start }
    } catch {
      capabilities.database = { status: 'down' }
    }

    // Redis check
    try {
      const start = Date.now()
      // TODO: Replace with actual Redis ping when connected
      // await redis.ping()
      capabilities.redis = { status: 'up', latency_ms: Date.now() - start }
    } catch {
      capabilities.redis = { status: 'down' }
    }

    // Anthropic API check
    capabilities.anthropic_api = {
      status: process.env.ANTHROPIC_API_KEY ? 'configured' : 'not_configured',
    }

    // Langfuse check
    capabilities.langfuse = {
      status: process.env.LANGFUSE_PUBLIC_KEY ? 'configured' : 'not_configured',
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
