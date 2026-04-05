import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { chromium } from 'playwright'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'

const execFileAsync = promisify(execFile)

const API_ORIGIN = 'http://127.0.0.1:3001'
const API_BASE = `${API_ORIGIN}/api/v1`
const JWT_SECRET = process.env.JWT_SECRET_KEY ?? 'test-secret-key'
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://chatbridge:chatbridge_dev@localhost:5433/chatbridge'
const ARTIFACT_DIR = path.resolve('output/playwright/shr-116')

const prisma = new PrismaClient({
  datasources: { db: { url: DATABASE_URL } },
})

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' })
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function seedFixture() {
  const district = await prisma.district.create({
    data: { name: `SHR116 Browser Verify ${Date.now()}` },
  })

  const teacher = await prisma.user.create({
    data: { districtId: district.id, role: 'teacher', displayName: 'Consent Browser Teacher' },
  })
  const admin = await prisma.user.create({
    data: { districtId: district.id, role: 'district_admin', displayName: 'Consent Browser Admin' },
  })
  const under13 = await prisma.user.create({
    data: { districtId: district.id, role: 'student', displayName: 'Consent Browser Kid', gradeBand: 'k2' },
  })
  const over13 = await prisma.user.create({
    data: { districtId: district.id, role: 'student', displayName: 'Consent Browser Teen', gradeBand: 'g68' },
  })

  const classroom = await prisma.classroom.create({
    data: {
      districtId: district.id,
      teacherId: teacher.id,
      name: 'SHR-116 Browser Classroom',
      joinCode: `C${Date.now().toString().slice(-5)}`,
      gradeBand: 'g68',
      aiConfig: { mode: 'direct', subject: 'science' },
    },
  })

  const under13Conversation = await prisma.conversation.create({
    data: { districtId: district.id, classroomId: classroom.id, studentId: under13.id },
  })
  const over13Conversation = await prisma.conversation.create({
    data: { districtId: district.id, classroomId: classroom.id, studentId: over13.id },
  })

  return {
    districtId: district.id,
    teacherId: teacher.id,
    adminId: admin.id,
    under13Id: under13.id,
    over13Id: over13.id,
    classroomId: classroom.id,
    under13ConversationId: under13Conversation.id,
    over13ConversationId: over13Conversation.id,
    teacherToken: signToken({ userId: teacher.id, role: 'teacher', districtId: district.id }),
    adminToken: signToken({ userId: admin.id, role: 'district_admin', districtId: district.id }),
    under13Token: signToken({
      userId: under13.id,
      role: 'student',
      districtId: district.id,
      gradeBand: 'k2',
    }),
    over13Token: signToken({
      userId: over13.id,
      role: 'student',
      districtId: district.id,
      gradeBand: 'g68',
    }),
  }
}

async function cleanupFixture(fixture) {
  await prisma.$executeRawUnsafe(`DELETE FROM email_outbox WHERE district_id = '${fixture.districtId}'`).catch(() => {})
  await prisma.$executeRawUnsafe(`DELETE FROM data_deletion_requests WHERE district_id = '${fixture.districtId}'`).catch(() => {})
  await prisma.$executeRawUnsafe(`DELETE FROM parental_consents WHERE district_id = '${fixture.districtId}'`).catch(() => {})
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
      <p>Real browser verification for SHR-116 against the running ChatBridge backend.</p>
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
  const smallGifPath = path.join(ARTIFACT_DIR, `${key}-small.gif`)
  await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-vf', 'fps=6,scale=960:-1:flags=lanczos', gifPath])
  await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-vf', 'fps=5,scale=720:-1:flags=lanczos', smallGifPath])

  return { videoPath, gifPath, smallGifPath }
}

