import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'

describe('ChatBridge native completions auth', () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()
  })

  afterAll(async () => {
    await server.close()
  })

  it('rejects unauthenticated native completions requests', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/chatbridge/completions',
      payload: {
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })

    expect(res.statusCode).toBe(401)
  })
})
