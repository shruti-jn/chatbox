import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  transition,
  canTransition,
  isTerminal,
  TRANSITIONS,
  InvalidTransitionError,
  type AppState,
} from '../src/apps/index.js'
import { buildServer } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma } from '../src/middleware/rls.js'
import type { FastifyInstance } from 'fastify'

// =============================================================================
// Unit tests: FSM logic
// =============================================================================

describe('App Lifecycle FSM — unit tests', () => {
  it('loading -> active via activate', () => {
    expect(transition('loading', 'activate')).toBe('active')
  })

  it('active -> suspended via suspend', () => {
    expect(transition('active', 'suspend')).toBe('suspended')
  })

  it('suspended -> active via resume', () => {
    expect(transition('suspended', 'resume')).toBe('active')
  })

  it('active -> collapsed via complete', () => {
    expect(transition('active', 'complete')).toBe('collapsed')
  })

  it('collapsed -> active via expand', () => {
    expect(transition('collapsed', 'expand')).toBe('active')
  })

  it('invalid: loading -> suspended (should throw)', () => {
    expect(() => transition('loading', 'suspend')).toThrow(InvalidTransitionError)
    expect(canTransition('loading', 'suspend')).toBe(false)
  })

  it('invalid: terminated -> active (terminal state, should throw)', () => {
    expect(() => transition('terminated', 'activate')).toThrow(InvalidTransitionError)
    expect(canTransition('terminated', 'activate')).toBe(false)
  })

  it('error reachable from loading, active, and suspended', () => {
    expect(transition('loading', 'fail')).toBe('error')
    expect(transition('active', 'fail')).toBe('error')
    expect(transition('suspended', 'fail')).toBe('error')
  })

  it('error -> loading via retry', () => {
    expect(transition('error', 'retry')).toBe('loading')
  })

  it('error -> terminated via terminate', () => {
    expect(transition('error', 'terminate')).toBe('terminated')
  })

  it('isTerminal returns true only for terminated', () => {
    expect(isTerminal('terminated')).toBe(true)
    expect(isTerminal('error')).toBe(false)
    expect(isTerminal('loading')).toBe(false)
    expect(isTerminal('active')).toBe(false)
    expect(isTerminal('suspended')).toBe(false)
    expect(isTerminal('collapsed')).toBe(false)
  })

  it('canTransition returns correct booleans', () => {
    expect(canTransition('active', 'suspend')).toBe(true)
    expect(canTransition('active', 'resume')).toBe(false)
    expect(canTransition('collapsed', 'expand')).toBe(true)
    expect(canTransition('collapsed', 'suspend')).toBe(false)
  })

  it('TRANSITIONS table covers all 6 states', () => {
    const expectedStates: AppState[] = ['loading', 'active', 'suspended', 'collapsed', 'terminated', 'error']
    expect(Object.keys(TRANSITIONS).sort()).toEqual(expectedStates.sort())
  })
})

// =============================================================================
// Integration tests: FSM wired into routes
// =============================================================================

const validAppPayload = {
  name: 'Lifecycle Test App',
  description: 'App for lifecycle FSM testing',
  toolDefinitions: [{ name: 'start_game', description: 'Start a game', inputSchema: { type: 'object' } }],
  uiManifest: { url: 'https://test.chatbridge.app', width: 500, height: 500 },
  permissions: { network: true },
  complianceMetadata: {},
  version: '1.0.0',
}