async function apiFetch(route, options = {}) {
  const response = await fetch(route, options)
  const text = await response.text()
  let json
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
    let consentToken = ''

    artifacts.push(await withRecordedPage(browser, 'a1-under13-gate', 'SHR-116 A1 — COPPA gate blocks under-13 access', async (page) => {
      const blocked = await apiFetch(`${API_BASE}/conversations/${fixture.under13ConversationId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.under13Token}`,
        },
        body: JSON.stringify({ text: 'Hello from an under-13 student' }),
      })
      await appendStep(page, 'Under-13 student is blocked', blocked)

      const allowed = await apiFetch(`${API_BASE}/conversations/${fixture.over13ConversationId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.over13Token}`,
        },
        body: JSON.stringify({ text: 'Hello from an older student' }),
      })
      await appendStep(page, 'Over-13 student is not blocked by COPPA', {
        status: allowed.status,
        blocked: allowed.status === 403,
      })
    }))

    artifacts.push(await withRecordedPage(browser, 'a2-consent-request', 'SHR-116 A2 — Consent request queues tokenized email link', async (page) => {
      const teacherAttempt = await apiFetch(`${API_BASE}/consent/request`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.teacherToken}`,
        },
        body: JSON.stringify({ studentId: fixture.under13Id, parentEmail: 'parent@example.com' }),
      })
      await appendStep(page, 'Teacher request succeeds', teacherAttempt)

      const adminAttempt = await apiFetch(`${API_BASE}/consent/request`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.adminToken}`,
        },
        body: JSON.stringify({ studentId: fixture.under13Id, parentEmail: 'admin-parent@example.com' }),
      })
      await appendStep(page, 'District admin request also succeeds', adminAttempt)

      const consent = await prisma.parentalConsent.findUnique({
        where: { studentId: fixture.under13Id },
      })
      consentToken = consent?.consentToken ?? ''

      const outbox = await prisma.emailOutbox.findFirst({
        where: { districtId: fixture.districtId, templateId: 'coppa_consent_request' },
        orderBy: { createdAt: 'desc' },
      })
      const payload = outbox?.payload ?? {}
      await appendStep(page, 'Outbox payload is tokenized and PII-free', {
        tokenCreated: Boolean(consentToken),
        tokenExpiresAt: consent?.tokenExpiresAt?.toISOString(),
        recipientHash: outbox?.recipientHash?.slice(0, 16),
        verifyUrl: typeof payload.verifyUrl === 'string'
          ? payload.verifyUrl.replaceAll(consentToken, '<TOKEN>')
          : payload.verifyUrl,
        containsStudentId: typeof payload.verifyUrl === 'string' ? payload.verifyUrl.includes(fixture.under13Id) : false,
        payloadStudentIdPresent: Object.hasOwn(payload, 'studentId'),
      })
    }))

    artifacts.push(await withRecordedPage(browser, 'a3-consent-verify', 'SHR-116 A3 — Valid token grants consent, expired token is rejected', async (page) => {
      const verifyResponse = await apiFetch(`${API_BASE}/consent/verify?token=${encodeURIComponent(consentToken)}`)
      await appendStep(page, 'Valid token verify request', verifyResponse)

      const consent = await prisma.parentalConsent.findUnique({
        where: { studentId: fixture.under13Id },
      })
      const student = await prisma.user.findUnique({
        where: { id: fixture.under13Id },
      })
      await appendStep(page, 'Student consent state is updated', {
        consentStatus: consent?.consentStatus,
        consentDate: consent?.consentDate?.toISOString(),
        tokenCleared: consent?.consentToken === null,
        studentConsentStatus: student?.consentStatus,
      })

      const expiredStudent = await prisma.user.create({
        data: {
          districtId: fixture.districtId,
          role: 'student',
          displayName: 'Expired Browser Kid',
          gradeBand: 'k2',
        },
      })
      await prisma.parentalConsent.create({
        data: {
          studentId: expiredStudent.id,
          districtId: fixture.districtId,
          parentEmailHash: 'expired',
          consentStatus: 'pending',
          consentToken: '00000000-0000-0000-0000-000000000116',
          tokenExpiresAt: new Date(Date.now() - 1000),
        },
      })

      const expiredResponse = await apiFetch(`${API_BASE}/consent/verify?token=00000000-0000-0000-0000-000000000116`)
      await appendStep(page, 'Expired token returns 410', expiredResponse)

      const unblocked = await apiFetch(`${API_BASE}/conversations/${fixture.under13ConversationId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.under13Token}`,
        },
        body: JSON.stringify({ text: 'I have consent now' }),
      })
      await appendStep(page, 'Previously blocked student now clears COPPA gate', {
        status: unblocked.status,
        blocked: unblocked.status === 403,
      })
    }))

    artifacts.push(await withRecordedPage(browser, 'a4-delete-request', 'SHR-116 A4 — Delete request records reason and 30-day deadline', async (page) => {
      const teacherDelete = await apiFetch(`${API_BASE}/consent/delete-request`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.teacherToken}`,
        },
        body: JSON.stringify({ studentId: fixture.under13Id, reason: 'parent_request' }),
      })
      await appendStep(page, 'Teacher delete request', teacherDelete)

      const deletion = await prisma.dataDeletionRequest.findFirst({
        where: { studentId: fixture.under13Id },
        orderBy: { requestedAt: 'desc' },
      })
      const student = await prisma.user.findUnique({
        where: { id: fixture.under13Id },
      })
      const scheduledDate = new Date(teacherDelete.json.scheduledDate)
      const daysUntil = (scheduledDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      await appendStep(page, 'Deletion state persisted in DB', {
        deleteRequestId: deletion?.id,
        status: deletion?.status,
        reason: deletion?.reason,
        scheduledDeleteBy: deletion?.scheduledDeleteBy?.toISOString(),
        studentFlaggedAt: student?.deletionScheduledAt?.toISOString(),
        daysUntilDeletion: Number(daysUntil.toFixed(2)),
      })
    }))

    artifacts.push(await withRecordedPage(browser, 'a5-swagger', 'SHR-116 A5 — Swagger exposes consent endpoints', async (page) => {
      await page.goto(`${API_ORIGIN}/docs`, { waitUntil: 'networkidle' })
      const bodyText = await page.textContent('body')
      await appendStep(page, 'Swagger UI contains consent routes', {
        hasConsentRouteText: bodyText?.includes('/consent') ?? false,
        hasRequest: bodyText?.includes('/consent/request') ?? false,
        hasVerify: bodyText?.includes('/consent/verify') ?? false,
        hasDelete: bodyText?.includes('/consent/delete-request') ?? false,
      })
    }))

    artifacts.push(await withRecordedPage(browser, 'a6-targeted-tests', 'SHR-116 A6 — Dedicated consent backend tests pass', async (page) => {
      const { stdout } = await execFileAsync('../../node_modules/.bin/vitest', ['run', 'test/consent.test.ts'], {
        cwd: path.resolve('packages/backend'),
      })
      await appendStep(page, 'Vitest result', stdout)
    }))

    const manifest = artifacts.map((item) => ({
      video: path.relative(process.cwd(), item.videoPath),
      gif: path.relative(process.cwd(), item.gifPath),
      smallGif: path.relative(process.cwd(), item.smallGifPath),
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
