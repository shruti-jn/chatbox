import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildServer } from '../src/server.js'
import { signJWT, verifyJWT } from '../src/middleware/auth.js'
import { prisma, ownerPrisma } from '../src/middleware/rls.js'
import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'

describe('Auth: JWT issuance and validation', () => {
  it('signs and verifies a valid JWT', () => {
    const token = signJWT({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      role: 'teacher',
      districtId: '550e8400-e29b-41d4-a716-446655440001',
    })

    const payload = verifyJWT(token)
    expect(payload.userId).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(payload.role).toBe('teacher')
    expect(payload.districtId).toBe('550e8400-e29b-41d4-a716-446655440001')
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000)
  })

  it('rejects expired JWT', () => {
    // Create a token that's already expired
    const jwt = require('jsonwebtoken')
    const token = jwt.sign(
      { userId: 'test', role: 'student', districtId: 'test' },
      process.env.JWT_SECRET_KEY ?? 'test-secret-key',
      { expiresIn: '-1s' },
    )

    expect(() => verifyJWT(token)).toThrow()
  })
})

describe('Auth: RBAC enforcement', () => {
  let server: FastifyInstance
  let districtId: string
  let studentToken: string
  let teacherToken: string
  let adminToken: string

  beforeAll(async () => {
    server = await buildServer()
    await server.ready()

    // Create test district and users
    const district = await ownerPrisma.district.create({ data: { name: 'Test District' } })
    districtId = district.id

    const student = await ownerPrisma.user.create({
      data: { districtId, role: 'student', displayName: 'Test Student', gradeBand: 'g68' },
    })
    const teacher = await ownerPrisma.user.create({
      data: { districtId, role: 'teacher', displayName: 'Test Teacher' },
    })
    const admin = await ownerPrisma.user.create({
      data: { districtId, role: 'district_admin', displayName: 'Test Admin' },
    })

    studentToken = signJWT({ userId: student.id, role: 'student', districtId })
    teacherToken = signJWT({ userId: teacher.id, role: 'teacher', districtId })
    adminToken = signJWT({ userId: admin.id, role: 'district_admin', districtId })
  })

  afterAll(async () => {
    // Audit events have FK to users — delete them first with the immutability escape hatch
    await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_audit_cleanup', 'true', true)`
      await tx.auditEvent.deleteMany({ where: { districtId } })
      await tx.safetyEvent.deleteMany({ where: { districtId } })
    })
    await ownerPrisma.user.deleteMany({ where: { districtId } })
    await ownerPrisma.district.delete({ where: { id: districtId } })
    await server.close()
  })

  it('student can access /auth/me', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${studentToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).role).toBe('student')
  })

  it('unauthenticated request returns 401', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
    })
    expect(res.statusCode).toBe(401)
  })

  it('student cannot create classroom (403)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/classrooms',
      headers: { authorization: `Bearer ${studentToken}` },
      payload: { name: 'Test Class', gradeBand: 'g68' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('teacher can create classroom (201)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/classrooms',
      headers: { authorization: `Bearer ${teacherToken}` },
      payload: { name: 'Math 6th Grade', gradeBand: 'g68' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.name).toBe('Math 6th Grade')
    expect(body.joinCode).toBeDefined()
    expect(body.gradeBand).toBe('g68')

    // Clean up
    await ownerPrisma.classroom.delete({ where: { id: body.id } })
  })
})