describe('App Lifecycle FSM — integration via routes', () => {
  let server: FastifyInstance
  let districtId: string
  let teacherToken: string
  let studentToken: string
  let conversationId: string

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()

    const district = await ownerPrisma.district.create({ data: { name: 'Lifecycle Test District' } })
    districtId = district.id

    const teacher = await ownerPrisma.user.create({
      data: { districtId, role: 'teacher', displayName: 'LC Teacher' },
    })
    const student = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'LC Student', gradeBand: 'g68' },
    })

    teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId })
    studentToken = signJWT({ userId: student.id, role: 'student', districtId })

    const classroom = await ownerPrisma.classroom.create({
      data: {
        districtId, teacherId: teacher.id, name: 'LC Class',
        joinCode: 'LCTST1', gradeBand: 'g68', aiConfig: { mode: 'direct' },
      },
    })

    const conversation = await ownerPrisma.conversation.create({
      data: { districtId, classroomId: classroom.id, studentId: student.id },
    })
    conversationId = conversation.id
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
      payload: { ...validAppPayload, name: `LC App ${Date.now()}` },
    })
    const { appId } = JSON.parse(regRes.body)
    await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/submit-review`,
      headers: { authorization: `Bearer ${token}` },
    })
    return appId
  }

  async function invokeAndGetInstanceId(appId: string) {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${appId}/tools/start_game/invoke`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { parameters: {}, conversationId },
    })
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.body).instanceId as string
  }

  it('state snapshot persisted on transition after tool invocation', async () => {
    const appId = await registerAndApproveApp(teacherToken)
    const instanceId = await invokeAndGetInstanceId(appId)

    // Instance should be active with stateSnapshot set
    const getRes = await server.inject({
      method: 'GET',
      url: `/api/v1/apps/instances/${instanceId}/state`,
      headers: { authorization: `Bearer ${studentToken}` },
    })
    expect(getRes.statusCode).toBe(200)
    const body = JSON.parse(getRes.body)
    expect(body.status).toBe('active')
    expect(body.state).toBeDefined()
  })

  it('POST /apps/instances/:id/suspend transitions active -> suspended', async () => {
    const appId = await registerAndApproveApp(teacherToken)
    const instanceId = await invokeAndGetInstanceId(appId)

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/instances/${instanceId}/suspend`,
      headers: { authorization: `Bearer ${studentToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('suspended')
  })

  it('POST /apps/instances/:id/resume transitions suspended -> active', async () => {
    const appId = await registerAndApproveApp(teacherToken)
    const instanceId = await invokeAndGetInstanceId(appId)

    // Suspend first
    await server.inject({
      method: 'POST',
      url: `/api/v1/apps/instances/${instanceId}/suspend`,
      headers: { authorization: `Bearer ${studentToken}` },
    })

    // Resume
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/instances/${instanceId}/resume`,
      headers: { authorization: `Bearer ${studentToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('active')
  })

  it('POST /apps/instances/:id/terminate transitions active -> terminated', async () => {
    const appId = await registerAndApproveApp(teacherToken)
    const instanceId = await invokeAndGetInstanceId(appId)

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/instances/${instanceId}/terminate`,
      headers: { authorization: `Bearer ${studentToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('terminated')
  })

  it('invalid transition returns 409 (resume on active instance)', async () => {
    const appId = await registerAndApproveApp(teacherToken)
    const instanceId = await invokeAndGetInstanceId(appId)

    // Instance is active; resume is invalid from active
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/instances/${instanceId}/resume`,
      headers: { authorization: `Bearer ${studentToken}` },
    })
    expect(res.statusCode).toBe(409)
  })

  it('single-active constraint: new invocation suspends current active instance', async () => {
    const appId = await registerAndApproveApp(teacherToken)
    const instanceId1 = await invokeAndGetInstanceId(appId)

    // Create a second app and invoke it in the same conversation
    const appId2 = await registerAndApproveApp(teacherToken)
    const instanceId2 = await invokeAndGetInstanceId(appId2)

    // First instance should now be suspended
    const getRes = await server.inject({
      method: 'GET',
      url: `/api/v1/apps/instances/${instanceId1}/state`,
      headers: { authorization: `Bearer ${studentToken}` },
    })
    const body = JSON.parse(getRes.body)
    expect(body.status).toBe('suspended')

    // Second instance should be active
    const getRes2 = await server.inject({
      method: 'GET',
      url: `/api/v1/apps/instances/${instanceId2}/state`,
      headers: { authorization: `Bearer ${studentToken}` },
    })
    const body2 = JSON.parse(getRes2.body)
    expect(body2.status).toBe('active')
  })
})
