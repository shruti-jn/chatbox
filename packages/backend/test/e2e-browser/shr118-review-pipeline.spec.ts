/**
 * SHR-118 — Automated App Review Pipeline: Playwright E2E with Screenshots
 *
 * A1: 5-stage review pipeline runs and returns structured stage results
 * A2: External script fails security scan and blocks approval
 * A3: Clean app passes all stages and review result is stored
 * A5: Single a11y failure blocks approval while other stages pass
 */

import { test, expect, type Page } from '@playwright/test'
import jwt from 'jsonwebtoken'
import { PrismaClient } from '@prisma/client'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

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
    <h2>SHR-118 ${title.replace(/</g, '&lt;')} <span class="badge">PASS</span></h2>
    <pre>${json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
    <div class="meta">ChatBridge v2 · Playwright E2E · ${new Date().toISOString()}</div>
  </body></html>`)
  await page.screenshot({ path, fullPage: true })
}

async function makeHtmlServer(html: string): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return { server, url: `http://127.0.0.1:${port}/index.html` }
}

let districtId: string
let teacherToken: string

test.beforeAll(async () => {
  const district = await prisma.district.create({ data: { name: 'SHR118-E2E' } })
  districtId = district.id

  const teacher = await prisma.user.create({
    data: { districtId, role: 'teacher', displayName: 'SHR118 Teacher' },
  })
  teacherToken = sign({ userId: teacher.id, role: 'teacher', districtId })
})

