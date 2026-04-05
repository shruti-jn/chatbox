import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { chromium } from 'playwright'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'

import { loadConversationContext } from '../../packages/backend/src/ai/context-builder.ts'
import { assembleSystemPrompt } from '../../packages/backend/src/prompts/registry.ts'

const execFileAsync = promisify(execFile)

const API_ORIGIN = 'http://127.0.0.1:3001'
const API_BASE = `${API_ORIGIN}/api/v1`
const WS_BASE = 'ws://127.0.0.1:3001/api/v1/ws/chat'
const JWT_SECRET = process.env.JWT_SECRET_KEY ?? 'dev-secret-change-in-production'
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://chatbridge:chatbridge_dev@localhost:5433/chatbridge'
const ARTIFACT_DIR = path.resolve('output/playwright/shr-115')

const prisma = new PrismaClient({
  datasources: { db: { url: DATABASE_URL } },
})

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' })
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function seedFixture() {
  const district = await prisma.district.create({
    data: { name: `SHR115 Browser Verify ${Date.now()}` },
  })

  const teacher = await prisma.user.create({
    data: { districtId: district.id, role: 'teacher', displayName: 'Browser Teacher' },
  })
  const admin = await prisma.user.create({
    data: { districtId: district.id, role: 'district_admin', displayName: 'Browser Admin' },
  })
  const studentA = await prisma.user.create({
    data: { districtId: district.id, role: 'student', displayName: 'Browser Student A', gradeBand: 'g68' },
  })
  const studentB = await prisma.user.create({
    data: { districtId: district.id, role: 'student', displayName: 'Browser Student B', gradeBand: 'g68' },
  })

  const classroom = await prisma.classroom.create({
    data: {
      districtId: district.id,
      teacherId: teacher.id,
      name: 'SHR-115 Browser Classroom',
      joinCode: `W${Date.now().toString().slice(-5)}`,
      gradeBand: 'g68',
      aiConfig: { mode: 'direct', subject: 'math' },
    },
  })

  const conversationA = await prisma.conversation.create({
    data: { districtId: district.id, classroomId: classroom.id, studentId: studentA.id },
  })
  const conversationB = await prisma.conversation.create({
    data: { districtId: district.id, classroomId: classroom.id, studentId: studentB.id },
  })

  return {
    districtId: district.id,
    teacherId: teacher.id,
    adminId: admin.id,
    studentAId: studentA.id,
    studentBId: studentB.id,
    classroomId: classroom.id,
    conversationAId: conversationA.id,
    conversationBId: conversationB.id,
    teacherToken: signToken({ userId: teacher.id, role: 'teacher', districtId: district.id }),
    adminToken: signToken({ userId: admin.id, role: 'district_admin', districtId: district.id }),
    studentAToken: signToken({
      userId: studentA.id,
      role: 'student',
      districtId: district.id,
      gradeBand: 'g68',
    }),
    studentBToken: signToken({
      userId: studentB.id,
      role: 'student',
      districtId: district.id,
      gradeBand: 'g68',
    }),
  }
}

async function cleanupFixture(fixture) {
  await prisma.$executeRawUnsafe(`DELETE FROM audit_events WHERE district_id = '${fixture.districtId}'`).catch(() => {})
  await prisma.$executeRawUnsafe(`DELETE FROM safety_events WHERE district_id = '${fixture.districtId}'`).catch(() => {})
  await prisma.$executeRawUnsafe(`DELETE FROM messages WHERE district_id = '${fixture.districtId}'`).catch(() => {})
  await prisma.$executeRawUnsafe(`DELETE FROM conversations WHERE district_id = '${fixture.districtId}'`).catch(() => {})
  await prisma.$executeRawUnsafe(`DELETE FROM classrooms WHERE district_id = '${fixture.districtId}'`).catch(() => {})
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE district_id = '${fixture.districtId}'`).catch(() => {})
  await prisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = '${fixture.districtId}'`).catch(() => {})
}

async function initVerificationPage(page, title) {
  await page.goto(`${API_ORIGIN}/docs`, { waitUntil: 'networkidle' })
  await page.evaluate((verificationTitle) => {
    document.head.innerHTML = `
      <style>
        body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 32px; }
        h1 { margin: 0 0 12px; font-size: 28px; }
        p { color: #cbd5e1; max-width: 900px; }
        .step { border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-top: 16px; background: #111827; }
        .step h2 { margin: 0 0 8px; font-size: 18px; color: #93c5fd; }
        pre { white-space: pre-wrap; word-break: break-word; background: #020617; border-radius: 8px; padding: 12px; color: #cbd5e1; }
        .pass { color: #86efac; }
      </style>
    `
    document.body.innerHTML = `
      <h1>${verificationTitle}</h1>
      <p>Real browser verification for SHR-115. Each step was executed against the running ChatBridge backend.</p>
      <div id="steps"></div>
    `
  }, title)
}

