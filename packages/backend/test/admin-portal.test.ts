/**
 * Admin Portal Tests — SHR-128
 *
 * Tests:
 * 1. GET /admin/apps returns app list with reviewStatus
 * 2. POST /admin/apps/:id/approve changes status to approved
 * 3. POST /admin/apps/:id/suspend changes status to suspended
 * 4. GET /admin/analytics returns pseudonymous data (no PII)
 * 5. Student role cannot access /admin/* (403)
 * 6. GET /admin/apps/:id returns detail with review results
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer, registerBuiltInApps } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { ownerPrisma } from '../src/middleware/rls.js'
import type { FastifyInstance } from 'fastify'

describe('Admin Portal', () => {
  let server: FastifyInstance
  let districtId: string
  let adminToken: string
  let studentToken: string
  let testAppId: string

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()
    await registerBuiltInApps()

    const district = await ownerPrisma.district.create({ data: { name: 'Admin Test District' } })
    districtId = district.id

    const admin = await ownerPrisma.user.create({
      data: { districtId, role: 'district_admin', displayName: 'Test Admin' },
    })
    adminToken = signJWT({ userId: admin.id, role: 'district_admin', districtId })

    const student = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Test Student', gradeBand: 'g68' },
    })
    studentToken = signJWT({ userId: student.id, role: 'student', districtId, gradeBand: 'g68' })

    // Register a test app and add to district catalog
    const app = await ownerPrisma.app.create({
      data: {
        name: 'Admin Test App',
        description: 'Test app for admin portal',
        toolDefinitions: [{ name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' } }],
        uiManifest: { url: 'https://test.app/ui', width: 400, height: 300 },
        permissions: {},
        complianceMetadata: {},
        version: '1.0.0',
        reviewStatus: 'pending_review',
      },
    })
    testAppId = app.id

    await ownerPrisma.districtAppCatalog.create({
      data: { districtId, appId: testAppId, status: 'approved' },
    })
  })

  afterAll(async () => {
    try {
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM district_app_catalog WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM users WHERE district_id = '${districtId}'`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM districts WHERE id = '${districtId}'`)
      await ownerPrisma.app.delete({ where: { id: testAppId } }).catch(() => {})
    } catch {}
    await server.close()
  })

  it('GET /admin/apps returns app list with reviewStatus', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/apps',
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.apps).toBeDefined()
    expect(body.apps.length).toBeGreaterThanOrEqual(1)
    const app = body.apps.find((a: any) => a.id === testAppId)
    expect(app).toBeDefined()
    expect(app.reviewStatus).toBe('pending_review')
    expect(app.name).toBe('Admin Test App')
  })

  it('POST /admin/apps/:id/approve changes status to approved', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/apps/${testAppId}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(res.statusCode).toBe(200)

    // Verify in DB
    const app = await ownerPrisma.app.findUnique({ where: { id: testAppId } })
    expect(app!.reviewStatus).toBe('approved')
  })

  it('POST /admin/apps/:id/suspend changes status to suspended', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/admin/apps/${testAppId}/suspend`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(res.statusCode).toBe(200)

    // Verify catalog status
    const catalog = await ownerPrisma.districtAppCatalog.findFirst({
      where: { districtId, appId: testAppId },
    })
    expect(catalog!.status).toBe('suspended')
  })

  it('GET /admin/analytics returns data without PII', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics',
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)

    expect(typeof body.messageCount).toBe('number')
    expect(typeof body.safetyEventCount).toBe('number')
    expect(typeof body.activeStudents).toBe('number')
    expect(body.classrooms).toBeDefined()

    // PII check: stringify and scan for patterns
    const json = JSON.stringify(body)
    expect(json).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/) // No SSN
    expect(json).not.toMatch(/[\w.-]+@[\w.-]+\.[a-z]{2,}/i) // No email
    expect(json).not.toMatch(/\b\d{3}[-\.]\d{3}[-\.]\d{4}\b/) // No phone
  })

  it('student role cannot access /admin/apps (403)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/apps',
      headers: { authorization: `Bearer ${studentToken}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('student role cannot access /admin/analytics (403)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics',
      headers: { authorization: `Bearer ${studentToken}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('GET /admin/apps/:id returns detail with review results', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/admin/apps/${testAppId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.id).toBe(testAppId)
    expect(body.name).toBe('Admin Test App')
    expect(body.toolDefinitions).toBeDefined()
  })
})
