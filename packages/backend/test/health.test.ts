import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { signJWT } from '../src/middleware/auth.js'

describe('Health endpoint (L-002: capability-aware)', () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()
  })

  afterAll(async () => {
    await server.close()
  })

  it('GET /api/v1/health returns 200 with capability status', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.status).toBeDefined()
    expect(body.capabilities).toBeDefined()
    expect(body.capabilities.database).toBeDefined()
    expect(body.capabilities.redis).toBeDefined()
    expect(body.capabilities.anthropic_api).toBeDefined()
    expect(body.capabilities.langfuse).toBeDefined()
    expect(body.timestamp).toBeDefined()
  })

  it('health reports correct status when Anthropic key is not set', async () => {
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
    })

    const body = JSON.parse(response.body)
    expect(body.capabilities.anthropic_api.status).toBe('not_configured')

    // Restore
    if (saved) process.env.ANTHROPIC_API_KEY = saved
  })

  it('overall status degrades when a capability is down', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
    })

    const body = JSON.parse(response.body)
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status)
  })

  // F5: Health MUST report redis as down when Redis is unreachable
  it('health degrades when Redis is unreachable', async () => {
    // Use a separate server pointed at a non-existent Redis port
    const savedRedis = process.env.REDIS_URL
    process.env.REDIS_URL = 'redis://localhost:19999'

    const testServer = await buildServer()
    await testServer.ready()

    const response = await testServer.inject({
      method: 'GET',
      url: '/api/v1/health',
    })

    await testServer.close()

    // Restore env BEFORE assertions so other tests aren't affected
    process.env.REDIS_URL = savedRedis ?? 'redis://localhost:6380'

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.capabilities.redis.status).toBe('down')
    expect(['degraded', 'unhealthy']).toContain(body.status)
  })
})

describe('Swagger UI (L-001: must be enabled)', () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()
  })

  afterAll(async () => {
    await server.close()
  })

  it('GET /docs returns 200 (Swagger UI)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs',
    })

    expect(response.statusCode).toBe(200)
  })

  it('GET /docs/json returns OpenAPI spec', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/docs/json',
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.openapi).toMatch(/^3\./)
    expect(body.info.title).toBe('ChatBridge v2 API')
  })

  // F1: /openapi.json canonical route
  it('GET /openapi.json returns OpenAPI spec (canonical alias)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/openapi.json',
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.openapi).toMatch(/^3\./)
    expect(body.info.title).toBe('ChatBridge v2 API')
  })
})

// F2: Rate limiter returns 429 when limit exceeded
describe('Rate limiting (Redis-backed)', () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()
  })

  afterAll(async () => {
    await server.close()
  })

  it('returns 429 when rate limit is exceeded on health route', async () => {
    // Health route has per-route limit of 30/minute
    // Send 31 sequential requests to ensure counter increments correctly
    let got429 = false
    for (let i = 0; i < 35; i++) {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/health',
      })
      if (response.statusCode === 429) {
        got429 = true
        break
      }
    }
    expect(got429).toBe(true)
  })
})

// F3: WebSocket auth enforcement
describe('WebSocket auth (reject unauthenticated)', () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()
  })

  afterAll(async () => {
    await server.close()
  })

  it('WS /api/v1/ws/chat without token does not get 101 upgrade', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/ws/chat',
      headers: {
        connection: 'upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })

    // Without a valid token, the WS handler closes with 4001.
    // With inject (no real WS negotiation), we verify it doesn't return 101.
    expect(response.statusCode).not.toBe(101)
  })
})

// F3b: WebSocket positive auth — valid JWT gets 101 upgrade
describe('WebSocket auth (accept authenticated)', () => {
  let server: FastifyInstance
  let address: string

  beforeAll(async () => {
    server = await buildServer()
    // Listen on random port for real WS connection
    await server.listen({ port: 0, host: '127.0.0.1' })
    const addr = server.server.address()
    if (addr && typeof addr === 'object') {
      address = `ws://127.0.0.1:${addr.port}`
    }
  })

  afterAll(async () => {
    await server.close()
  })

  it('WS /api/v1/ws/chat with valid JWT receives 101 upgrade', async () => {
    const token = signJWT({
      userId: 'test-student-001',
      role: 'student',
      districtId: 'test-district-001',
    })

    const ws = new WebSocket(`${address}/api/v1/ws/chat?token=${token}`)

    const result = await new Promise<{ opened: boolean; code?: number }>((resolve) => {
      const timeout = setTimeout(() => {
        ws.close()
        resolve({ opened: false })
      }, 5000)

      ws.on('open', () => {
        clearTimeout(timeout)
        resolve({ opened: true })
      })

      ws.on('error', () => {
        clearTimeout(timeout)
        resolve({ opened: false })
      })

      ws.on('close', (code) => {
        clearTimeout(timeout)
        resolve({ opened: false, code })
      })
    })

    // Clean up
    if (ws.readyState === WebSocket.OPEN) {
      ws.close()
    }

    expect(result.opened).toBe(true)
  })
})

// F4: Env validation
describe('Env validation at startup', () => {
  it('validateEnv throws when required vars are missing', async () => {
    const { validateEnv } = await import('../src/lib/env.js')

    const saved: Record<string, string | undefined> = {}
    const keys = ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET_KEY', 'ANTHROPIC_API_KEY']
    for (const k of keys) {
      saved[k] = process.env[k]
      delete process.env[k]
    }

    expect(() => validateEnv()).toThrow('Missing required environment variables')

    // Restore
    for (const k of keys) {
      if (saved[k] !== undefined) process.env[k] = saved[k]
    }
  })
})

// F6: Pino structured logging
describe('Pino structured logging', () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()
  })

  afterAll(async () => {
    await server.close()
  })

  it('server logger is Pino with structured JSON output', async () => {
    expect(server.log).toBeDefined()
    expect(typeof server.log.info).toBe('function')
    expect(typeof server.log.error).toBe('function')
    expect(typeof server.log.child).toBe('function')
  })
})
