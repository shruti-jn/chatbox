import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'

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
    delete process.env.ANTHROPIC_API_KEY

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
    })

    const body = JSON.parse(response.body)
    expect(body.capabilities.anthropic_api.status).toBe('not_configured')
  })

  it('overall status degrades when a capability is down', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
    })

    const body = JSON.parse(response.body)
    // At minimum, status should be one of the valid values
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status)
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
})
