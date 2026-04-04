import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildServer } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma } from '../src/middleware/rls.js'
import {
  getHealthStatus,
  recordSuccess,
  recordFailure,
  _resetHealthStore,
} from '../src/apps/health.js'
import {
  checkRateLimit,
  _resetRateLimitStore,
} from '../src/apps/rate-limiter.js'
import type { FastifyInstance } from 'fastify'

// =============================================================================
// Unit tests: Health monitoring
// =============================================================================

describe('App Health Monitoring — unit tests', () => {
  beforeEach(() => {
    _resetHealthStore()
  })

  it('new app defaults to healthy', () => {
    const status = getHealthStatus('app-1')
    expect(status.status).toBe('healthy')
    expect(status.consecutiveFailures).toBe(0)
  })

  it('recordSuccess keeps app healthy and tracks latency', () => {
    recordSuccess('app-1', 50)
    recordSuccess('app-1', 150)
    const status = getHealthStatus('app-1')
    expect(status.status).toBe('healthy')
    expect(status.avgLatencyMs).toBe(100) // (50+150)/2
  })

  it('3 consecutive failures mark app as degraded', () => {
    recordFailure('app-1')
    recordFailure('app-1')
    expect(getHealthStatus('app-1').status).toBe('healthy')
    recordFailure('app-1')
    expect(getHealthStatus('app-1').status).toBe('degraded')
    expect(getHealthStatus('app-1').consecutiveFailures).toBe(3)
  })

  it('5 consecutive failures mark app as unresponsive', () => {
    for (let i = 0; i < 5; i++) recordFailure('app-1')
    expect(getHealthStatus('app-1').status).toBe('unresponsive')
    expect(getHealthStatus('app-1').consecutiveFailures).toBe(5)
  })

  it('successful invocation after failures resets to healthy', () => {
    for (let i = 0; i < 4; i++) recordFailure('app-1')
    expect(getHealthStatus('app-1').status).toBe('degraded')
    recordSuccess('app-1', 30)
    expect(getHealthStatus('app-1').status).toBe('healthy')
    expect(getHealthStatus('app-1').consecutiveFailures).toBe(0)
  })
})

// =============================================================================
// Unit tests: Rate limiter
// =============================================================================

describe('Rate Limiter — unit tests', () => {
  beforeEach(() => {
    _resetRateLimitStore()
  })

  it('allows requests within limit', () => {
    for (let i = 0; i < 100; i++) {
      const result = checkRateLimit('app-1')
      expect(result.allowed).toBe(true)
    }
  })

  it('blocks 101st request in same window', () => {
    const now = Date.now()
    for (let i = 0; i < 100; i++) {
      checkRateLimit('app-1', now)
    }
    const result = checkRateLimit('app-1', now)
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSec).toBeGreaterThan(0)
    expect(result.remaining).toBe(0)
  })

  it('resets after window elapses', () => {
    const now = Date.now()
    for (let i = 0; i < 100; i++) {
      checkRateLimit('app-1', now)
    }
    // Jump forward 61 seconds
    const result = checkRateLimit('app-1', now + 61_000)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(99)
  })

  it('tracks apps independently', () => {
    for (let i = 0; i < 100; i++) checkRateLimit('app-1')
    const r1 = checkRateLimit('app-1')
    expect(r1.allowed).toBe(false)

    const r2 = checkRateLimit('app-2')
    expect(r2.allowed).toBe(true)
  })
})

// =============================================================================
// Integration tests: Health + Rate Limiting wired into routes
// =============================================================================

const validAppPayload = {
  name: 'Health Test App',
  description: 'App for health monitoring tests',
  toolDefinitions: [{ name: 'start_game', description: 'Start a game', inputSchema: { type: 'object' } }],
  uiManifest: { url: 'https://test.chatbridge.app', width: 500, height: 500 },
  permissions: { network: true },
  complianceMetadata: {},
  version: '1.0.0',
}

