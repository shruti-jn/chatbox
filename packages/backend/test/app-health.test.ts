import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { buildServer } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma } from '../src/middleware/rls.js'
import {
  getHealthStatus,
  recordSuccess,
  recordFailure,
  _resetHealthStore,
  isBlocked,
  isDegraded,
  healthConfig,
  startHealthPolling,
  stopHealthPolling,
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

  it('isBlocked returns true for degraded apps (3+ failures)', () => {
    for (let i = 0; i < 3; i++) recordFailure('app-block')
    expect(isDegraded('app-block')).toBe(true)
    expect(isBlocked('app-block')).toBe(true)
  })

  it('isBlocked returns true for unresponsive apps (5+ failures)', () => {
    for (let i = 0; i < 5; i++) recordFailure('app-block2')
    expect(isBlocked('app-block2')).toBe(true)
  })

  it('isBlocked returns false for healthy apps', () => {
    expect(isBlocked('app-healthy')).toBe(false)
  })

  it('thresholds are configurable via healthConfig', () => {
    // Save originals
    const origDegraded = healthConfig.degradedThreshold
    const origUnresponsive = healthConfig.unresponsiveThreshold

    // Make degraded easier to trigger
    healthConfig.degradedThreshold = 1
    healthConfig.unresponsiveThreshold = 2

    recordFailure('app-config')
    expect(getHealthStatus('app-config').status).toBe('degraded')

    recordFailure('app-config')
    expect(getHealthStatus('app-config').status).toBe('unresponsive')

    // Restore
    healthConfig.degradedThreshold = origDegraded
    healthConfig.unresponsiveThreshold = origUnresponsive
  })
})

// =============================================================================
// Unit tests: Health events DB logging
// =============================================================================

describe('App Health Events — DB logging', () => {
  beforeEach(() => {
    _resetHealthStore()
  })

  afterAll(async () => {
    // Clean up health events created during tests
    await ownerPrisma.$executeRawUnsafe(`DELETE FROM app_health_events WHERE 1=1`)
  })

  it('logs degraded event to DB when app transitions to degraded', async () => {
    // Create a test app in DB
    const app = await ownerPrisma.app.create({
      data: {
        name: `HealthEvt Degraded ${Date.now()}`,
        description: 'test',
        toolDefinitions: [],
        uiManifest: { url: 'https://test.app' },
        permissions: {},
        complianceMetadata: {},
        version: '1.0.0',
        reviewStatus: 'approved',
      },
    })

    // Record 3 failures to trigger degraded
    for (let i = 0; i < 3; i++) {
      await recordFailure(app.id)
    }

    // Check DB for health event
    const events = await ownerPrisma.appHealthEvent.findMany({
      where: { appId: app.id, eventType: 'degraded' },
    })
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0].eventType).toBe('degraded')

    // Cleanup
    await ownerPrisma.appHealthEvent.deleteMany({ where: { appId: app.id } })
    await ownerPrisma.app.delete({ where: { id: app.id } })
  })

  it('logs recovery event to DB when app transitions from degraded to healthy', async () => {
    const app = await ownerPrisma.app.create({
      data: {
        name: `HealthEvt Recovery ${Date.now()}`,
        description: 'test',
        toolDefinitions: [],
        uiManifest: { url: 'https://test.app' },
        permissions: {},
        complianceMetadata: {},
        version: '1.0.0',
        reviewStatus: 'approved',
      },
    })

    // Make it degraded
    for (let i = 0; i < 3; i++) {
      await recordFailure(app.id)
    }
    expect(getHealthStatus(app.id).status).toBe('degraded')

    // Recover it
    await recordSuccess(app.id, 50)

    // Check DB for recovery event
    const events = await ownerPrisma.appHealthEvent.findMany({
      where: { appId: app.id, eventType: 'recovered' },
    })
    expect(events.length).toBeGreaterThanOrEqual(1)

    // Cleanup
    await ownerPrisma.appHealthEvent.deleteMany({ where: { appId: app.id } })
    await ownerPrisma.app.delete({ where: { id: app.id } })
  })
})

// =============================================================================
// Unit tests: Health URL polling
// =============================================================================

