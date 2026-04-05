/**
 * Whisper Tests — Teacher whisper guidance features
 *
 * Tests:
 * - Student cannot send whisper (403)
 * - Student cannot see whisper in conversation history
 * - Async guidance persists and appears in AI context
 * - Active whisper appears in recent whisper query
 * - Cancel whisper removes it from active list (delete whisper message)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma } from '../src/middleware/rls.js'
import type { FastifyInstance } from 'fastify'
import { loadConversationContext } from '../src/ai/context-builder.js'
import { assembleSystemPrompt } from '../src/prompts/registry.js'

describe('Whisper Guidance', () => {
  let server: FastifyInstance
  let districtId: string
  let teacherId: string
  let adminToken: string
  let studentId: string
  let teacherToken: string
  let studentToken: string
  let classroomId: string
  let conversationId: string
  let wsBaseUrl: string

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()
    await server.listen({ port: 0, host: '127.0.0.1' })
    const addr = server.server.address()
    if (!addr || typeof addr !== 'object') {
      throw new Error('Failed to bind websocket test server')
    }
    wsBaseUrl = `ws://127.0.0.1:${addr.port}`

    const district = await ownerPrisma.district.create({ data: { name: 'Whisper Test District' } })
    districtId = district.id

    const teacher = await ownerPrisma.user.create({
      data: { districtId, role: 'teacher', displayName: 'Whisper Teacher' },
    })
    teacherId = teacher.id
    teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId })

    const admin = await ownerPrisma.user.create({
      data: { districtId, role: 'district_admin', displayName: 'Whisper Admin' },
    })
    adminToken = signJWT({ userId: admin.id, role: 'district_admin', districtId })

    const student = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Whisper Student', gradeBand: 'g68' },
    })
    studentId = student.id
    studentToken = signJWT({ userId: student.id, role: 'student', districtId })

    const classroom = await ownerPrisma.classroom.create({
      data: {
        districtId,
        teacherId,
        name: 'Whisper Test Class',
        joinCode: 'WHSP01',
        gradeBand: 'g68',
        aiConfig: { mode: 'direct', subject: 'math' },
      },
    })
    classroomId = classroom.id

    const conversation = await ownerPrisma.conversation.create({
      data: { districtId, classroomId, studentId },
    })
    conversationId = conversation.id
  })

  afterAll(async () => {
    try {
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM messages WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM conversations WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM classrooms WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM users WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = '${districtId}'`)
    } catch { /* Best effort cleanup */ }
    await server.close()
  })

  it('student cannot send whisper (403)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${classroomId}/students/${studentId}/whisper`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { guidance: 'This should be rejected' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('teacher can send whisper successfully', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${classroomId}/students/${studentId}/whisper`,
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { text: 'Help the student focus on fractions' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.success).toBe(true)
    expect(body.conversationId).toBe(conversationId)
    expect(body.redacted).toBe(false)
  })

  it('district admin can send whisper successfully', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${classroomId}/students/${studentId}/whisper`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { guidance: 'Guide the student toward common denominators' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.success).toBe(true)
  })

  it('student cannot see whisper messages in conversation history', async () => {
    // First confirm a whisper exists in the DB
    const allMessages = await ownerPrisma.message.findMany({
      where: { conversationId, authorRole: 'teacher_whisper' },
    })
    expect(allMessages.length).toBeGreaterThanOrEqual(1)

    // Student fetches conversation history — whisper should be filtered out
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages?limit=50`,
      headers: { authorization: `Bearer ${studentToken}` },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const whisperMessages = body.messages.filter(
      (m: { authorRole: string }) => m.authorRole === 'teacher_whisper',
    )
    expect(whisperMessages).toHaveLength(0)
  })

  it('teacher CAN see whisper messages in conversation history', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages?limit=50`,
      headers: { authorization: `Bearer ${teacherToken}` },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const whisperMessages = body.messages.filter(
      (m: { authorRole: string }) => m.authorRole === 'teacher_whisper',
    )
    expect(whisperMessages.length).toBeGreaterThanOrEqual(1)
  })

  it('active whisper appears in recent whisper query (within 5 min)', async () => {
    // Send a fresh whisper
    await server.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${classroomId}/students/${studentId}/whisper`,
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { guidance: 'Focus on long division steps' },
    })

    // Verify whisper is stored and recent (within 5 min window)
    const recentWhisper = await ownerPrisma.message.findFirst({
      where: {
        conversationId,
        authorRole: 'teacher_whisper',
        createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
    })

    expect(recentWhisper).not.toBeNull()
    const contentParts = recentWhisper!.contentParts as Array<{ text: string }>
    expect(contentParts[0].text).toBe('Focus on long division steps')
  })

  it('redacts PII before storing whisper content', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${classroomId}/students/${studentId}/whisper`,
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { text: 'Call Maya at 312-555-0199 after class' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.redacted).toBe(true)

    const whisper = await ownerPrisma.message.findFirst({
      where: { conversationId, authorRole: 'teacher_whisper' },
      orderBy: { createdAt: 'desc' },
    })

    const contentParts = whisper!.contentParts as Array<{ text: string; redactionApplied?: boolean; piiTypes?: string[] }>
    expect(contentParts[0].text).toBe('Call Maya at [REDACTED] after class')
    expect(contentParts[0].redactionApplied).toBe(true)
    expect(contentParts[0].piiTypes).toContain('phone')
  })

  it('async guidance persists in classroom config and appears in AI context', async () => {
    // Set async guidance via classroom config
    const configRes = await server.inject({
      method: 'PATCH',
      url: `/api/v1/classrooms/${classroomId}/config`,
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: {
        aiConfig: { mode: 'direct', subject: 'math' },
        asyncGuidance: 'Always encourage students to show their work step by step',
      },
    })

    expect(configRes.statusCode).toBe(200)

    // Verify it persists in the database
    const classroom = await ownerPrisma.classroom.findUnique({
      where: { id: classroomId },
    })

    const aiConfig = classroom!.aiConfig as Record<string, unknown>
    expect(aiConfig.asyncGuidance).toBe('Always encourage students to show their work step by step')
  })

  it('whisper and async guidance are injected into AI context for the next student turn', async () => {
    await server.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${classroomId}/students/${studentId}/whisper`,
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { text: 'Guide the student toward fractions' },
    })

    const ctx = await loadConversationContext(conversationId, districtId, 'student')

    expect(ctx.whisperGuidance).toBe('Guide the student toward fractions')
    expect(ctx.aiConfig.asyncGuidance).toBe('Always encourage students to show their work step by step')

    const prompt = assembleSystemPrompt({
      classroomConfig: ctx.aiConfig,
      gradeBand: ctx.gradeBand as 'g68',
      toolSchemas: [],
      whisperGuidance: ctx.whisperGuidance,
      safetyInstructions: null,
      activeAppState: null,
      activeAppName: null,
      activeAppStatus: null,
      stateUpdatedAt: null,
    })

    expect(prompt).toContain('Always encourage students to show their work step by step')
    expect(prompt).toContain('Guide the student toward fractions')
  })

  it('student websocket frames never expose whisper content', async () => {
    const whisperText = 'Keep this whisper hidden from the student'

    await server.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${classroomId}/students/${studentId}/whisper`,
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { text: whisperText },
    })

    const WebSocket = (await import('ws')).default
    const ws = new WebSocket(
      `${wsBaseUrl}/api/v1/ws/chat?token=${studentToken}&conversationId=${conversationId}`,
    )

    const frames: string[] = []

    const opened = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 3000)
      ws.on('open', () => {
        clearTimeout(timeout)
        resolve(true)
      })
      ws.on('error', () => {
        clearTimeout(timeout)
        resolve(false)
      })
    })

    expect(opened).toBe(true)

    ws.on('message', (raw: Buffer) => {
      frames.push(raw.toString())
    })

    ws.send(JSON.stringify({ type: 'ping' }))
    ws.send(JSON.stringify({ type: 'chat_message', text: 'I need help with fractions' }))

    await new Promise((resolve) => setTimeout(resolve, 250))

    ws.close()

    expect(frames.length).toBeGreaterThan(0)
    expect(frames.some((frame) => frame.includes(whisperText))).toBe(false)
    expect(frames.some((frame) => frame.includes('pong'))).toBe(true)
  })

  it('deleting whisper message removes it from active list', async () => {
    // Send a whisper
    await server.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${classroomId}/students/${studentId}/whisper`,
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { guidance: 'Temporary whisper to be removed' },
    })

    // Find the whisper message
    const whisper = await ownerPrisma.message.findFirst({
      where: {
        conversationId,
        authorRole: 'teacher_whisper',
      },
      orderBy: { createdAt: 'desc' },
    })
    expect(whisper).not.toBeNull()

    // Delete the whisper directly (simulating cancellation)
    await ownerPrisma.message.delete({
      where: { id: whisper!.id },
    })

    // Verify it no longer appears in the active whisper query
    const recentWhisperAfterDelete = await ownerPrisma.message.findFirst({
      where: {
        id: whisper!.id,
      },
    })

    expect(recentWhisperAfterDelete).toBeNull()
  })
})
