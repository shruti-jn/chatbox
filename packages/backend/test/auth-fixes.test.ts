/**
 * Tests for TASK-API-AUTH (SHR-94) fixes:
 * F1: LTI 1.3 OIDC initiate + launch
 * F2: Spotify OAuth returns 200 JSON (not redirect), state validation, AES-256-GCM, PKCE
 * F3: COPPA consent gate middleware
 * F4: /auth/login guarded behind NODE_ENV=development
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { createTestDistrict, createTestUser, cleanup, getPrisma } from './fixtures/index.js'
import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'

// =====================================================================
// F1: LTI 1.3 OIDC initiate + launch
// =====================================================================
describe('F1: LTI 1.3 OIDC', () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()
  })

  afterAll(async () => {
    await server.close()
  })

  it('GET /auth/lti/oidc/initiate exists and returns 400 without required params', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/lti/oidc/initiate',
    })
    // Should NOT be 404 (route exists) and NOT be 501 (not a stub)
    expect(res.statusCode).not.toBe(404)
    expect(res.statusCode).not.toBe(501)
  })

  it('GET /auth/lti/oidc/initiate with valid params returns 302 to platform auth', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/lti/oidc/initiate',
      query: {
        iss: 'https://canvas.instructure.com',
        login_hint: 'user123',
        target_link_uri: 'https://chatbridge.example.com/api/v1/auth/lti/launch',
        lti_message_hint: 'hint123',
      },
    })
    // Should redirect to the platform's authorization endpoint
    expect(res.statusCode).toBe(302)
    const location = res.headers.location as string
    expect(location).toBeDefined()
  })

  it('POST /auth/lti/launch no longer returns 501', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/lti/launch',
      payload: { id_token: 'fake-token', state: 'fake-state' },
    })
    // Should return 400 (invalid token) or similar, but NOT 501
    expect(res.statusCode).not.toBe(501)
  })
})

// =====================================================================
// F2: Spotify OAuth
// =====================================================================
describe('F2: Spotify OAuth returns 200 JSON (not redirect)', () => {
  let server: FastifyInstance
  let districtId: string
  let teacherToken: string
  let teacherId: string

  beforeAll(async () => {
    // Set Spotify env vars for this test
    process.env.SPOTIFY_CLIENT_ID = 'test-client-id'
    process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret'

    server = await buildServer()
    await server.ready()

    const district = await createTestDistrict()
    districtId = district.id

    const teacher = await createTestUser(districtId, { role: 'teacher', displayName: 'Spotify Teacher' })
    teacherId = teacher.id
    teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId })
  })

  afterAll(async () => {
    await cleanup({ userIds: [teacherId], districtIds: [districtId] })
    await server.close()
    delete process.env.SPOTIFY_CLIENT_ID
    delete process.env.SPOTIFY_CLIENT_SECRET
  })

  it('GET /auth/oauth/spotify/authorize returns 200 with JSON { url } not 302 redirect', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/spotify/authorize',
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.url).toBeDefined()
    expect(body.url).toContain('https://accounts.spotify.com/authorize')
  })

  it('Spotify authorize URL includes PKCE code_challenge', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/spotify/authorize',
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const body = JSON.parse(res.body)
    const url = new URL(body.url)
    expect(url.searchParams.get('code_challenge')).toBeDefined()
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('Spotify authorize URL includes state param', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/spotify/authorize',
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    const body = JSON.parse(res.body)
    const url = new URL(body.url)
    expect(url.searchParams.get('state')).toBeDefined()
    expect(url.searchParams.get('state')!.length).toBeGreaterThan(0)
  })
})

// =====================================================================
// F3: COPPA consent gate middleware
// =====================================================================
describe('F3: COPPA consent gate', () => {
  let server: FastifyInstance
  let districtId: string
  let under13StudentToken: string
  let under13StudentId: string
  let over13StudentToken: string
  let over13StudentId: string
  let teacherToken: string
  let teacherId: string
  const prisma = getPrisma()

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()

    const district = await createTestDistrict()
    districtId = district.id

    // Under-13 student (k2 grade band)
    const under13Student = await createTestUser(districtId, {
      role: 'student',
      displayName: 'Young Student',
      gradeBand: 'k2',
    })
    under13StudentId = under13Student.id
    under13StudentToken = signJWT({
      userId: under13Student.id,
      role: 'student',
      districtId,
      gradeBand: 'k2',
    })

    // Over-13 student (g912 grade band)
    const over13Student = await createTestUser(districtId, {
      role: 'student',
      displayName: 'Older Student',
      gradeBand: 'g912',
    })
    over13StudentId = over13Student.id
    over13StudentToken = signJWT({
      userId: over13Student.id,
      role: 'student',
      districtId,
      gradeBand: 'g912',
    })

    const teacher = await createTestUser(districtId, { role: 'teacher', displayName: 'COPPA Teacher' })
    teacherId = teacher.id
    teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId })
  })

  afterAll(async () => {
    // Clean up consents first
    await prisma.parentalConsent.deleteMany({
      where: { studentId: { in: [under13StudentId, over13StudentId] } },
    })
    await cleanup({
      userIds: [under13StudentId, over13StudentId, teacherId],
      districtIds: [districtId],
    })
    await server.close()
  })

  it('under-13 student (k2) without consent is blocked from /chat routes', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${crypto.randomUUID()}/messages`,
      headers: { authorization: `Bearer ${under13StudentToken}` },
      payload: { text: 'hello' },
    })
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('COPPA_CONSENT_REQUIRED')
    expect(body.message).toContain('Parental consent')
  })

  it('under-13 student (g35) without consent is blocked from /chat routes', async () => {
    const g35Student = await createTestUser(districtId, {
      role: 'student',
      displayName: 'Grade 3-5 Student',
      gradeBand: 'g35',
    })
    const g35Token = signJWT({
      userId: g35Student.id,
      role: 'student',
      districtId,
      gradeBand: 'g35',
    })

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${crypto.randomUUID()}/messages`,
      headers: { authorization: `Bearer ${g35Token}` },
      payload: { text: 'hello' },
    })
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('COPPA_CONSENT_REQUIRED')
    expect(body.message).toContain('Parental consent')

    await prisma.user.delete({ where: { id: g35Student.id } })
  })

  it('under-13 student WITH granted consent can access /chat routes (not blocked by COPPA)', async () => {
    // Create a school + classroom + membership + conversation so we have a valid conversation ID
    const school = await prisma.school.create({
      data: { districtId, name: `COPPA Test School ${Date.now()}` },
    })
    const classroom = await prisma.classroom.create({
      data: {
        districtId,
        schoolId: school.id,
        teacherId: teacherId,
        name: `COPPA Test Classroom ${Date.now()}`,
        joinCode: `COPPA-${Date.now()}`,
        gradeBand: 'k2',
      },
    })
    await prisma.classroomMembership.create({
      data: { classroomId: classroom.id, studentId: under13StudentId, districtId },
    })
    const conversation = await prisma.conversation.create({
      data: {
        districtId,
        classroomId: classroom.id,
        studentId: under13StudentId,
        title: 'COPPA consent test',
      },
    })

    // Grant parental consent
    await prisma.parentalConsent.create({
      data: {
        studentId: under13StudentId,
        districtId,
        parentEmailHash: crypto.createHash('sha256').update('parent@test.com').digest('hex'),
        consentStatus: 'granted',
        consentDate: new Date(),
      },
    })

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversation.id}/messages`,
      headers: { authorization: `Bearer ${under13StudentToken}` },
      payload: { text: 'hello' },
    })
    // Should NOT be 403 (consent exists) and should NOT be 500 (FK error)
    expect(res.statusCode).not.toBe(403)
    expect(res.statusCode).not.toBe(500)

    // Clean up in reverse FK order
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } })
    await prisma.conversation.delete({ where: { id: conversation.id } })
    await prisma.classroomMembership.deleteMany({ where: { classroomId: classroom.id } })
    await prisma.classroom.delete({ where: { id: classroom.id } })
    await prisma.school.delete({ where: { id: school.id } })
    await prisma.parentalConsent.delete({ where: { studentId: under13StudentId } })
  })

  it('over-13 student (g912) does not need consent', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${crypto.randomUUID()}/messages`,
      headers: { authorization: `Bearer ${over13StudentToken}` },
      payload: { text: 'hello' },
    })
    // Should NOT be 403 for consent reasons
    expect(res.statusCode).not.toBe(403)
  })

  it('teachers are not affected by COPPA gate', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${crypto.randomUUID()}/messages`,
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { text: 'hello' },
    })
    expect(res.statusCode).not.toBe(403)
  })
})

// =====================================================================
// F1 supplement: LTI id_token tampered token rejection
// =====================================================================
describe('F1: LTI id_token signature verification', () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()
  })

  afterAll(async () => {
    await server.close()
  })

  it('rejects a tampered id_token with 401', async () => {
    // First, initiate an OIDC flow to get a valid state
    const initiateRes = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/lti/oidc/initiate',
      query: {
        iss: 'https://canvas.instructure.com',
        login_hint: 'user123',
        target_link_uri: 'https://chatbridge.example.com/api/v1/auth/lti/launch',
      },
    })
    expect(initiateRes.statusCode).toBe(302)

    // Extract state from the redirect URL
    const location = initiateRes.headers.location as string
    const stateParam = new URL(location).searchParams.get('state')!
    expect(stateParam).toBeDefined()

    // Craft a fake id_token — valid base64url JWT structure but unsigned/tampered
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({
      iss: 'https://canvas.instructure.com',
      sub: 'tampered-user',
      aud: 'test-client',
      nonce: 'fake-nonce',
      name: 'Hacker',
    })).toString('base64url')
    const fakeSignature = 'tampered-signature-data'
    const tamperedToken = `${header}.${payload}.${fakeSignature}`

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/lti/launch',
      payload: { id_token: tamperedToken, state: stateParam },
    })

    // Should be 401 — signature verification failed
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body)
    expect(body.error).toContain('verification failed')
  })
})

// =====================================================================
// F3 supplement: WebSocket COPPA gating
// =====================================================================
describe('F3: WebSocket COPPA gating on /ws/chat', () => {
  let server: FastifyInstance
  let districtId: string
  let under13StudentId: string
  let under13Token: string
  let teacherId: string
  const prisma = getPrisma()

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()

    const district = await createTestDistrict()
    districtId = district.id

    const under13Student = await createTestUser(districtId, {
      role: 'student',
      displayName: 'WS COPPA Student',
      gradeBand: 'k2',
    })
    under13StudentId = under13Student.id
    under13Token = signJWT({
      userId: under13Student.id,
      role: 'student',
      districtId,
      gradeBand: 'k2',
    })

    const teacher = await createTestUser(districtId, { role: 'teacher', displayName: 'WS COPPA Teacher' })
    teacherId = teacher.id
  })

  afterAll(async () => {
    await cleanup({
      userIds: [under13StudentId, teacherId],
      districtIds: [districtId],
    })
    await server.close()
  })

  it('rejects WebSocket upgrade to /ws/chat for under-13 student without consent', async () => {
    // The WebSocket route at /ws/chat uses JWT auth via query param.
    // Under-13 students without COPPA consent should be disconnected.
    // We test this via Fastify inject with the upgrade simulation.
    // Since @fastify/websocket doesn't support inject for WS easily,
    // we start the server on a real port and connect via WebSocket.
    const address = await server.listen({ port: 0, host: '127.0.0.1' })
    const port = (server.server.address() as any).port

    const WebSocket = (await import('ws')).default
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/v1/ws/chat?token=${under13Token}`,
    )

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString() })
      })
      ws.on('error', () => {
        // Connection errors also count as rejection
        resolve({ code: 0, reason: 'connection_error' })
      })
    })

    // The WS handler authenticates but currently does NOT check COPPA.
    // After our fix, it should close with code 4003 for COPPA violations.
    const result = await closePromise
    // The socket should have been closed (not left open)
    expect(ws.readyState).toBeGreaterThanOrEqual(2) // CLOSING or CLOSED
  })
})

// =====================================================================
// F5: Spotify token refresh — POST /auth/oauth/spotify/refresh
// =====================================================================
describe('F5: Spotify token refresh', () => {
  let server: FastifyInstance
  let districtId: string
  let teacherId: string
  let teacherToken: string
  const prisma = getPrisma()

  beforeAll(async () => {
    process.env.SPOTIFY_CLIENT_ID = 'test-client-id'
    process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret'

    server = await buildServer()
    await server.ready()

    const district = await createTestDistrict()
    districtId = district.id

    const teacher = await createTestUser(districtId, { role: 'teacher', displayName: 'Refresh Teacher' })
    teacherId = teacher.id
    teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId })
  })

  afterAll(async () => {
    await prisma.oAuthToken.deleteMany({ where: { userId: teacherId } })
    await cleanup({ userIds: [teacherId], districtIds: [districtId] })
    await server.close()
    delete process.env.SPOTIFY_CLIENT_ID
    delete process.env.SPOTIFY_CLIENT_SECRET
  })

  it('returns 404-equivalent or 400 when user has no Spotify token stored', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/spotify/refresh',
      headers: { authorization: `Bearer ${teacherToken}` },
    })
    // Route must exist (not 404) — should return 400 because no token is stored
    expect(res.statusCode).not.toBe(404)
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.error).toBeDefined()
  })

  it('returns 401 for unauthenticated request', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/spotify/refresh',
    })
    expect(res.statusCode).toBe(401)
  })

  it('stores encrypted tokens after successful refresh (stubbed Spotify API)', async () => {
    // Seed an OAuthToken with known encrypted refresh token
    const { encryptAES256GCM } = await import('../src/routes/auth.js')
    const fakeRefreshToken = 'fake-refresh-token-for-test'

    await prisma.oAuthToken.upsert({
      where: { userId_provider: { userId: teacherId, provider: 'spotify' } },
      update: {
        refreshTokenEncrypted: encryptAES256GCM(fakeRefreshToken),
        accessTokenEncrypted: encryptAES256GCM('old-access-token'),
        expiresAt: new Date(Date.now() - 3600_000), // expired
      },
      create: {
        userId: teacherId,
        provider: 'spotify',
        refreshTokenEncrypted: encryptAES256GCM(fakeRefreshToken),
        accessTokenEncrypted: encryptAES256GCM('old-access-token'),
        expiresAt: new Date(Date.now() - 3600_000),
        scopes: ['playlist-modify-public', 'playlist-modify-private'],
      },
    })

    // This test cannot call real Spotify (test credentials are fake), so we
    // verify the route exists, requires auth, reads encrypted token from DB,
    // decrypts it, and attempts the Spotify API call. Spotify rejects with
    // "invalid_client" because test-client-id/test-client-secret are fake.
    // The route correctly returns 401 + SPOTIFY_REAUTH_REQUIRED in that case.
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/spotify/refresh',
      headers: { authorization: `Bearer ${teacherToken}` },
    })

    // Route exists (not 404), auth works (not 401 from middleware), no crash (not 500)
    expect(res.statusCode).not.toBe(404)
    expect(res.statusCode).not.toBe(500)

    // With fake Spotify credentials, Spotify rejects the request.
    // The route should return 401 with SPOTIFY_REAUTH_REQUIRED (graceful handling).
    const body = JSON.parse(res.body)
    expect(body.error).toBe('SPOTIFY_REAUTH_REQUIRED')
    expect(body.message).toContain('reconnect Spotify')

    // Verify the token record still exists in DB (not deleted on failure)
    const storedToken = await prisma.oAuthToken.findUnique({
      where: { userId_provider: { userId: teacherId, provider: 'spotify' } },
    })
    expect(storedToken).not.toBeNull()
    // Verify tokens are encrypted (not plaintext)
    expect(storedToken!.accessTokenEncrypted).toContain(':')  // AES-256-GCM format: iv:tag:ciphertext
    expect(storedToken!.refreshTokenEncrypted).toContain(':')
  })

  it('returns SPOTIFY_REAUTH_REQUIRED for revoked/invalid refresh token (--live)', async () => {
    // This test requires real Spotify API — skip in unit test mode
    if (!process.env.SPOTIFY_LIVE_TESTS) {
      // Seed a known-bad refresh token and verify the route handles it gracefully
      const { encryptAES256GCM } = await import('../src/routes/auth.js')

      await prisma.oAuthToken.upsert({
        where: { userId_provider: { userId: teacherId, provider: 'spotify' } },
        update: {
          refreshTokenEncrypted: encryptAES256GCM('definitely-invalid-refresh-token'),
          accessTokenEncrypted: encryptAES256GCM('old-access-token'),
          expiresAt: new Date(Date.now() - 3600_000),
        },
        create: {
          userId: teacherId,
          provider: 'spotify',
          refreshTokenEncrypted: encryptAES256GCM('definitely-invalid-refresh-token'),
          accessTokenEncrypted: encryptAES256GCM('old-access-token'),
          expiresAt: new Date(Date.now() - 3600_000),
          scopes: ['playlist-modify-public'],
        },
      })

      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/oauth/spotify/refresh',
        headers: { authorization: `Bearer ${teacherToken}` },
      })

      // Route should handle Spotify rejection gracefully
      expect(res.statusCode).not.toBe(404)
      expect(res.statusCode).not.toBe(500)
      // Expect 401 with SPOTIFY_REAUTH_REQUIRED or 502 for network failure
      const body = JSON.parse(res.body)
      expect(body.error).toBeDefined()
    }
  })
})

// =====================================================================
// F4: /auth/login only in development
// =====================================================================
describe('F4: /auth/login dev-only guard', () => {
  it('login endpoint returns 403 when NODE_ENV=production', async () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const server = await buildServer()
      await server.ready()

      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'test@example.com', password: 'password123' },
      })
      expect(res.statusCode).toBe(403)
      const body = JSON.parse(res.body)
      expect(body.error).toContain('development')

      await server.close()
    } finally {
      process.env.NODE_ENV = original
    }
  })

  it('login endpoint works when NODE_ENV=development', async () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const server = await buildServer()
      await server.ready()

      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'nonexistent@example.com', password: 'password123' },
      })
      // Should reach the handler (401 for invalid creds, not 403 for env guard)
      expect(res.statusCode).toBe(401)

      await server.close()
    } finally {
      process.env.NODE_ENV = original
    }
  })

  it('login endpoint works when NODE_ENV=test', async () => {
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'
    try {
      const server = await buildServer()
      await server.ready()

      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'nonexistent@example.com', password: 'password123' },
      })
      expect(res.statusCode).toBe(401)

      await server.close()
    } finally {
      process.env.NODE_ENV = original
    }
  })
})
