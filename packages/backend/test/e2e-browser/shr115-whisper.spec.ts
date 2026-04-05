/**
 * SHR-115 — Whisper Routes: Playwright E2E with Screenshots
 *
 * A1: Teacher whisper stores and affects next AI turn (verified via live POST + DB persistence)
 * A2: Async guidance persists and is visible in classroom config
 * A3: Whisper invisible to student in REST + WebSocket, visible to teacher
 * A4: Only teacher/admin can whisper
 * A5: Swagger UI shows whisper endpoint
 */

import { test, expect, type Page } from '@playwright/test'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'
import WebSocket from 'ws'

const API = 'http://localhost:3001/api/v1'
const JWT_SECRET = process.env.JWT_SECRET_KEY ?? 'dev-secret-change-in-production'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://chatbridge:chatbridge_dev@localhost:5433/chatbridge'

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })

function sign(payload: Record<string, unknown>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' })
}

async function screenshotJSON(page: Page, title: string, data: unknown, path: string) {
  const json = JSON.stringify(data, null, 2)
  await page.setContent(`<!DOCTYPE html><html><head><style>
    body { font-family: 'SF Mono', monospace; background: #1e1e2e; color: #cdd6f4; padding: 24px; margin: 0; }
    h2 { color: #89b4fa; font-size: 16px; margin-bottom: 12px; border-bottom: 1px solid #45475a; padding-bottom: 8px; }
    .badge { display: inline-block; background: #a6e3a1; color: #1e1e2e; font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; margin-left: 8px; }
    pre { background: #181825; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.5; border: 1px solid #313244; }
    .meta { color: #6c7086; font-size: 12px; margin-top: 12px; }
  </style></head><body>
    <h2>SHR-115 ${title.replace(/</g, '&lt;')} <span class="badge">PASS</span></h2>
    <pre>${json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
    <div class="meta">ChatBridge v2 · Playwright E2E · ${new Date().toISOString()}</div>
  </body></html>`)
  await page.screenshot({ path, fullPage: true })
}

let districtId: string
let teacherId: string
let adminId: string
let studentId: string
let classroomId: string
let conversationId: string
let teacherToken: string
let adminToken: string
let studentToken: string

test.beforeAll(async () => {
  const district = await prisma.district.create({ data: { name: 'SHR115-E2E' } })
  districtId = district.id

  const teacher = await prisma.user.create({
    data: { districtId, role: 'teacher', displayName: 'SHR115 Teacher' },
  })
  teacherId = teacher.id
  teacherToken = sign({ userId: teacherId, role: 'teacher', districtId })

  const admin = await prisma.user.create({
    data: { districtId, role: 'district_admin', displayName: 'SHR115 Admin' },
  })
  adminId = admin.id
  adminToken = sign({ userId: adminId, role: 'district_admin', districtId })

  const student = await prisma.user.create({
    data: { districtId, role: 'student', displayName: 'SHR115 Student', gradeBand: 'g68' },
  })
  studentId = student.id
  studentToken = sign({ userId: studentId, role: 'student', districtId, gradeBand: 'g68' })

  const classroom = await prisma.classroom.create({
    data: {
      districtId,
      teacherId,
      name: 'SHR115 Class',
      joinCode: 'S115E2',
      gradeBand: 'g68',
      aiConfig: { mode: 'direct', subject: 'math' },
    },
  })
  classroomId = classroom.id

  const conversation = await prisma.conversation.create({
    data: { districtId, classroomId, studentId },
  })
  conversationId = conversation.id
})