describe('Health URL Polling', () => {
  beforeEach(() => {
    _resetHealthStore()
    stopHealthPolling()
  })

  afterAll(async () => {
    stopHealthPolling()
    // Clean up any orphaned HealthPoll* apps from prior runs
    const staleApps = await ownerPrisma.app.findMany({
      where: { name: { startsWith: 'HealthPoll' } },
      select: { id: true },
    })
    if (staleApps.length > 0) {
      const ids = staleApps.map(a => a.id)
      await ownerPrisma.appHealthEvent.deleteMany({ where: { appId: { in: ids } } })
      await ownerPrisma.app.deleteMany({ where: { id: { in: ids } } })
    }
  })

  it('polling detects unresponsive app via healthUrl', async () => {
    // Create app with healthUrl that will fail
    const app = await ownerPrisma.app.create({
      data: {
        name: `HealthPoll ${Date.now()}`,
        description: 'test',
        toolDefinitions: [],
        uiManifest: { url: 'https://test.app' },
        permissions: {},
        complianceMetadata: {},
        version: '1.0.0',
        reviewStatus: 'approved',
        healthUrl: 'http://localhost:99999/health', // unreachable
      },
    })

    // Start polling with very short interval
    startHealthPolling(100)

    // Wait for a few poll cycles
    await new Promise(resolve => setTimeout(resolve, 600))

    stopHealthPolling()

    const status = getHealthStatus(app.id)
    // After multiple failed polls, should be degraded or unresponsive
    expect(status.consecutiveFailures).toBeGreaterThanOrEqual(3)
    expect(['degraded', 'unresponsive']).toContain(status.status)

    // Cleanup
    await ownerPrisma.appHealthEvent.deleteMany({ where: { appId: app.id } })
    await ownerPrisma.app.delete({ where: { id: app.id } })
  })

  it('polling recovers degraded app when healthUrl responds OK', async () => {
    // Spin up a tiny HTTP server that always returns 200 for polling to hit
    const http = await import('node:http')
    const pollingServer = http.createServer((_req, res) => { res.writeHead(200); res.end('OK') })
    await new Promise<void>(resolve => pollingServer.listen(0, resolve))
    const pollingPort = (pollingServer.address() as { port: number }).port

    const app = await ownerPrisma.app.create({
      data: {
        name: `HealthPollRecover ${Date.now()}`,
        description: 'test',
        toolDefinitions: [],
        uiManifest: { url: 'https://test.app' },
        permissions: {},
        complianceMetadata: {},
        version: '1.0.0',
        reviewStatus: 'approved',
        healthUrl: `http://127.0.0.1:${pollingPort}/health`,
      },
    })

    // Pre-degrade the app
    for (let i = 0; i < 3; i++) {
      await recordFailure(app.id)
    }
    expect(getHealthStatus(app.id).status).toBe('degraded')

    // Start polling — the tiny server responds 200
    startHealthPolling(100)
    await new Promise(resolve => setTimeout(resolve, 1500))
    stopHealthPolling()

    // After successful polls, should recover
    const status = getHealthStatus(app.id)
    expect(status.status).toBe('healthy')

    // Cleanup
    pollingServer.close()
    await ownerPrisma.appHealthEvent.deleteMany({ where: { appId: app.id } })
    await ownerPrisma.app.delete({ where: { id: app.id } })
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
        joinCode: `HLTH${Date.now().toString(36).slice(-4).toUpperCase()}`, gradeBand: 'g68', aiConfig: { mode: 'direct' },
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
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM app_health_events WHERE app_id IN (SELECT id FROM apps WHERE developer_id IS NULL)`)
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
    for (let i = 0; i < 5; i++) await recordFailure(appId)
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

  it('recovery via recordSuccess allows invocation after degradation', async () => {
    const appId = await registerAndApproveApp(teacherToken)

    // Simulate 4 failures (degraded but not unresponsive)
    for (let i = 0; i < 4; i++) await recordFailure(appId)
    expect(getHealthStatus(appId).status).toBe('degraded')

    // Degraded app is blocked
    const blockedRes = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/tools/start_game/invoke`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { parameters: {}, conversationId },
    })
    expect(blockedRes.statusCode).toBe(503)

    // Recovery via health polling (simulated by recordSuccess)
    await recordSuccess(appId, 30)
    expect(getHealthStatus(appId).status).toBe('healthy')
    expect(getHealthStatus(appId).consecutiveFailures).toBe(0)

    // Now invocation should succeed
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/tools/start_game/invoke`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { parameters: {}, conversationId },
    })
    expect(res.statusCode).toBe(200)
  })

  it('degraded app (3 failures) returns 503 on invocation', async () => {
    const appId = await registerAndApproveApp(teacherToken)

    // Simulate 3 consecutive failures to make app degraded
    for (let i = 0; i < 3; i++) await recordFailure(appId)
    expect(getHealthStatus(appId).status).toBe('degraded')

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/tools/start_game/invoke`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { parameters: {}, conversationId },
    })

    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body)
    expect(body.error).toMatch(/degraded|unresponsive/)
  })

  it('rate limit violation logs health event to DB', async () => {
    const appId = await registerAndApproveApp(teacherToken)

    // Exhaust rate limit
    for (let i = 0; i < 100; i++) {
      checkRateLimit(appId)
    }

    // The 101st invocation should be rate-limited and log a health event
    await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/tools/start_game/invoke`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { parameters: {}, conversationId },
    })

    // Wait for the fire-and-forget DB write to complete
    await new Promise(resolve => setTimeout(resolve, 200))

    // Check DB for rate_limit_exceeded event
    const events = await ownerPrisma.appHealthEvent.findMany({
      where: { appId, eventType: 'rate_limit_exceeded' },
    })
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0].eventType).toBe('rate_limit_exceeded')
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