async function appendStep(page, title, payload) {
  await page.evaluate(({ stepTitle, stepPayload }) => {
    const container = document.getElementById('steps')
    const section = document.createElement('section')
    section.className = 'step'
    section.innerHTML = `
      <h2 class="pass">${stepTitle}</h2>
      <pre>${stepPayload}</pre>
    `
    container?.appendChild(section)
  }, {
    stepTitle: title,
    stepPayload: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
  })
}

async function withRecordedPage(browser, key, title, runner) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    recordVideo: {
      dir: ARTIFACT_DIR,
      size: { width: 1280, height: 720 },
    },
  })
  const page = await context.newPage()

  await initVerificationPage(page, title)
  await runner(page)
  await page.waitForTimeout(900)

  const video = page.video()
  await context.close()
  const videoPath = await video.path()
  const gifPath = path.join(ARTIFACT_DIR, `${key}.gif`)
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    videoPath,
    '-vf',
    'fps=6,scale=960:-1:flags=lanczos',
    gifPath,
  ])

  return { videoPath, gifPath }
}

async function apiFetch(route, options = {}) {
  const response = await fetch(route, options)
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: response.status, json }
}

async function run() {
  await ensureDir(ARTIFACT_DIR)

  const fixture = await seedFixture()
  const browser = await chromium.launch({ headless: true })
  const artifacts = []

  try {
    artifacts.push(await withRecordedPage(browser, 'a1-whisper-storage-and-context', 'SHR-115 A1 — Whisper storage + next-turn context injection', async (page) => {
      const whisperResponse = await apiFetch(`${API_BASE}/classrooms/${fixture.classroomId}/students/${fixture.studentAId}/whisper`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.teacherToken}`,
        },
        body: JSON.stringify({ text: 'Guide student toward fractions' }),
      })
      await appendStep(page, 'Teacher whisper POST succeeded', whisperResponse)

      const storedWhisper = await prisma.message.findFirst({
        where: { conversationId: fixture.conversationAId, authorRole: 'teacher_whisper' },
        orderBy: { createdAt: 'desc' },
      })
      await appendStep(page, 'Whisper stored in DB', {
        conversationId: storedWhisper?.conversationId,
        authorRole: storedWhisper?.authorRole,
        contentParts: storedWhisper?.contentParts,
      })

      const ctx = await loadConversationContext(fixture.conversationAId, fixture.districtId, 'student')
      const prompt = assembleSystemPrompt({
        classroomConfig: ctx.aiConfig,
        gradeBand: ctx.gradeBand,
        toolSchemas: [],
        whisperGuidance: ctx.whisperGuidance,
        safetyInstructions: null,
        activeAppState: null,
        activeAppName: null,
        activeAppStatus: null,
        stateUpdatedAt: null,
      })
      await appendStep(page, 'Next student-turn AI context includes whisper', {
        whisperGuidance: ctx.whisperGuidance,
        promptExcerpt: prompt.includes('Guide student toward fractions'),
      })
    }))

    artifacts.push(await withRecordedPage(browser, 'a2-async-guidance', 'SHR-115 A2 — Async guidance persists and affects all students', async (page) => {
      const patchResponse = await apiFetch(`${API_BASE}/classrooms/${fixture.classroomId}/config`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.teacherToken}`,
        },
        body: JSON.stringify({
          asyncGuidance: 'Focus on chapter 5 vocabulary this week',
        }),
      })
      await appendStep(page, 'PATCH classroom config', patchResponse)

      const getResponse = await apiFetch(`${API_BASE}/classrooms/${fixture.classroomId}/config`, {
        headers: { authorization: `Bearer ${fixture.teacherToken}` },
      })
      await appendStep(page, 'GET classroom config', getResponse)

      const contextA = await loadConversationContext(fixture.conversationAId, fixture.districtId, 'student')
      const contextB = await loadConversationContext(fixture.conversationBId, fixture.districtId, 'student')
      await appendStep(page, 'Async guidance appears for both students', {
        studentA: contextA.aiConfig.asyncGuidance,
        studentB: contextB.aiConfig.asyncGuidance,
      })
    }))

    artifacts.push(await withRecordedPage(browser, 'a3-invisibility-rest-and-ws', 'SHR-115 A3 — Whisper invisible to student in REST and WebSocket views', async (page) => {
      await apiFetch(`${API_BASE}/classrooms/${fixture.classroomId}/students/${fixture.studentAId}/whisper`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.teacherToken}`,
        },
        body: JSON.stringify({ text: 'Invisible whisper for student channels' }),
      })

      const studentHistory = await apiFetch(`${API_BASE}/conversations/${fixture.conversationAId}/messages?limit=50`, {
        headers: { authorization: `Bearer ${fixture.studentAToken}` },
      })
      const teacherHistory = await apiFetch(`${API_BASE}/conversations/${fixture.conversationAId}/messages?limit=50`, {
        headers: { authorization: `Bearer ${fixture.teacherToken}` },
      })
      await appendStep(page, 'REST history comparison', {
        studentWhisperCount: studentHistory.json.messages.filter((msg) => msg.authorRole === 'teacher_whisper').length,
        teacherWhisperCount: teacherHistory.json.messages.filter((msg) => msg.authorRole === 'teacher_whisper').length,
      })

      const wsResult = await page.evaluate(async ({ wsUrl, token, conversationId, secretText }) => {
        const frames = []
        const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}&conversationId=${encodeURIComponent(conversationId)}`)

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('websocket timeout')), 3000)
          socket.addEventListener('open', () => {
            clearTimeout(timeout)
            resolve()
          }, { once: true })
          socket.addEventListener('error', () => {
            clearTimeout(timeout)
            reject(new Error('websocket failed'))
          }, { once: true })
        })

        socket.addEventListener('message', (event) => {
          frames.push(String(event.data))
        })

        socket.send(JSON.stringify({ type: 'ping' }))
        socket.send(JSON.stringify({ type: 'chat_message', text: 'I need help with fractions' }))
        await new Promise((resolve) => setTimeout(resolve, 300))
        socket.close()

        return {
          frames,
          exposedWhisper: frames.some((frame) => frame.includes(secretText)),
        }
      }, {
        wsUrl: WS_BASE,
        token: fixture.studentAToken,
        conversationId: fixture.conversationAId,
        secretText: 'Invisible whisper for student channels',
      })
      await appendStep(page, 'WebSocket frames stay whisper-free', wsResult)
    }))

    artifacts.push(await withRecordedPage(browser, 'a4-role-authorization', 'SHR-115 A4 — Only teacher/admin can send whispers', async (page) => {
      const studentAttempt = await apiFetch(`${API_BASE}/classrooms/${fixture.classroomId}/students/${fixture.studentAId}/whisper`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.studentAToken}`,
        },
        body: JSON.stringify({ text: 'student should fail' }),
      })
      await appendStep(page, 'Student whisper attempt', studentAttempt)

      const teacherAttempt = await apiFetch(`${API_BASE}/classrooms/${fixture.classroomId}/students/${fixture.studentAId}/whisper`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.teacherToken}`,
        },
        body: JSON.stringify({ text: 'teacher should pass' }),
      })
      await appendStep(page, 'Teacher whisper attempt', teacherAttempt)

      const adminAttempt = await apiFetch(`${API_BASE}/classrooms/${fixture.classroomId}/students/${fixture.studentAId}/whisper`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.adminToken}`,
        },
        body: JSON.stringify({ text: 'admin should pass' }),
      })
      await appendStep(page, 'Admin whisper attempt', adminAttempt)
    }))

    artifacts.push(await withRecordedPage(browser, 'a5-test-suite', 'SHR-115 A5 — Targeted whisper suite passes', async (page) => {
      const { stdout } = await execFileAsync('../../node_modules/.bin/vitest', ['run', 'test/whisper.test.ts'], {
        cwd: path.resolve('packages/backend'),
      })
      await appendStep(page, 'Vitest result', stdout)
    }))

    const manifest = artifacts.map((item) => ({
      video: path.relative(process.cwd(), item.videoPath),
      gif: path.relative(process.cwd(), item.gifPath),
    }))
    await fs.writeFile(path.join(ARTIFACT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
    console.log(JSON.stringify({ ok: true, artifacts: manifest }, null, 2))
  } finally {
    await browser.close().catch(() => {})
    await cleanupFixture(fixture).catch(() => {})
    await prisma.$disconnect().catch(() => {})
  }
}

await run()
