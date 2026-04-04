import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma } from '../src/middleware/rls.js'
import type { FastifyInstance } from 'fastify'

describe('Tool Manifest by Join Code', () => {
  let server: FastifyInstance
  let districtId: string
  let teacherId: string
  let teacherToken: string
  let studentToken: string
  let classroomId: string
  let joinCode: string
  let approvedAppId: string
  let pendingAppId: string
  let conversationId: string

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()

    const district = await ownerPrisma.district.create({ data: { name: 'ToolManifest Test District' } })
    districtId = district.id

    const teacher = await ownerPrisma.user.create({
      data: { districtId, role: 'teacher', displayName: 'Manifest Teacher' },
    })
    teacherId = teacher.id
    teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId })

    const student = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Manifest Student', gradeBand: 'g68' },
    })
    studentToken = signJWT({ userId: student.id, role: 'student', districtId })

    joinCode = `TM${Date.now().toString(36).slice(-6).toUpperCase()}`

    const classroom = await ownerPrisma.classroom.create({
      data: {
        districtId,
        teacherId: teacher.id,
        name: "Ms. Torres's Math",
        joinCode,
        gradeBand: 'g68',
        aiConfig: { mode: 'socratic' },
      },
    })
    classroomId = classroom.id

    // Create an approved app with tool definitions and uiManifest
    const approvedApp = await ownerPrisma.app.create({
      data: {
        name: `ManifestChess_${Date.now()}`,
        description: 'Interactive chess game',
        toolDefinitions: [
          { name: 'start_game', description: 'Start a new chess game', inputSchema: { type: 'object' } },
          { name: 'make_move', description: 'Make a chess move', inputSchema: { type: 'object', properties: { move: { type: 'string' } } } },
        ],
        uiManifest: { url: '/api/v1/apps/chess/ui/', height: 500, width: 600 },
        permissions: { camera: false },
        complianceMetadata: {},
        version: '1.0.0',
        reviewStatus: 'approved',
      },
    })
    approvedAppId = approvedApp.id

    // Create a pending_review app (should NOT appear in manifest)
    const pendingApp = await ownerPrisma.app.create({
      data: {
        name: `ManifestPending_${Date.now()}`,
        description: 'Pending app',
        toolDefinitions: [
          { name: 'do_thing', description: 'Does a thing', inputSchema: { type: 'object' } },
        ],
        uiManifest: { url: '/api/v1/apps/pending/ui/', height: 400 },
        permissions: {},
        complianceMetadata: {},
        version: '1.0.0',
        reviewStatus: 'pending_review',
      },
    })
    pendingAppId = pendingApp.id

    // Add approved app to district catalog
    await ownerPrisma.districtAppCatalog.create({
      data: { districtId, appId: approvedAppId, status: 'approved' },
    })
    // Add pending app to district catalog as approved (but app itself is pending_review)
    await ownerPrisma.districtAppCatalog.create({
      data: { districtId, appId: pendingAppId, status: 'approved' },
    })

    // Enable approved app for the classroom
    await ownerPrisma.classroomAppConfig.create({
      data: {
        classroomId,
        appId: approvedAppId,
        districtId,
        enabled: true,
        enabledBy: teacher.id,
      },
    })

    // Enable pending app for the classroom (should still be filtered out by reviewStatus)
    await ownerPrisma.classroomAppConfig.create({
      data: {
        classroomId,
        appId: pendingAppId,
        districtId,
        enabled: true,
        enabledBy: teacher.id,
      },
    })

    // Create conversation for __cbApp test
    const conversation = await ownerPrisma.conversation.create({
      data: { districtId, classroomId, studentId: student.id },
    })
    conversationId = conversation.id
  })

  afterAll(async () => {
    try {
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM tool_invocations WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM app_instances WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM classroom_app_configs WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM district_app_catalog WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM messages WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM conversations WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM classrooms WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM apps WHERE id IN ('${approvedAppId}', '${pendingAppId}')`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM users WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = '${districtId}'`)
    } catch { /* Best effort */ }
    await server.close()
  })

  // === Step 1: GET /classrooms/by-join-code/:joinCode/tool-manifest ===

  it('returns tool manifest with flattened tools for valid join code', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/classrooms/by-join-code/${joinCode}/tool-manifest`,
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)

    expect(body.classroomId).toBe(classroomId)
    expect(body.classroomName).toBe("Ms. Torres's Math")
    expect(body.tools).toBeDefined()
    expect(Array.isArray(body.tools)).toBe(true)

    // Should have 2 tools from the approved app (start_game, make_move)
    expect(body.tools.length).toBe(2)

    // Check flattened tool shape
    const startGame = body.tools.find((t: any) => t.toolName === 'start_game')
    expect(startGame).toBeDefined()
    expect(startGame.appId).toBe(approvedAppId)
    expect(startGame.appName).toContain('ManifestChess')
    expect(startGame.description).toBe('Start a new chess game')
    expect(startGame.parameters).toEqual({ type: 'object' })
    expect(startGame.uiManifest).toBeDefined()
    expect(startGame.uiManifest.url).toBe('/api/v1/apps/chess/ui/')
    expect(startGame.uiManifest.height).toBe(500)

    const makeMove = body.tools.find((t: any) => t.toolName === 'make_move')
    expect(makeMove).toBeDefined()
    expect(makeMove.appId).toBe(approvedAppId)
  })

  it('excludes tools from non-approved apps', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/classrooms/by-join-code/${joinCode}/tool-manifest`,
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)

    // Pending app's tool should NOT appear
    const pendingTool = body.tools.find((t: any) => t.toolName === 'do_thing')
    expect(pendingTool).toBeUndefined()
  })

  it('returns 404 for invalid join code', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/classrooms/by-join-code/INVALID99/tool-manifest',
    })

    expect(res.statusCode).toBe(404)
  })

  it('does not require authentication', async () => {
    // No auth header — should still work
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/classrooms/by-join-code/${joinCode}/tool-manifest`,
    })

    expect(res.statusCode).toBe(200)
  })

  // === Step 2: __cbApp in tool invocation response ===

  it('tool invoke response includes __cbApp metadata', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/apps/${approvedAppId}/tools/start_game/invoke`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { parameters: {}, conversationId },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)

    // Existing fields still present
    expect(body.toolName).toBe('start_game')
    expect(body.result).toBeDefined()
    expect(body.instanceId).toBeDefined()
    expect(body.latencyMs).toBeDefined()

    // New __cbApp metadata nested in result
    expect(body.result.__cbApp).toBeDefined()
    expect(body.result.__cbApp.appId).toBe(approvedAppId)
    expect(body.result.__cbApp.appName).toContain('ManifestChess')
    expect(body.result.__cbApp.url).toBe('/api/v1/apps/chess/ui/')
    expect(body.result.__cbApp.height).toBe(500)
    expect(body.result.__cbApp.instanceId).toBe(body.instanceId)
  })
})