describe('App Health + Rate Limit — integration via routes', () => {
  let server: FastifyInstance
  let districtId: string
  let teacherToken: string
  let studentToken: string
  let conversationId: string

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()

    const district = await ownerPrisma.district.create({ data: { name: 'Health Test District' } })
    districtId = district.id

    const teacher = await ownerPrisma.user.create({
      data: { districtId, role: 'teacher', displayName: 'Health Teacher' },
    })
    const student = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Health Student', gradeBand: 'g68' },
    })

    teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId })
    studentToken = signJWT({ userId: student.id, role: 'student', districtId })

    const classroom = await ownerPrisma.classroom.create({
      data: {
        districtId, teacherId: teacher.id, name: 'Health Class',
        joinCode: 'HLTH01', gradeBand: 'g68', aiConfig: { mode: 'direct' },
      },
    })

    const conversation = await ownerPrisma.conversation.create({
      data: { districtId, classroomId: classroom.id, studentId: student.id },
    })
    conversationId = conversation.id
  })

  beforeEach(() => {
    _resetHealthStore()
    _resetRateLimitStore()
  })

  afterAll(async () => {
    try {
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM tool_invocations WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM app_instances WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM messages WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM conversations WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM classrooms WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM apps WHERE id IN (SELECT id FROM apps WHERE developer_id IS NULL)`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM users WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = '${districtId}'`)
    } catch { /* Best effort */ }
    await server.close()
  })

  async function registerAndApproveApp(token: string) {
    const regRes = await server.inject({
      method: 'POST',
      url: '/api/v1/apps/register',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validAppPayload, name: `Health App ${Date.now()}` },
    })
    const { appId } = JSON.parse(regRes.body)
    await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/submit-review`,
      headers: { authorization: `Bearer ${token}` },
    })
    return appId
  }

  it('healthy app invocation succeeds with 200', async () => {
    const appId = await registerAndApproveApp(teacherToken)

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/tools/start_game/invoke`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { parameters: {}, conversationId },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.toolName).toBe('start_game')
    expect(body.result).toBeDefined()
  })

  it('unresponsive app returns 503', async () => {
    const appId = await registerAndApproveApp(teacherToken)

    // Simulate 5 consecutive failures to make app unresponsive
    for (let i = 0; i < 5; i++) recordFailure(appId)
    expect(getHealthStatus(appId).status).toBe('unresponsive')

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/tools/start_game/invoke`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { parameters: {}, conversationId },
    })

    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body)
    expect(body.error).toContain('unresponsive')
  })

  it('successful invocation after failures recovers app to healthy', async () => {
    const appId = await registerAndApproveApp(teacherToken)

    // Simulate 4 failures (degraded but not unresponsive)
    for (let i = 0; i < 4; i++) recordFailure(appId)
    expect(getHealthStatus(appId).status).toBe('degraded')

    // Invoke (should succeed and recover health)
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/tools/start_game/invoke`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { parameters: {}, conversationId },
    })

    expect(res.statusCode).toBe(200)
    expect(getHealthStatus(appId).status).toBe('healthy')
    expect(getHealthStatus(appId).consecutiveFailures).toBe(0)
  })

  it('rate limit: 101st request returns 429 with Retry-After', async () => {
    const appId = await registerAndApproveApp(teacherToken)

    // Exhaust rate limit (100 allowed invocations)
    for (let i = 0; i < 100; i++) {
      checkRateLimit(appId)
    }

    // The 101st invocation through the route should be rejected
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/tools/start_game/invoke`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { parameters: {}, conversationId },
    })

    expect(res.statusCode).toBe(429)
    const body = JSON.parse(res.body)
    expect(body.error).toContain('Rate limit')
    expect(body.retryAfterSec).toBeGreaterThan(0)
    expect(res.headers['retry-after']).toBeDefined()
  })
})
