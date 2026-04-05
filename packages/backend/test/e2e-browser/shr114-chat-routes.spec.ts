/**
 * SHR-114 — Chat Routes: Playwright E2E with Screenshots
 *
 * Behavioral assertions:
 * A1: POST /conversations/{id}/messages — full flow safety → AI → stored response
 * A2: GET /conversations/{id}/messages — paginated with cursor, role-filtered
 * A3: Conversation CRUD — create, list, get single, tenant isolation
 * A4: App cards in message history as content parts
 * A5: Swagger UI screenshot showing chat endpoints
 */

import { test, expect, type Page } from '@playwright/test'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'

const API = 'http://localhost:3001/api/v1'
const JWT_SECRET = process.env.JWT_SECRET_KEY ?? 'dev-secret-change-in-production'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://chatbridge:chatbridge_dev@localhost:5433/chatbridge'

// Use owner-level Prisma (bypasses RLS) for test fixture setup/teardown
const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })

// ── Helpers ──────────────────────────────────────────────────────────

function signTestJWT(payload: Record<string, unknown>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' })
}

/** Render a JSON response as styled HTML and screenshot it */
async function screenshotJSON(page: Page, title: string, data: unknown, path: string) {
  const json = JSON.stringify(data, null, 2)
  await page.setContent(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: 'SF Mono', 'Fira Code', monospace; background: #1e1e2e; color: #cdd6f4; padding: 24px; margin: 0; }
        h2 { color: #89b4fa; font-size: 16px; margin-bottom: 12px; border-bottom: 1px solid #45475a; padding-bottom: 8px; }
        .badge { display: inline-block; background: #a6e3a1; color: #1e1e2e; font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; margin-left: 8px; }
        pre { background: #181825; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.5; border: 1px solid #313244; }
        .meta { color: #6c7086; font-size: 12px; margin-top: 12px; }
      </style>
    </head>
    <body>
      <h2>SHR-114 ${title} <span class="badge">PASS</span></h2>
      <pre>${escapeHtml(json)}</pre>
      <div class="meta">ChatBridge v2 · Playwright E2E · ${new Date().toISOString()}</div>
    </body>
    </html>
  `)
  await page.screenshot({ path, fullPage: true })
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── Test data ────────────────────────────────────────────────────────

let districtAId: string
let districtBId: string
let studentAId: string
let teacherAId: string
let studentBId: string
let classroomId: string
let conversationId: string
let studentAToken: string
let teacherAToken: string
let studentBToken: string

test.beforeAll(async () => {
  // Create two districts for tenant isolation test
  const dA = await prisma.district.create({ data: { name: 'SHR114-E2E-A' } })
  districtAId = dA.id
  const dB = await prisma.district.create({ data: { name: 'SHR114-E2E-B' } })
  districtBId = dB.id

  // Users in District A
  const sA = await prisma.user.create({
    data: { districtId: districtAId, role: 'student', displayName: 'E2E Student A', gradeBand: 'g68' },
  })
  studentAId = sA.id

  const tA = await prisma.user.create({
    data: { districtId: districtAId, role: 'teacher', displayName: 'E2E Teacher A' },
  })
  teacherAId = tA.id

  // User in District B (for tenant isolation)
  const sB = await prisma.user.create({
    data: { districtId: districtBId, role: 'student', displayName: 'E2E Student B', gradeBand: 'g68' },
  })
  studentBId = sB.id

  // Classroom + conversation in District A
  const cls = await prisma.classroom.create({
    data: {
      districtId: districtAId, teacherId: teacherAId,
      name: 'SHR114 E2E Class', joinCode: 'E2E114', gradeBand: 'g68',
      aiConfig: { mode: 'direct' },
    },
  })
  classroomId = cls.id

  const conv = await prisma.conversation.create({
    data: { districtId: districtAId, classroomId, studentId: studentAId },
  })
  conversationId = conv.id

  // COPPA consent not needed — g68 grade band is exempt (COPPA only applies to k2/g35)

  // JWTs
  studentAToken = signTestJWT({ userId: studentAId, role: 'student', districtId: districtAId, gradeBand: 'g68' })
  teacherAToken = signTestJWT({ userId: teacherAId, role: 'teacher', districtId: districtAId })
  studentBToken = signTestJWT({ userId: studentBId, role: 'student', districtId: districtBId, gradeBand: 'g68' })
})

test.afterAll(async () => {
  // Cleanup in dependency order using raw SQL to bypass RLS
  for (const table of ['audit_events', 'safety_events', 'messages', 'conversations', 'classrooms', 'users']) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE district_id IN ($1, $2)`, districtAId, districtBId).catch(() => {})
  }
  await prisma.$executeRawUnsafe(`DELETE FROM districts WHERE id IN ($1, $2)`, districtAId, districtBId).catch(() => {})
  await prisma.$disconnect()
})

// ── A1: POST /conversations/{id}/messages ────────────────────────────

test('A1: POST message — full flow safety → AI → stored response', async ({ request, page }) => {
  const res = await request.post(`${API}/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${studentAToken}` },
    data: { text: 'What is 2 + 2?' },
  })

  expect(res.ok(), `Expected 200, got ${res.status()}`).toBeTruthy()
  const body = await res.json()

  // Verify response shape
  expect(body.messageId).toBeDefined()
  expect(body.aiMessageId).toBeDefined()
  expect(body.response).toBeDefined()
  expect(body.response.length).toBeGreaterThan(0)

  // Verify both messages in DB
  const dbMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  })
  const roles = dbMessages.map(m => m.authorRole)
  expect(roles).toContain('student')
  expect(roles).toContain('assistant')

  await screenshotJSON(page, 'A1: POST /messages — Full Round-Trip', {
    status: res.status(),
    response: body,
    dbMessages: dbMessages.map(m => ({ id: m.id, role: m.authorRole })),
  }, 'screenshots/shr114-a1-post-message.png')
})

