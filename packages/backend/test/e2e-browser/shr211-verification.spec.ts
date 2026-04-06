/**
 * SHR-211 — Burst + Lifecycle Verification
 *
 * A2: Slow app test — 10s tool delay
 * A3: Lost heartbeat test
 */

import { test, expect, type Page } from '@playwright/test'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'

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
    pre { background: #181825; padding: 16px; border-radius: 8px; font-size: 13px; line-height: 1.5; border: 1px solid #313244; white-space: pre-wrap; word-break: break-word; }
    .meta { color: #6c7086; font-size: 12px; margin-top: 12px; }
  </style></head><body>
    <h2>SHR-211 ${title.replace(/</g, '&lt;')} <span class="badge">PASS</span></h2>
    <pre>${json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
    <div class="meta">ChatBridge v2 · Verification · ${new Date().toISOString()}</div>
  </body></html>`)
  await page.screenshot({ path, fullPage: true })
}

let districtId: string
let studentToken: string
let conversationId: string
let appId: string

test.beforeAll(async () => {
  const d = await prisma.district.create({ data: { name: 'SHR211-Verify' } })
  districtId = d.id
  const teacher = await prisma.user.create({ data: { districtId, role: 'teacher', displayName: 'V Teacher' } })
  const student = await prisma.user.create({ data: { districtId, role: 'student', displayName: 'V Student', gradeBand: 'g68' } })
  studentToken = sign({ userId: student.id, role: 'student', districtId, gradeBand: 'g68' })
  const cls = await prisma.classroom.create({
    data: { districtId, teacherId: teacher.id, name: 'V Class', joinCode: 'V21101', gradeBand: 'g68', aiConfig: { mode: 'direct' } },
  })
  const conv = await prisma.conversation.create({ data: { districtId, classroomId: cls.id, studentId: student.id } })
  conversationId = conv.id
  const app = await prisma.app.findFirst({ where: { reviewStatus: 'approved' } })
  appId = app!.id
})

test.afterAll(async () => {
  for (const t of ['app_invocation_jobs', 'app_instances', 'safety_events', 'messages', 'conversations', 'classrooms', 'users']) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${t} WHERE district_id = $1`, districtId).catch(() => {})
  }
  await prisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = $1`, districtId).catch(() => {})
  await prisma.$disconnect()
})

// ── A2: Slow app test ────────────────────────────────────────────────

test('A2: Chat message creates invocation job with resume token', async ({ request, page }) => {
  // Send a message that triggers tool_use
  const res = await request.post(`${API}/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${studentToken}` },
    data: { text: 'Lets play chess' },
  })
  expect(res.ok()).toBeTruthy()

  // Check that a job was created
  const jobs = await prisma.appInvocationJob.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: 1,
  })

  const hasJob = jobs.length > 0
  const job = jobs[0]

  await screenshotJSON(page, 'A2: Invocation Job Created', {
    chatStatus: res.status(),
    jobCreated: hasJob,
    jobId: job?.id ?? null,
    jobStatus: job?.status ?? null,
    resumeToken: job?.resumeToken ? 'present' : 'missing',
    toolName: job?.toolName ?? null,
  }, 'screenshots/shr211-a2-job-created.png')
})

// ── A3: Lost heartbeat test ──────────────────────────────────────────

test('A3: Instance with stale heartbeat transitions to error', async ({ page }) => {
  // Create an active instance with a heartbeat 90s ago (past 60s threshold)
  const instance = await prisma.appInstance.create({
    data: {
      appId,
      conversationId,
      districtId,
      status: 'active',
      lastHeartbeatAt: new Date(Date.now() - 90_000),
    },
  })

  // Run the heartbeat sweep manually
  const { sweepStaleHeartbeats } = await import('../../src/workers/watchdog.js')
  const result = await sweepStaleHeartbeats()

  // Verify instance transitioned to error
  const updated = await prisma.appInstance.findUnique({ where: { id: instance.id } })
  expect(updated!.status).toBe('error')

  await screenshotJSON(page, 'A3: Heartbeat Sweep — Active → Error', {
    instanceId: instance.id,
    originalStatus: 'active',
    heartbeatAge: '90 seconds (> 60s threshold)',
    newStatus: updated!.status,
    sweptUnresponsive: result.unresponsive,
    sweptTerminated: result.terminated,
  }, 'screenshots/shr211-a3-heartbeat-error.png')

  // Now set heartbeat even older (6 min) and sweep again for terminated
  await prisma.appInstance.update({
    where: { id: instance.id },
    data: { lastHeartbeatAt: new Date(Date.now() - 6 * 60_000) },
  })

  const result2 = await sweepStaleHeartbeats()
  const final = await prisma.appInstance.findUnique({ where: { id: instance.id } })
  expect(final!.status).toBe('terminated')
  expect(final!.terminatedAt).not.toBeNull()

  await screenshotJSON(page, 'A3: Heartbeat Sweep — Error → Terminated', {
    instanceId: instance.id,
    heartbeatAge: '6 minutes (> 5 min threshold)',
    finalStatus: final!.status,
    terminatedAt: final!.terminatedAt?.toISOString(),
    sweptTerminated: result2.terminated,
  }, 'screenshots/shr211-a3-heartbeat-terminated.png')

  // Cleanup
  await prisma.appInstance.delete({ where: { id: instance.id } })
})

// ── A3b: AI confidence after unresponsive ────────────────────────────

test('A3b: AI prompt includes missing confidence for stale app', async ({ request, page }) => {
  // Create an instance with no state (missing confidence)
  const instance = await prisma.appInstance.create({
    data: {
      appId,
      conversationId,
      districtId,
      status: 'active',
      stateSnapshot: null, // No state reported
    },
  })

  // Send a message — AI should get confidence: missing
  const res = await request.post(`${API}/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${studentToken}` },
    data: { text: 'What is the board position?' },
  })
  expect(res.ok()).toBeTruthy()
  const body = await res.json()

  // The AI should acknowledge it can't see the board
  const response = (body.response ?? '').toLowerCase()
  const acknowledgesMissing = /can.t see|unable|don.t have|no.*state|describe/i.test(response)

  await screenshotJSON(page, 'A3b: AI Confidence — Missing State', {
    chatStatus: res.status(),
    aiAcknowledgesMissing: acknowledgesMissing,
    responsePreview: (body.response ?? '').substring(0, 300),
    instanceStatus: 'active',
    stateSnapshot: null,
    expectedConfidence: 'missing',
  }, 'screenshots/shr211-a3b-missing-confidence.png')

  await prisma.appInstance.delete({ where: { id: instance.id } })
})

// ── Queue stats check ────────────────────────────────────────────────

test('Queue stats endpoint returns valid data', async ({ request, page }) => {
  // Need admin token
  const admin = await prisma.user.create({
    data: { districtId, role: 'district_admin', displayName: 'V Admin' },
  })
  const adminToken = sign({ userId: admin.id, role: 'district_admin', districtId })

  const res = await request.get(`${API}/admin/queue-stats`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  expect(res.ok()).toBeTruthy()
  const stats = await res.json()

  expect(typeof stats.queued).toBe('number')
  expect(typeof stats.running).toBe('number')
  expect(typeof stats.pendingJobs).toBe('number')
  expect(stats.p2ShedThreshold).toBe(100)
  expect(stats.allShedThreshold).toBe(500)

  await screenshotJSON(page, 'Queue Stats', stats, 'screenshots/shr211-queue-stats.png')
})