test.afterAll(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM apps WHERE name LIKE 'SHR118 %'`).catch(() => {})
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE district_id = $1`, districtId).catch(() => {})
  await prisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = $1`, districtId).catch(() => {})
  await prisma.$disconnect()
})

test('A1: Review returns 5 structured stages in sequence', async ({ request, page }) => {
  const registerRes = await request.post(`${API}/apps/register`, {
    headers: { authorization: `Bearer ${teacherToken}` },
    data: {
      name: `SHR118 Clean ${Date.now()}`,
      description: 'Clean review app',
      toolDefinitions: [
        { name: 'start', description: 'Start action', inputSchema: { type: 'object' } },
      ],
      uiManifest: { url: 'https://clean.chatbridge.app', width: 400, height: 300 },
      permissions: { network: false },
      complianceMetadata: {},
      version: '1.0.0',
    },
  })
  expect(registerRes.status()).toBe(201)
  const { appId } = await registerRes.json()

  const reviewRes = await request.post(`${API}/apps/${appId}/submit-review`, {
    headers: { authorization: `Bearer ${teacherToken}` },
  })
  expect(reviewRes.status()).toBe(202)
  const body = await reviewRes.json()

  expect(body.reviewResults.stages).toHaveLength(5)
  expect(body.reviewResults.stages.map((s: any) => s.stage)).toEqual([
    'schema_validation',
    'security_scan',
    'content_check',
    'accessibility',
    'performance',
  ])

  await screenshotJSON(page, 'A1: Five Structured Stages', {
    status: reviewRes.status(),
    overallStatus: body.reviewResults.overallStatus,
    stages: body.reviewResults.stages,
  }, 'screenshots/shr118-a1-five-stages.png')
})

test('A2: External script fails security scan', async ({ request, page }) => {
  const { server, url } = await makeHtmlServer('<html><body><script src="https://evil.com/steal.js"></script></body></html>')

  const registerRes = await request.post(`${API}/apps/register`, {
    headers: { authorization: `Bearer ${teacherToken}` },
    data: {
      name: `SHR118 Evil ${Date.now()}`,
      description: 'Review target with external script',
      toolDefinitions: [
        { name: 'start', description: 'Start action', inputSchema: { type: 'object' } },
      ],
      uiManifest: { url, width: 400, height: 300 },
      permissions: { network: true },
      complianceMetadata: {},
      version: '1.0.0',
    },
  })
  const { appId } = await registerRes.json()

  const reviewRes = await request.post(`${API}/apps/${appId}/submit-review`, {
    headers: { authorization: `Bearer ${teacherToken}` },
  })
  const body = await reviewRes.json()
  server.close()

  expect(reviewRes.status()).toBe(202)
  expect(body.status).toBe('rejected')
  const securityStage = body.reviewResults.stages.find((s: any) => s.stage === 'security_scan')
  expect(securityStage.status).toBe('fail')

  await screenshotJSON(page, 'A2: Security Failure', {
    status: reviewRes.status(),
    reviewStatus: body.status,
    securityStage,
  }, 'screenshots/shr118-a2-security-fail.png')
})

test('A3: Clean app becomes approved and review result is stored', async ({ request, page }) => {
  const registerRes = await request.post(`${API}/apps/register`, {
    headers: { authorization: `Bearer ${teacherToken}` },
    data: {
      name: `SHR118 Approved ${Date.now()}`,
      description: 'Clean app expected to pass review',
      toolDefinitions: [
        { name: 'start', description: 'Start action', inputSchema: { type: 'object' } },
      ],
      uiManifest: { url: 'https://approved.chatbridge.app', width: 400, height: 300 },
      permissions: { network: false },
      complianceMetadata: {},
      version: '1.0.0',
    },
  })
  const { appId } = await registerRes.json()

  const reviewRes = await request.post(`${API}/apps/${appId}/submit-review`, {
    headers: { authorization: `Bearer ${teacherToken}` },
  })
  expect(reviewRes.status()).toBe(202)
  const reviewBody = await reviewRes.json()
  expect(reviewBody.status).toBe('approved')

  const resultsRes = await request.get(`${API}/apps/${appId}/review-results`, {
    headers: { authorization: `Bearer ${teacherToken}` },
  })
  expect(resultsRes.status()).toBe(200)
  const resultsBody = await resultsRes.json()
  expect(resultsBody.reviewStatus).toBe('approved')
  expect(resultsBody.reviewResults.stages).toHaveLength(5)

  await screenshotJSON(page, 'A3: Approved + Stored Results', {
    submitReview: reviewBody,
    reviewResults: resultsBody,
  }, 'screenshots/shr118-a3-approved-stored.png')
})

test('A5: Single a11y failure blocks approval while others pass', async ({ request, page }) => {
  const { server, url } = await makeHtmlServer('<html><body><img src="/hero.png"></body></html>')

  const registerRes = await request.post(`${API}/apps/register`, {
    headers: { authorization: `Bearer ${teacherToken}` },
    data: {
      name: `SHR118 A11y ${Date.now()}`,
      description: 'Single a11y failure app',
      toolDefinitions: [
        { name: 'start', description: 'Start action', inputSchema: { type: 'object' } },
      ],
      uiManifest: { url, width: 400, height: 300 },
      permissions: { network: false },
      complianceMetadata: {},
      version: '1.0.0',
    },
  })
  const { appId } = await registerRes.json()

  const reviewRes = await request.post(`${API}/apps/${appId}/submit-review`, {
    headers: { authorization: `Bearer ${teacherToken}` },
  })
  const body = await reviewRes.json()
  server.close()

  expect(reviewRes.status()).toBe(202)
  expect(body.status).toBe('rejected')
  const stages = body.reviewResults.stages
  expect(stages.find((s: any) => s.stage === 'schema_validation').status).toBe('pass')
  expect(stages.find((s: any) => s.stage === 'security_scan').status).toBe('pass')
  expect(stages.find((s: any) => s.stage === 'content_check').status).toBe('pass')
  expect(stages.find((s: any) => s.stage === 'accessibility').status).toBe('fail')
  expect(stages.find((s: any) => s.stage === 'performance').status).toBe('pass')

  await screenshotJSON(page, 'A5: Partial Failure Blocks Approval', {
    status: reviewRes.status(),
    reviewStatus: body.status,
    stages,
  }, 'screenshots/shr118-a5-partial-failure.png')
})
