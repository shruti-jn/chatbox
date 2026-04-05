/**
 * SHR-116 — Consent Routes: Playwright E2E with Screenshots
 *
 * A1: Under-13 gate blocks chat without consent
 * A2: POST /consent/request queues email with tokenized link
 * A3: GET /consent/verify grants consent (valid token) / 410 (expired)
 * A4: POST /consent/delete-request creates record with 30-day deadline
 * A5: Swagger UI shows consent endpoints
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
    pre { background: #181825; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.5; border: 1px solid #313244; }
    .meta { color: #6c7086; font-size: 12px; margin-top: 12px; }
  </style></head><body>
    <h2>SHR-116 ${title.replace(/</g, '&lt;')} <span class="badge">PASS</span></h2>
    <pre>${json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
    <div class="meta">ChatBridge v2 · Playwright E2E · ${new Date().toISOString()}</div>
  </body></html>`)
  await page.screenshot({ path, fullPage: true })
}

let districtId: string
let teacherId: string
let under13Id: string
let over13Id: string
let classroomId: string
let conversationId: string
let teacherToken: string
let under13Token: string
let over13Token: string

test.beforeAll(async () => {
  const d = await prisma.district.create({ data: { name: 'SHR116-E2E' } })
  districtId = d.id

  const teacher = await prisma.user.create({ data: { districtId, role: 'teacher', displayName: 'E2E Teacher' } })
  teacherId = teacher.id
  teacherToken = sign({ userId: teacher.id, role: 'teacher', districtId })

  const kid = await prisma.user.create({ data: { districtId, role: 'student', displayName: 'Young Kid', gradeBand: 'k2' } })
  under13Id = kid.id
  under13Token = sign({ userId: kid.id, role: 'student', districtId, gradeBand: 'k2' })

  const teen = await prisma.user.create({ data: { districtId, role: 'student', displayName: 'Older Teen', gradeBand: 'g68' } })
  over13Id = teen.id
  over13Token = sign({ userId: teen.id, role: 'student', districtId, gradeBand: 'g68' })

  const cls = await prisma.classroom.create({
    data: { districtId, teacherId, name: 'SHR116 Class', joinCode: 'S116E2', gradeBand: 'g68', aiConfig: { mode: 'direct' } },
  })
  classroomId = cls.id

  const conv = await prisma.conversation.create({ data: { districtId, classroomId, studentId: under13Id } })
  conversationId = conv.id
})

test.afterAll(async () => {
  for (const t of ['email_outbox', 'data_deletion_requests', 'parental_consents', 'messages', 'conversations', 'classrooms', 'users']) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${t} WHERE district_id = '${districtId}'`).catch(() => {})
  }
  await prisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = '${districtId}'`).catch(() => {})
  await prisma.$disconnect()
})

// ── A1: Under-13 gate ────────────────────────────────────────────────

test('A1: Under-13 blocked without consent, over-13 not blocked', async ({ request, page }) => {
  // Under-13 → 403
  const blocked = await request.post(`${API}/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${under13Token}` },
    data: { text: 'Hello' },
  })
  expect(blocked.status()).toBe(403)
  const blockedBody = await blocked.json()
  expect(blockedBody.error).toBe('parental_consent_required')
  expect(blockedBody.consentUrl).toContain('/api/v1/consent/request')

  // Over-13 → not 403
  const conv2 = await prisma.conversation.create({ data: { districtId, classroomId, studentId: over13Id } })
  const allowed = await request.post(`${API}/conversations/${conv2.id}/messages`, {
    headers: { authorization: `Bearer ${over13Token}` },
    data: { text: 'Hello' },
  })
  expect(allowed.status()).not.toBe(403)

  await screenshotJSON(page, 'A1: Under-13 Gate', {
    under13: { status: blocked.status(), error: blockedBody.error },
    over13: { status: allowed.status(), blocked: false },
  }, 'screenshots/shr116-a1-under13-gate.png')
})

// ── A2: POST /consent/request ────────────────────────────────────────

let consentToken: string

test('A2: POST /consent/request queues email with tokenized link', async ({ request, page }) => {
  const res = await request.post(`${API}/consent/request`, {
    headers: { authorization: `Bearer ${teacherToken}` },
    data: { studentId: under13Id, parentEmail: 'parent@example.com' },
  })
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.status).toBe('consent_request_sent')

  // Check DB: token created, email queued
  const consent = await prisma.parentalConsent.findUnique({ where: { studentId: under13Id } })
  expect(consent).not.toBeNull()
  expect(consent!.consentToken).toBeDefined()
  consentToken = consent!.consentToken!

  const outbox = await prisma.emailOutbox.findFirst({ where: { districtId, templateId: 'coppa_consent_request' } })
  expect(outbox).not.toBeNull()
  expect(outbox!.recipientHash).not.toContain('@') // No PII

  const payload = outbox!.payload as Record<string, unknown>
  expect(payload.verifyUrl).toContain('/consent/verify?token=')
  expect(payload.verifyUrl).not.toContain('parent@example.com')
  expect(payload.verifyUrl).not.toContain(under13Id)
  expect(payload.studentId).toBeUndefined()

  await screenshotJSON(page, 'A2: Consent Request — Email Queued', {
    response: body,
    tokenCreated: !!consent!.consentToken,
    tokenExpires: consent!.tokenExpiresAt,
    emailQueued: { templateId: outbox!.templateId, recipientHash: outbox!.recipientHash?.substring(0, 16) + '…', noPII: true },
    verifyUrlSample: (payload.verifyUrl as string).replace(consentToken, '<TOKEN>'),
  }, 'screenshots/shr116-a2-consent-request.png')
})

// ── A3: GET /consent/verify ──────────────────────────────────────────

test('A3: Valid token grants consent, expired token → 410', async ({ request, page }) => {
  // Valid token
  const valid = await request.get(`${API}/consent/verify?token=${consentToken}`)
  expect(valid.status()).toBe(200)
  const validBody = await valid.json()
  expect(validBody.status).toBe('consent_granted')
  expect(validBody.studentId).toBe(under13Id)

  // Verify DB: consent granted, token cleared
  const consent = await prisma.parentalConsent.findUnique({ where: { studentId: under13Id } })
  expect(consent!.consentStatus).toBe('granted')
  expect(consent!.consentToken).toBeNull()
  const student = await prisma.user.findUnique({ where: { id: under13Id } })
  expect(student!.consentStatus).toBe('granted')

  // Expired token
  const expiredUser = await prisma.user.create({ data: { districtId, role: 'student', displayName: 'Expired Kid', gradeBand: 'k2' } })
  await prisma.parentalConsent.create({
    data: {
      studentId: expiredUser.id, districtId, parentEmailHash: 'expired',
      consentStatus: 'pending', consentToken: '00000000-0000-0000-0000-000000000077',
      tokenExpiresAt: new Date(Date.now() - 1000),
    },
  })
  const expired = await request.get(`${API}/consent/verify?token=00000000-0000-0000-0000-000000000077`)
  expect(expired.status()).toBe(410)

  await screenshotJSON(page, 'A3: Consent Verify — Token Flow', {
    validToken: { status: valid.status(), body: validBody },
    dbAfterGrant: { consentStatus: 'granted', tokenCleared: consent!.consentToken === null },
    expiredToken: { status: expired.status(), body: await expired.json() },
  }, 'screenshots/shr116-a3-consent-verify.png')
})

// ── A3 continued: student can now access chat ────────────────────────

test('A3b: Under-13 WITH consent can access chat', async ({ request, page }) => {
  const res = await request.post(`${API}/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${under13Token}` },
    data: { text: 'I have consent now' },
  })
  expect(res.status()).not.toBe(403)

  await screenshotJSON(page, 'A3b: Under-13 Unblocked After Consent', {
    status: res.status(),
    wasBlocked: false,
    evidence: 'Same student that got 403 in A1 now passes COPPA gate',
  }, 'screenshots/shr116-a3b-unblocked.png')
})

// ── A4: POST /consent/delete-request ─────────────────────────────────

test('A4: Delete request with 30-day deadline', async ({ request, page }) => {
  const res = await request.post(`${API}/consent/delete-request`, {
    headers: { authorization: `Bearer ${teacherToken}` },
    data: { studentId: under13Id, reason: 'parent_request' },
  })
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.deleteRequestId).toBeDefined()
  expect(body.scheduledDate).toBeDefined()

  const scheduled = new Date(body.scheduledDate)
  const daysUntil = (scheduled.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  expect(daysUntil).toBeGreaterThan(29)
  expect(daysUntil).toBeLessThanOrEqual(31)

  const deletion = await prisma.dataDeletionRequest.findFirst({ where: { studentId: under13Id } })
  const student = await prisma.user.findUnique({ where: { id: under13Id } })

  await screenshotJSON(page, 'A4: Data Deletion Request — 30-Day Deadline', {
    response: body,
    daysUntilDeletion: Math.round(daysUntil),
    verification: {
      hasId: !!body.deleteRequestId,
      hasSchedule: !!body.scheduledDate,
      within30Days: true,
      reason: deletion?.reason,
      studentFlagged: !!student?.deletionScheduledAt,
    },
  }, 'screenshots/shr116-a4-delete-request.png')
})

// ── A5: Swagger UI ───────────────────────────────────────────────────

test('A5: Swagger UI shows consent endpoints', async ({ page }) => {
  await page.goto('http://localhost:3001/docs')
  await page.waitForLoadState('networkidle')
  await page.waitForSelector('.swagger-ui', { timeout: 10000 })

  const text = await page.textContent('body')
  expect(text).toContain('/consent')

  await page.screenshot({ path: 'screenshots/shr116-a5-swagger.png', fullPage: true })
})
