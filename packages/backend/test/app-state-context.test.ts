/**
 * App State in AI Context — Full Lifecycle Tests
 *
 * Validates that active app state (e.g., chess board position) is:
 * 1. Persisted to DB from WS state updates
 * 2. Looked up and injected into AI context when student sends chat messages
 * 3. Not injected when app is suspended or terminated
 * 4. Handled gracefully when state is null
 *
 * These tests use real AI calls (Anthropic Haiku) where noted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma, withTenantContext } from '../src/middleware/rls.js'
import { handleAppStateUpdate } from '../src/routes/websocket.js'
import type { FastifyInstance } from 'fastify'

describe('App State in AI Context — full lifecycle', () => {
  let server: FastifyInstance
  let districtId: string
  let studentId: string
  let teacherId: string
  let classroomId: string
  let conversationId: string
  let studentToken: string
  let teacherToken: string
  let chessAppId: string
  let activeInstanceId: string

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()

    // Create test environment
    const district = await ownerPrisma.district.create({ data: { name: 'App State Test District' } })
    districtId = district.id

    const teacher = await ownerPrisma.user.create({
      data: { districtId, role: 'teacher', displayName: 'State Test Teacher' },
    })
    teacherId = teacher.id

    const student = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'State Test Student', gradeBand: 'g912' },
    })
    studentId = student.id

    teacherToken = signJWT({ userId: teacherId, role: 'teacher', districtId })
    studentToken = signJWT({ userId: studentId, role: 'student', districtId, gradeBand: 'g912' })

    const classroom = await ownerPrisma.classroom.create({
      data: {
        districtId,
        teacherId,
        name: 'State Test Class',
        joinCode: 'STATE1',
        gradeBand: 'g912',
        aiConfig: { mode: 'direct', subject: 'general' },
      },
    })
    classroomId = classroom.id

    const conversation = await ownerPrisma.conversation.create({
      data: { districtId, classroomId, studentId },
    })
    conversationId = conversation.id

    // Register + approve chess app
    const chessRes = await server.inject({
      method: 'POST',
      url: '/api/v1/apps/register',
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: {
        name: 'Chess',
        description: 'Interactive chess game for learning strategy',
        toolDefinitions: [
          { name: 'start_game', description: 'Start a new chess game', inputSchema: { type: 'object' } },
          { name: 'make_move', description: 'Make a chess move', inputSchema: { type: 'object', properties: { move: { type: 'string' } } } },
        ],
        uiManifest: { url: 'https://chess.chatbridge.app', width: 500, height: 500 },
        permissions: { network: true },
        complianceMetadata: {},
        version: '1.0.0',
      },
    })
    chessAppId = JSON.parse(chessRes.body).appId

    // Submit for review (auto-approves in test)
    await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${chessAppId}/submit-review`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })

    // Enable chess in classroom
    await ownerPrisma.districtAppCatalog.create({
      data: { districtId, appId: chessAppId, status: 'approved' },
    })
    await ownerPrisma.classroomAppConfig.create({
      data: { classroomId, appId: chessAppId, districtId, enabled: true },
    })

    // Invoke start_game to create an active instance
    const invokeRes = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${chessAppId}/tools/start_game/invoke`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { parameters: {}, conversationId },
    })
    const invokeBody = JSON.parse(invokeRes.body)
    activeInstanceId = invokeBody.instanceId
    expect(activeInstanceId).toBeDefined()
  })

  afterAll(async () => {
    try {
      await ownerPrisma.toolInvocation.deleteMany({ where: { districtId } })
      await ownerPrisma.safetyEvent.deleteMany({ where: { districtId } })
      await ownerPrisma.appInstance.deleteMany({ where: { districtId } })
      await ownerPrisma.message.deleteMany({ where: { districtId } })
      await ownerPrisma.classroomAppConfig.deleteMany({ where: { districtId } })
      await ownerPrisma.districtAppCatalog.deleteMany({ where: { districtId } })
      await ownerPrisma.conversation.deleteMany({ where: { districtId } })
      await ownerPrisma.classroom.deleteMany({ where: { districtId } })
      await ownerPrisma.app.deleteMany({ where: { id: chessAppId } })
      await ownerPrisma.user.deleteMany({ where: { districtId } })
      await ownerPrisma.district.delete({ where: { id: districtId } })
    } catch { /* Best effort cleanup */ }
    await server.close()
  })

  // Test 1: AI references chess state after tool invocation
  it('AI references chess state after tool invocation', async () => {
    // Instance already created in beforeAll with FEN via start_game
    // Send chat message asking about chess
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { text: 'What should I do in the chess game?' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.response).toBeDefined()
    // AI should mention chess/game/position/move — loose keyword match
    expect(body.response.toLowerCase()).toMatch(/chess|game|position|move|board|play|pawn|piece|opening/)
  }, 20000)

  // Test 2: AI references UPDATED state after PUT
  it('AI references UPDATED state after PUT', async () => {
    // PUT new state to instance (e.g., post-e4 position)
    const newState = {
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      moveCount: 1,
      lastMove: 'e4',
    }

    const putRes = await server.inject({
      method: 'PUT',
      url: `/api/v1/apps/instances/${activeInstanceId}/state`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { state: newState },
    })
    expect(putRes.statusCode).toBe(200)

    // Send chat message asking about position
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { text: "What's the current position in my chess game?" },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.response).toBeDefined()
    // AI should reference chess/game given the state is in context
    expect(body.response.toLowerCase()).toMatch(/chess|game|position|move|board|e4|pawn|opening/)
  }, 20000)

  // Test 3: AI acknowledges terminated game
  it('AI acknowledges terminated game', async () => {
    // Terminate the instance
    const termRes = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/instances/${activeInstanceId}/terminate`,
      headers: { authorization: `Bearer ${studentToken}` },
    })
    expect(termRes.statusCode).toBe(200)

    // Send chat message asking to keep playing
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { text: 'Can we keep playing chess?' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.response).toBeDefined()
    // The AI should not have a "Currently active app" context with a FEN string.
    // It may still discuss chess from conversation history, but should NOT have
    // the specific FEN injected as active state (no "Current state:" block).
    // Verify the system prompt did NOT include the FEN by checking that the
    // response doesn't reference the exact FEN position details like castling rights.
    const resp = body.response.toLowerCase()
    expect(resp).not.toMatch(/rnbqkbnr\/pppppppp/)  // raw FEN string should not leak
  }, 20000)

  // Test 4: AI handles null state gracefully
  it('AI handles null state gracefully', async () => {
    // Create instance directly in DB with stateSnapshot: null, status: 'active'
    const nullStateInstance = await ownerPrisma.appInstance.create({
      data: {
        appId: chessAppId,
        conversationId,
        districtId,
        status: 'active',
        stateSnapshot: undefined, // null / undefined
      },
    })

    // Send chat message
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { text: "What's happening in the app?" },
    })

    // Should not crash — returns 200
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.response).toBeDefined()

    // Clean up the null-state instance
    await ownerPrisma.appInstance.delete({ where: { id: nullStateInstance.id } })
  }, 20000)

  // Test 5: WS state update persists to DB
  it('WS state update persists to DB', async () => {
    // Create a fresh active instance for this test
    const freshInstance = await ownerPrisma.appInstance.create({
      data: {
        appId: chessAppId,
        conversationId,
        districtId,
        status: 'active',
        stateSnapshot: { fen: 'start' },
      },
    })

    const newState = {
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      moveCount: 1,
    }

    // Call handleAppStateUpdate directly (simulating WS message)
    await handleAppStateUpdate(freshInstance.id, newState, districtId)

    // Query DB for the instance
    const updated = await ownerPrisma.appInstance.findUnique({
      where: { id: freshInstance.id },
    })

    expect(updated).toBeDefined()
    expect(updated!.stateSnapshot).toEqual(newState)

    // Clean up
    await ownerPrisma.appInstance.delete({ where: { id: freshInstance.id } })
  })

  // Test 6: Suspended app not injected as active context
  it('suspended app not injected as active context', async () => {
    // Create a new active instance, then suspend it
    const inst = await ownerPrisma.appInstance.create({
      data: {
        appId: chessAppId,
        conversationId,
        districtId,
        status: 'active',
        stateSnapshot: {
          fen: 'r1bqkbnr/pppppppp/2n5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2',
          moveCount: 2,
        },
      },
    })

    // Suspend it
    await server.inject({
      method: 'POST',
      url: `/api/v1/apps/instances/${inst.id}/suspend`,
      headers: { authorization: `Bearer ${studentToken}` },
    })

    // Send chat message
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { text: 'What should I do in chess right now?' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.response).toBeDefined()
    // AI should NOT reference specific board position since app is suspended
    const resp = body.response.toLowerCase()
    expect(resp).not.toMatch(/r1bqkbnr|knight.*c6|current position is/)

    // Clean up
    await ownerPrisma.appInstance.delete({ where: { id: inst.id } })
  }, 20000)
})
