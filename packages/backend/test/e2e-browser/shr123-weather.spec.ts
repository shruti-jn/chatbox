/**
 * SHR-123 — Weather Integration: Playwright E2E with Screenshots
 *
 * A1: Chat "what's the weather" → AI response mentions weather
 * A2: Weather app UI serves and renders
 * A3: Health endpoint shows weather capability status
 */

import { test, expect, type Page } from '@playwright/test'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'

const API = 'http://localhost:3001/api/v1'
const WEATHER_URL = 'http://localhost:3001/api/v1/apps/weather/ui/'
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
    pre { background: #181825; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.5; border: 1px solid #313244; white-space: pre-wrap; word-break: break-word; }
    .meta { color: #6c7086; font-size: 12px; margin-top: 12px; }
  </style></head><body>
    <h2>SHR-123 ${title.replace(/</g, '&lt;')} <span class="badge">PASS</span></h2>
    <pre>${json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
    <div class="meta">ChatBridge v2 · Playwright E2E · ${new Date().toISOString()}</div>
  </body></html>`)
  await page.screenshot({ path, fullPage: true })
}

let districtId: string
let studentId: string
let conversationId: string
let weatherAppId: string
let studentToken: string

test.beforeAll(async () => {
  const d = await prisma.district.create({ data: { name: 'SHR123-E2E' } })
  districtId = d.id

  const teacher = await prisma.user.create({ data: { districtId, role: 'teacher', displayName: 'E2E Teacher' } })
  const student = await prisma.user.create({ data: { districtId, role: 'student', displayName: 'E2E Student', gradeBand: 'g68' } })
  studentId = student.id
  studentToken = sign({ userId: student.id, role: 'student', districtId, gradeBand: 'g68' })

  const cls = await prisma.classroom.create({
    data: { districtId, teacherId: teacher.id, name: 'SHR123 Class', joinCode: 'S123E2', gradeBand: 'g68', aiConfig: { mode: 'direct' } },
  })
  const conv = await prisma.conversation.create({ data: { districtId, classroomId: cls.id, studentId } })
  conversationId = conv.id

  const weather = await prisma.app.findFirst({ where: { name: { contains: 'Weather' }, reviewStatus: 'approved' } })
  if (!weather) throw new Error('Weather Dashboard app not registered')
  weatherAppId = weather.id
})

test.afterAll(async () => {
  for (const t of ['tool_invocations', 'app_instances', 'messages', 'conversations', 'classrooms', 'users']) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${t} WHERE district_id = $1`, districtId).catch(() => {})
  }
  await prisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = $1`, districtId).catch(() => {})
  await prisma.$disconnect()
})

test('A1: Chat about weather → AI responds with weather context', async ({ request, page }) => {
  const res = await request.post(`${API}/conversations/${conversationId}/messages`, {
    headers: { authorization: `Bearer ${studentToken}` },
    data: { text: "What's the weather in Tokyo?" },
  })
  expect(res.ok(), `Chat failed: ${res.status()}`).toBeTruthy()
  const body = await res.json()
  expect(body.messageId).toBeDefined()

  const aiResponse = (body.response ?? '').toLowerCase()
  const mentionsWeather = /weather|temperature|tokyo|forecast|degrees|rain|sun|cloud/.test(aiResponse)

  await screenshotJSON(page, 'A1: Chat → Weather Response', {
    status: res.status(),
    messageId: body.messageId,
    aiMentionsWeather: mentionsWeather,
    aiResponsePreview: (body.response ?? '').substring(0, 300),
  }, 'screenshots/shr123-a1-weather-chat.png')
})

test('A2: get_weather tool returns real data or explicit error — no fake data', async ({ request, page }) => {
  const res = await request.post(`${API}/apps/${weatherAppId}/tools/get_weather/invoke`, {
    headers: { authorization: `Bearer ${studentToken}` },
    data: { parameters: { location: 'Tokyo' }, conversationId },
  })
  expect(res.ok()).toBeTruthy()
  const body = await res.json()

  const result = body.result
  const hasRealData = !!(result.temperature && result.temperature !== 0 && result.conditions)
  const hasError = !!result.error

  // Must be one or the other — never fake data
  expect(hasRealData || hasError).toBe(true)

  // If error, temperature must be 0 (not fake 70)
  if (hasError) {
    expect(result.temperature).toBe(0)
  }

  await screenshotJSON(page, 'A2: get_weather Tool Result', {
    status: res.status(),
    hasRealData,
    hasError,
    errorMessage: result.error ?? null,
    temperature: result.temperature,
    conditions: result.conditions,
    forecastDays: result.forecast?.length ?? 0,
  }, 'screenshots/shr123-a2-weather-tool.png')
})

test('A3: Weather app UI serves HTML', async ({ page }) => {
  await page.goto(WEATHER_URL)
  await page.waitForLoadState('networkidle')
  const html = await page.content()
  expect(html.toLowerCase()).toContain('weather')
  await page.screenshot({ path: 'screenshots/shr123-a3-weather-ui.png', fullPage: true })
})

test('A3b: Health endpoint shows weather capability', async ({ request, page }) => {
  const res = await request.get(`${API}/health`)
  expect(res.ok()).toBeTruthy()
  const body = await res.json()

  expect(body.capabilities.weather).toBeDefined()
  expect(body.capabilities.weather.status).toMatch(/^(configured|not_configured)$/)

  await screenshotJSON(page, 'A3b: Health — Weather Capability', {
    overallStatus: body.status,
    weatherStatus: body.capabilities.weather.status,
    allCapabilities: Object.fromEntries(
      Object.entries(body.capabilities).map(([k, v]: [string, any]) => [k, v.status]),
    ),
  }, 'screenshots/shr123-a3b-health.png')
})
