import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../src/server.js'
import { signJWT } from '../src/middleware/auth.js'
import { prisma, ownerPrisma } from '../src/middleware/rls.js'
import type { FastifyInstance } from 'fastify'

describe('Classroom Routes', () => {
  let server: FastifyInstance

  // District A
  let districtAId: string
  let teacherAId: string
  let teacherAToken: string
  let studentAId: string
  let studentAToken: string
  let classroomAId: string

  // District B
  let districtBId: string
  let teacherBId: string
  let teacherBToken: string

  // App fixtures
  let approvedAppId: string
  let rejectedAppId: string

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()

    // Create districts (owner role bypasses RLS for seeding)
    const districtA = await ownerPrisma.district.create({ data: { name: 'Classroom Test District A' } })
    const districtB = await ownerPrisma.district.create({ data: { name: 'Classroom Test District B' } })
    districtAId = districtA.id
    districtBId = districtB.id

    // Create users
    const teacherA = await ownerPrisma.user.create({
      data: { districtId: districtAId, role: 'teacher', displayName: 'Teacher A' },
    })
    teacherAId = teacherA.id
    teacherAToken = signJWT({ userId: teacherA.id, role: 'teacher', districtId: districtAId })

    const studentA = await ownerPrisma.user.create({
      data: { districtId: districtAId, role: 'student', displayName: 'Student A', gradeBand: 'g68' },
    })
    studentAId = studentA.id
    studentAToken = signJWT({ userId: studentA.id, role: 'student', districtId: districtAId })

    const teacherB = await ownerPrisma.user.create({
      data: { districtId: districtBId, role: 'teacher', displayName: 'Teacher B' },
    })
    teacherBId = teacherB.id
    teacherBToken = signJWT({ userId: teacherB.id, role: 'teacher', districtId: districtBId })

    // Create classroom in district A
    const classroomA = await ownerPrisma.classroom.create({
      data: {
        districtId: districtAId,
        teacherId: teacherAId,
        name: 'Test Classroom A',
        joinCode: 'CLSRMA1',
        gradeBand: 'g68',
        aiConfig: { mode: 'socratic' },
      },
    })
    classroomAId = classroomA.id

    // Create apps: one approved, one rejected in District A catalog
    const approvedApp = await ownerPrisma.app.create({
      data: {
        name: 'Approved App',
        description: 'An approved app',
        toolDefinitions: {},
        uiManifest: { url: 'https://approved.app' },
        permissions: {},
        complianceMetadata: {},
        version: '1.0.0',
      },
    })
    approvedAppId = approvedApp.id

    const rejectedApp = await ownerPrisma.app.create({
      data: {
        name: 'Rejected App',
        description: 'A rejected app',
        toolDefinitions: {},
        uiManifest: { url: 'https://rejected.app' },
        permissions: {},
        complianceMetadata: {},
        version: '1.0.0',
      },
    })
    rejectedAppId = rejectedApp.id

    await ownerPrisma.districtAppCatalog.create({
      data: { districtId: districtAId, appId: approvedAppId, status: 'approved' },
    })
    await ownerPrisma.districtAppCatalog.create({
      data: { districtId: districtAId, appId: rejectedAppId, status: 'rejected' },
    })
  })

  afterAll(async () => {
    try {
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM classroom_app_configs WHERE district_id IN ('${districtAId}', '${districtBId}')`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM district_app_catalog WHERE district_id IN ('${districtAId}', '${districtBId}')`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM classrooms WHERE district_id IN ('${districtAId}', '${districtBId}')`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM apps WHERE id IN ('${approvedAppId}', '${rejectedAppId}')`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM users WHERE district_id IN ('${districtAId}', '${districtBId}')`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM districts WHERE id IN ('${districtAId}', '${districtBId}')`)
    } catch { /* best effort */ }
    await server.close()
  })

  // === F1: RLS bypass on PATCH routes ===

  describe('F1: RLS enforcement on PATCH routes', () => {
    it('PATCH /classrooms/:id/config — District B teacher cannot update District A classroom', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/v1/classrooms/${classroomAId}/config`,
        headers: { authorization: `Bearer ${teacherBToken}` },
        payload: { aiConfig: { mode: 'direct' } },
      })

      // Should be 404 because RLS hides the classroom from District B
      expect(res.statusCode).toBe(404)
    })

    it('PATCH /classrooms/:id/apps/:appId — District B teacher cannot toggle District A app', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/v1/classrooms/${classroomAId}/apps/${approvedAppId}`,
        headers: { authorization: `Bearer ${teacherBToken}` },
        payload: { enabled: false },
      })

      // Should be 404 because RLS hides the classroom from District B
      expect(res.statusCode).toBe(404)
    })

    it('PATCH /classrooms/:id/config — District A teacher CAN update own classroom', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/v1/classrooms/${classroomAId}/config`,
        headers: { authorization: `Bearer ${teacherAToken}` },
        payload: { aiConfig: { mode: 'direct' } },
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.aiConfig.mode).toBe('direct')
    })
  })

  // === F2: Student gets 200 on GET config instead of 403 ===

  describe('F2: Role guard on GET /classrooms/:id/config', () => {
    it('GET /classrooms/:id/config — student gets 403', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/classrooms/${classroomAId}/config`,
        headers: { authorization: `Bearer ${studentAToken}` },
      })

      expect(res.statusCode).toBe(403)
    })

    it('GET /classrooms/:id/config — teacher gets 200', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/classrooms/${classroomAId}/config`,
        headers: { authorization: `Bearer ${teacherAToken}` },
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.name).toBeDefined()
    })
  })

  // === F3: Invalid mode 'argumentative' accepted ===

  describe('F3: Enum validation on mode field', () => {
    it('PATCH /classrooms/:id/config — rejects invalid mode', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/v1/classrooms/${classroomAId}/config`,
        headers: { authorization: `Bearer ${teacherAToken}` },
        payload: { aiConfig: { mode: 'argumentative' } },
      })

      expect(res.statusCode).toBe(400)
    })

    it('PATCH /classrooms/:id/config — accepts valid mode', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/v1/classrooms/${classroomAId}/config`,
        headers: { authorization: `Bearer ${teacherAToken}` },
        payload: { aiConfig: { mode: 'exploratory' } },
      })

      expect(res.statusCode).toBe(200)
    })
  })

  // === F4: Rejected app toggle returns 200 instead of 404 ===

  describe('F4: Rejected app toggle returns 404', () => {
    it('PATCH /classrooms/:id/apps/:appId — rejected app returns 404', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/v1/classrooms/${classroomAId}/apps/${rejectedAppId}`,
        headers: { authorization: `Bearer ${teacherAToken}` },
        payload: { enabled: true },
      })

      expect(res.statusCode).toBe(404)
    })

    it('PATCH /classrooms/:id/apps/:appId — approved app returns 200', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/v1/classrooms/${classroomAId}/apps/${approvedAppId}`,
        headers: { authorization: `Bearer ${teacherAToken}` },
        payload: { enabled: false },
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.enabled).toBe(false)
    })
  })

  // === F5: enabled_by audit column ===

  describe('F5: enabled_by audit trail on app toggle', () => {
    it('PATCH /classrooms/:id/apps/:appId — sets enabled_by to the JWT user ID', async () => {
      const res = await server.inject({
        method: 'PATCH',
        url: `/api/v1/classrooms/${classroomAId}/apps/${approvedAppId}`,
        headers: { authorization: `Bearer ${teacherAToken}` },
        payload: { enabled: true },
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.enabledBy).toBe(teacherAId)
    })
  })

  // === F6: Multi-step aiConfig merge ===

  describe('F6: aiConfig merge preserves prior fields', () => {
    it('PATCH twice — second patch preserves fields from first', async () => {
      // First PATCH: set mode
      const res1 = await server.inject({
        method: 'PATCH',
        url: `/api/v1/classrooms/${classroomAId}/config`,
        headers: { authorization: `Bearer ${teacherAToken}` },
        payload: { aiConfig: { mode: 'socratic' } },
      })
      expect(res1.statusCode).toBe(200)
      const body1 = JSON.parse(res1.body)
      expect(body1.aiConfig.mode).toBe('socratic')

      // Second PATCH: set boundaries (different field)
      const res2 = await server.inject({
        method: 'PATCH',
        url: `/api/v1/classrooms/${classroomAId}/config`,
        headers: { authorization: `Bearer ${teacherAToken}` },
        payload: { aiConfig: { boundaries: ['no-homework-answers'] } },
      })
      expect(res2.statusCode).toBe(200)
      const body2 = JSON.parse(res2.body)
      // Second patch should preserve mode from first patch
      expect(body2.aiConfig.mode).toBe('socratic')
      expect(body2.aiConfig.boundaries).toEqual(['no-homework-answers'])
    })
  })

  // === F7: GET /classrooms/:id/apps returns only approved apps ===

  describe('F7: GET /classrooms/:id/apps filters to approved only', () => {
    it('GET /classrooms/:id/apps — returns approved app, excludes rejected', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/classrooms/${classroomAId}/apps`,
        headers: { authorization: `Bearer ${teacherAToken}` },
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as Array<{ id: string; name: string }>
      const appIds = body.map(a => a.id)
      expect(appIds).toContain(approvedAppId)
      expect(appIds).not.toContain(rejectedAppId)
    })
  })
})