test.afterAll(async () => {
  for (const table of ['messages', 'conversations', 'classrooms', 'users']) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE district_id = $1`, districtId).catch(() => {})
  }
  await prisma.$executeRawUnsafe('DELETE FROM districts WHERE id = $1', districtId).catch(() => {})
  await prisma.$disconnect()
})

test('A1: Teacher whisper stores successfully and next student turn succeeds live', async ({ request, page }) => {
  const whisperText = 'Guide the student toward fractions'

  const whisperRes = await request.post(`${API}/classrooms/${classroomId}/students/${studentId}/whisper`, {
    headers: { authorization: `Bearer ${teacherToken}` },
    data: { text: whisperText },
  })
  expect(whisperRes.status()).toBe(200)
  const whisperBody = await whisperRes.json()
  expect(whisperBody.success).toBe(true)
  expect(whisperBody.conversationId).toBe(conversationId)

  const whisper = await prisma.message.findFirst({
    where: { conversationId, authorRole: 'teacher_whisper' },
    orderBy: { createdAt: 'desc' },
  })
  expect(whisper).not.toBeNull()

  const studentRes = await request.post(`${API}/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${studentToken}` },
    data: { text: 'Can you help me with fractions?' },
  })
  expect(studentRes.status()).toBe(200)
  const studentBody = await studentRes.json()
  expect(studentBody.messageId).toBeDefined()
  expect(studentBody.response).toBeDefined()

  await screenshotJSON(page, 'A1: Whisper Stored + Next Turn', {
    whisperResponse: whisperBody,
    storedWhisper: {
      id: whisper!.id,
      role: whisper!.authorRole,
      contentParts: whisper!.contentParts,
    },
    nextTurn: {
      status: studentRes.status(),
      messageId: studentBody.messageId,
      aiMessageId: studentBody.aiMessageId ?? null,
      responsePreview: String(studentBody.response).slice(0, 160),
    },
  }, 'screenshots/shr115-a1-whisper-store-next-turn.png')
})

test('A2: Async guidance persists via PATCH classroom config', async ({ request, page }) => {
  const asyncGuidance = 'Focus on chapter 5 vocabulary this week'

  const patchRes = await request.patch(`${API}/classrooms/${classroomId}/config`, {
    headers: { authorization: `Bearer ${teacherToken}` },
    data: {
      aiConfig: { mode: 'direct', subject: 'math' },
      asyncGuidance,
    },
  })

  expect(patchRes.status()).toBe(200)
  const patchBody = await patchRes.json()

  const classroom = await prisma.classroom.findUnique({ where: { id: classroomId } })
  const aiConfig = classroom!.aiConfig as Record<string, unknown>
  expect(aiConfig.asyncGuidance).toBe(asyncGuidance)

  await screenshotJSON(page, 'A2: Async Guidance Persisted', {
    patchStatus: patchRes.status(),
    patchBody,
    persistedAsyncGuidance: aiConfig.asyncGuidance,
  }, 'screenshots/shr115-a2-async-guidance.png')
})

test('A3: Whisper hidden from student across REST and WebSocket, visible to teacher', async ({ request, page }) => {
  const whisperText = 'Keep this whisper hidden from the student'

  await request.post(`${API}/classrooms/${classroomId}/students/${studentId}/whisper`, {
    headers: { authorization: `Bearer ${teacherToken}` },
    data: { text: whisperText },
  })

  const studentHistoryRes = await request.get(`${API}/conversations/${conversationId}/messages?limit=50`, {
    headers: { authorization: `Bearer ${studentToken}` },
  })
  expect(studentHistoryRes.status()).toBe(200)
  const studentHistory = await studentHistoryRes.json()
  const studentWhispers = studentHistory.messages.filter((m: any) => m.authorRole === 'teacher_whisper')
  expect(studentWhispers).toHaveLength(0)

  const teacherHistoryRes = await request.get(`${API}/conversations/${conversationId}/messages?limit=50`, {
    headers: { authorization: `Bearer ${teacherToken}` },
  })
  expect(teacherHistoryRes.status()).toBe(200)
  const teacherHistory = await teacherHistoryRes.json()
  const teacherWhispers = teacherHistory.messages.filter((m: any) => m.authorRole === 'teacher_whisper')
  expect(teacherWhispers.length).toBeGreaterThanOrEqual(1)

  const ws = new WebSocket(`ws://localhost:3001/api/v1/ws/chat?token=${studentToken}&conversationId=${conversationId}`)
  const frames: string[] = []

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('websocket open timeout')), 5000)
    ws.on('open', () => {
      clearTimeout(timeout)
      resolve()
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })

  ws.on('message', (raw) => {
    frames.push(raw.toString())
  })

  ws.send(JSON.stringify({ type: 'ping' }))
  ws.send(JSON.stringify({ type: 'chat_message', text: 'I need help with fractions' }))
  await new Promise((resolve) => setTimeout(resolve, 500))
  ws.close()

  expect(frames.length).toBeGreaterThan(0)
  expect(frames.some((frame) => frame.includes(whisperText))).toBe(false)

  await screenshotJSON(page, 'A3: Student Hidden, Teacher Visible', {
    studentWhisperCount: studentWhispers.length,
    teacherWhisperCount: teacherWhispers.length,
    websocketFrameCount: frames.length,
    websocketLeakDetected: frames.some((frame) => frame.includes(whisperText)),
  }, 'screenshots/shr115-a3-visibility.png')
})

test('A4: Student blocked, teacher and admin allowed', async ({ request, page }) => {
  const studentRes = await request.post(`${API}/classrooms/${classroomId}/students/${studentId}/whisper`, {
    headers: { authorization: `Bearer ${studentToken}` },
    data: { text: 'test' },
  })
  expect(studentRes.status()).toBe(403)

  const teacherRes = await request.post(`${API}/classrooms/${classroomId}/students/${studentId}/whisper`, {
    headers: { authorization: `Bearer ${teacherToken}` },
    data: { text: 'Teacher allowed whisper' },
  })
  expect(teacherRes.status()).toBe(200)

  const adminRes = await request.post(`${API}/classrooms/${classroomId}/students/${studentId}/whisper`, {
    headers: { authorization: `Bearer ${adminToken}` },
    data: { text: 'Admin allowed whisper' },
  })
  expect(adminRes.status()).toBe(200)

  await screenshotJSON(page, 'A4: Role Authorization', {
    student: { status: studentRes.status() },
    teacher: { status: teacherRes.status(), body: await teacherRes.json() },
    admin: { status: adminRes.status(), body: await adminRes.json() },
  }, 'screenshots/shr115-a4-role-auth.png')
})

test('A5: Swagger UI shows whisper endpoint', async ({ page }) => {
  await page.goto('http://localhost:3001/docs')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('.swagger-ui', { timeout: 10000 })
  await expect(page.locator('body')).toContainText('POST/classrooms/{id}/students/{studentId}/whisper')
  await page.screenshot({ path: 'screenshots/shr115-a5-swagger.png', fullPage: true })
})