// ── A2: GET /conversations/{id}/messages — pagination + role filter ──

test('A2: GET messages — paginated, whisper-filtered', async ({ request, page }) => {
  // Seed: add a teacher whisper + extra messages for pagination
  await prisma.message.create({
    data: {
      conversationId, districtId: districtAId, authorRole: 'teacher_whisper',
      contentParts: [{ type: 'text', text: 'Guide toward fractions' }],
    },
  })
  for (let i = 0; i < 5; i++) {
    await prisma.message.create({
      data: {
        conversationId, districtId: districtAId, authorRole: 'student',
        contentParts: [{ type: 'text', text: `Pagination msg ${i}` }],
      },
    })
  }

  // Student GET — should NOT see whispers
  const studentRes = await request.get(
    `${API}/conversations/${conversationId}/messages?limit=50`,
    { headers: { authorization: `Bearer ${studentAToken}` } },
  )
  expect(studentRes.ok()).toBeTruthy()
  const studentBody = await studentRes.json()
  const studentWhispers = studentBody.messages.filter((m: any) => m.authorRole === 'teacher_whisper')
  expect(studentWhispers).toHaveLength(0)

  // Teacher GET — SHOULD see whispers
  const teacherRes = await request.get(
    `${API}/conversations/${conversationId}/messages?limit=50`,
    { headers: { authorization: `Bearer ${teacherAToken}` } },
  )
  const teacherBody = await teacherRes.json()
  const teacherWhispers = teacherBody.messages.filter((m: any) => m.authorRole === 'teacher_whisper')
  expect(teacherWhispers.length).toBeGreaterThanOrEqual(1)

  // Pagination: limit=3
  const paginatedRes = await request.get(
    `${API}/conversations/${conversationId}/messages?limit=3`,
    { headers: { authorization: `Bearer ${studentAToken}` } },
  )
  const paginatedBody = await paginatedRes.json()
  expect(paginatedBody.messages.length).toBeLessThanOrEqual(3)
  expect(paginatedBody.hasMore).toBe(true)

  await screenshotJSON(page, 'A2: GET /messages — Pagination + Whisper Filter', {
    studentMessageCount: studentBody.messages.length,
    studentWhisperCount: 0,
    teacherMessageCount: teacherBody.messages.length,
    teacherWhisperCount: teacherWhispers.length,
    paginationTest: { limit: 3, returned: paginatedBody.messages.length, hasMore: paginatedBody.hasMore },
  }, 'screenshots/shr114-a2-get-messages.png')
})

// ── A3: Conversation CRUD + tenant isolation ─────────────────────────

