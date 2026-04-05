import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ownerPrisma } from '../src/middleware/rls.js'
import { signJWT } from '../src/middleware/auth.js'

const generateResponseMock = vi.fn()

vi.mock('../src/ai/service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ai/service.js')>('../src/ai/service.js')
  return {
    ...actual,
    generateResponse: generateResponseMock,
  }
})

const { buildServer } = await import('../src/server.js')

let counter = 0
function uniqueJoinCode(prefix: string): string {
  counter += 1
  return `${prefix}${Math.random().toString(36).slice(2, 8).toUpperCase()}${counter}`
}

function makeStream(text: string): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      yield text
    },
  }
}

describe('Chat route chess analysis grounding', () => {
  let server: FastifyInstance
  let districtId: string
  let teacherId: string
  let studentId: string
  let classroomId: string
  let conversationId: string
  let studentToken: string
  let chessAppId: string

  beforeAll(async () => {
    generateResponseMock.mockReset()
    generateResponseMock.mockResolvedValue({
      textStream: makeStream('Grounded chess response'),
    })

    server = await buildServer()
    await server.ready()

    const district = await ownerPrisma.district.create({ data: { name: `Chess Route District ${Date.now()}` } })
    districtId = district.id

    const teacher = await ownerPrisma.user.create({
      data: { districtId, role: 'teacher', displayName: 'Chess Route Teacher' },
    })
    teacherId = teacher.id

    const student = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Chess Route Student', gradeBand: 'g912' },
    })
    studentId = student.id
    studentToken = signJWT({ userId: studentId, role: 'student', districtId, gradeBand: 'g912' })

    const classroom = await ownerPrisma.classroom.create({
      data: {
        districtId,
        teacherId,
        name: 'Chess Route Class',
        joinCode: uniqueJoinCode('CR'),
        gradeBand: 'g912',
        aiConfig: { mode: 'direct', subject: 'chess' },
      },
    })
    classroomId = classroom.id

    const conversation = await ownerPrisma.conversation.create({
      data: { districtId, classroomId, studentId },
    })
    conversationId = conversation.id

    const existingChessApp = await ownerPrisma.app.findFirst({ where: { name: 'Chess' } })
    const chessApp = existingChessApp
      ? await ownerPrisma.app.update({
          where: { id: existingChessApp.id },
          data: {
            reviewStatus: 'approved',
            toolDefinitions: [
              { name: 'start_game', description: 'Start a new chess game', inputSchema: { type: 'object' } },
              { name: 'make_move', description: 'Make a move', inputSchema: { type: 'object', properties: { move: { type: 'string' } } } },
            ],
          },
        })
      : await ownerPrisma.app.create({
          data: {
            name: 'Chess',
            description: 'Interactive chess game with AI analysis',
            toolDefinitions: [
              { name: 'start_game', description: 'Start a new chess game', inputSchema: { type: 'object' } },
              { name: 'make_move', description: 'Make a move', inputSchema: { type: 'object', properties: { move: { type: 'string' } } } },
            ],
            uiManifest: { url: '/api/v1/apps/chess/ui/', width: 600, height: 600 },
            permissions: { compute: true },
            complianceMetadata: { coppaCompliant: true, ferpaCompliant: true },
            version: '1.0.0',
            reviewStatus: 'approved',
          },
        })
    chessAppId = chessApp.id

    await ownerPrisma.districtAppCatalog.upsert({
      where: { districtId_appId: { districtId, appId: chessAppId } },
      update: { status: 'approved' },
      create: { districtId, appId: chessAppId, status: 'approved' },
    })

    await ownerPrisma.classroomAppConfig.create({
      data: { districtId, classroomId, appId: chessAppId, enabled: true },
    })
  })

  afterAll(async () => {
    try {
      await ownerPrisma.auditEvent.deleteMany({ where: { districtId } })
      await ownerPrisma.safetyEvent.deleteMany({ where: { districtId } })
      await ownerPrisma.message.deleteMany({ where: { districtId } })
      await ownerPrisma.appInstance.deleteMany({ where: { districtId } })
      await ownerPrisma.classroomAppConfig.deleteMany({ where: { districtId } })
      await ownerPrisma.districtAppCatalog.deleteMany({ where: { districtId } })
      await ownerPrisma.conversation.deleteMany({ where: { districtId } })
      await ownerPrisma.classroom.deleteMany({ where: { districtId } })
      await ownerPrisma.user.deleteMany({ where: { districtId } })
      await ownerPrisma.district.delete({ where: { id: districtId } })
    } catch {
      // Best effort cleanup in dirty shared test DB.
    }
    await server.close()
  })

  it('injects position-specific chess guidance into the chat route prompt', async () => {
    await ownerPrisma.appInstance.create({
      data: {
        districtId,
        conversationId,
        appId: chessAppId,
        status: 'active',
        stateSnapshot: {
          fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 2 3',
        },
      },
    })

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { text: 'What should I do?' },
    })

    expect(res.statusCode).toBe(200)
    expect(generateResponseMock).toHaveBeenCalledOnce()

    const [, systemPrompt] = generateResponseMock.mock.calls[0]
    expect(typeof systemPrompt).toBe('string')
    expect(systemPrompt).toContain('CHESS POSITION GUIDANCE')
    expect(systemPrompt).toContain('bishop on c4')
    expect(systemPrompt).toContain('knight on c6')
    expect(systemPrompt).toContain('Use at least 2 of these concrete board facts')
  })

  it('marks terminal chess positions as game over in the route prompt', async () => {
    await ownerPrisma.appInstance.deleteMany({ where: { districtId, conversationId } })
    generateResponseMock.mockClear()

    await ownerPrisma.appInstance.create({
      data: {
        districtId,
        conversationId,
        appId: chessAppId,
        status: 'active',
        stateSnapshot: {
          fen: '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1',
        },
      },
    })

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { text: 'Analyze this position' },
    })

    expect(res.statusCode).toBe(200)
    expect(generateResponseMock).toHaveBeenCalledOnce()

    const [, systemPrompt] = generateResponseMock.mock.calls[0]
    expect(systemPrompt).toContain('Status: checkmate')
    expect(systemPrompt).toContain('Do not suggest another move')
  })
})