test('A3: Conversation CRUD — create, list, get, tenant isolation', async ({ request, page }) => {
  // CREATE
  const createRes = await request.post(`${API}/conversations`, {
    headers: { authorization: `Bearer ${studentAToken}` },
    data: { classroomId, title: 'E2E Created Conversation' },
  })
  expect(createRes.status()).toBe(201)
  const created = await createRes.json()
  expect(created.id).toBeDefined()
  expect(created.classroomId).toBe(classroomId)

  // LIST
  const listRes = await request.get(
    `${API}/conversations?classroomId=${classroomId}`,
    { headers: { authorization: `Bearer ${studentAToken}` } },
  )
  expect(listRes.ok()).toBeTruthy()
  const listed = await listRes.json()
  expect(listed.conversations.length).toBeGreaterThanOrEqual(1)
  const ids = listed.conversations.map((c: any) => c.id)
  expect(ids).toContain(created.id)

  // GET SINGLE (the new route)
  const getRes = await request.get(
    `${API}/conversations/${created.id}`,
    { headers: { authorization: `Bearer ${studentAToken}` } },
  )
  expect(getRes.ok()).toBeTruthy()
  const single = await getRes.json()
  expect(single.id).toBe(created.id)
  expect(single.title).toBe('E2E Created Conversation')
  expect(typeof single.messageCount).toBe('number')

  // 404 for non-existent
  const notFoundRes = await request.get(
    `${API}/conversations/00000000-0000-0000-0000-000000000000`,
    { headers: { authorization: `Bearer ${studentAToken}` } },
  )
  expect(notFoundRes.status()).toBe(404)

  // TENANT ISOLATION — District B student sees nothing from District A
  const isolationRes = await request.get(
    `${API}/conversations?classroomId=${classroomId}`,
    { headers: { authorization: `Bearer ${studentBToken}` } },
  )
  expect(isolationRes.ok()).toBeTruthy()
  const isolated = await isolationRes.json()
  expect(isolated.conversations).toHaveLength(0)

  await screenshotJSON(page, 'A3: Conversation CRUD + Tenant Isolation', {
    created: { id: created.id, classroomId: created.classroomId, title: created.title },
    listed: { count: listed.conversations.length, hasCreatedId: ids.includes(created.id) },
    getSingle: { id: single.id, title: single.title, messageCount: single.messageCount },
    notFound: { status: 404 },
    tenantIsolation: { districtBSees: isolated.conversations.length, expected: 0, isolated: true },
  }, 'screenshots/shr114-a3-conversation-crud.png')
})

// ── A4: App cards in message history ─────────────────────────────────

test('A4: App-card content parts stored and retrieved in history', async ({ request, page }) => {
  // Insert message with app-card content part
  const instanceId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  await prisma.message.create({
    data: {
      conversationId, districtId: districtAId, authorRole: 'assistant',
      contentParts: [
        { type: 'text', text: 'Here is the chess board:' },
        { type: 'app-card', appName: 'chess', instanceId, status: 'active', url: '/api/v1/apps/chess/ui/', height: 500 },
      ],
    },
  })

  // Retrieve via GET history
  const res = await request.get(
    `${API}/conversations/${conversationId}/messages?limit=100`,
    { headers: { authorization: `Bearer ${studentAToken}` } },
  )
  expect(res.ok()).toBeTruthy()
  const body = await res.json()

  // Find the app-card message
  const appMsg = body.messages.find((m: any) =>
    Array.isArray(m.contentParts) &&
    m.contentParts.some((p: any) => p.type === 'app-card'),
  )
  expect(appMsg).toBeDefined()

  const appPart = appMsg.contentParts.find((p: any) => p.type === 'app-card')
  expect(appPart.appName).toBe('chess')
  expect(appPart.instanceId).toMatch(/^[0-9a-f]{8}-/)
  expect(appPart.status).toBe('active')
  expect(appPart.height).toBe(500)

  await screenshotJSON(page, 'A4: App-Card Content Parts in History', {
    messageId: appMsg.id,
    contentParts: appMsg.contentParts,
    validation: {
      appName: appPart.appName,
      instanceIdValid: /^[0-9a-f]{8}-/.test(appPart.instanceId),
      status: appPart.status,
      height: appPart.height,
    },
  }, 'screenshots/shr114-a4-app-card-history.png')
})

// ── A5: Swagger UI screenshot ────────────────────────────────────────

test('A5: Swagger UI shows chat endpoints', async ({ page }) => {
  await page.goto('http://localhost:3001/docs')
  await page.waitForLoadState('networkidle')

  // Wait for Swagger UI to render
  await page.waitForSelector('.swagger-ui', { timeout: 10000 })

  await page.screenshot({ path: 'screenshots/shr114-a5-swagger-ui.png', fullPage: true })

  // Verify chat-related endpoints exist in the page
  const pageText = await page.textContent('body')
  expect(pageText).toContain('/conversations')
})
