/**
 * Test fixture factory for ChatBridge v2
 *
 * All functions write to REAL Postgres (no mocks per L-079).
 * Every created record carries correct district_id for RLS.
 */
import { PrismaClient, type UserRole, type GradeBand } from '@prisma/client'
import crypto from 'node:crypto'

const prisma = new PrismaClient()

function hashEmail(email: string): string {
  return crypto.createHash('sha256').update(email).digest('hex')
}

let counter = 0
function nextId(): string {
  counter++
  return crypto.randomUUID()
}

// ---- District ----

interface DistrictOverrides {
  id?: string
  name?: string
  config?: Record<string, unknown> | null
}

export async function createTestDistrict(overrides: DistrictOverrides = {}) {
  const id = overrides.id ?? nextId()
  return prisma.district.create({
    data: {
      id,
      name: overrides.name ?? `Test District ${Date.now()}-${counter++}`,
      config: overrides.config ?? null,
    },
  })
}

// ---- School ----

interface SchoolOverrides {
  id?: string
  name?: string
}

export async function createTestSchool(districtId: string, overrides: SchoolOverrides = {}) {
  return prisma.school.create({
    data: {
      id: overrides.id ?? nextId(),
      districtId,
      name: overrides.name ?? `Test School ${Date.now()}-${counter++}`,
    },
  })
}

// ---- User ----

interface UserOverrides {
  id?: string
  role?: UserRole
  displayName?: string
  gradeBand?: GradeBand | null
  emailHash?: string
  schoolId?: string | null
  externalId?: string | null
}

export async function createTestUser(districtId: string, overrides: UserOverrides = {}) {
  return prisma.user.create({
    data: {
      id: overrides.id ?? nextId(),
      districtId,
      schoolId: overrides.schoolId ?? null,
      role: overrides.role ?? 'student',
      displayName: overrides.displayName ?? `Test User ${Date.now()}-${counter++}`,
      gradeBand: overrides.gradeBand ?? null,
      emailHash: overrides.emailHash ?? hashEmail(`fixture-${nextId()}@test.invalid`),
      externalId: overrides.externalId ?? null,
    },
  })
}

// ---- Classroom ----

interface ClassroomOverrides {
  id?: string
  name?: string
  gradeBand?: GradeBand
  districtId?: string
  joinCode?: string
  aiConfig?: Record<string, unknown> | null
}

export async function createTestClassroom(
  schoolId: string,
  teacherId: string,
  districtId: string,
  overrides: ClassroomOverrides = {},
) {
  const suffix = `${Date.now()}-${counter++}`
  return prisma.classroom.create({
    data: {
      id: overrides.id ?? nextId(),
      districtId,
      schoolId,
      teacherId,
      name: overrides.name ?? `Test Classroom ${suffix}`,
      joinCode: overrides.joinCode ?? `TEST-${suffix}`,
      gradeBand: overrides.gradeBand ?? 'g35',
      aiConfig: overrides.aiConfig ?? null,
    },
  })
}

// ---- Cleanup ----

interface CleanupIds {
  classroomMembershipIds?: string[]
  classroomIds?: string[]
  userIds?: string[]
  schoolIds?: string[]
  districtIds?: string[]
  appIds?: string[]
  catalogIds?: string[]
  consentIds?: string[]
}

/**
 * Deletes all created records by ID, in correct FK order.
 * Pass the IDs you collected during the test.
 */
export async function cleanup(ids: CleanupIds) {
  // Delete audit/safety events first (immutability trigger requires escape hatch).
  // Must delete by both districtId AND userId to catch all FK references.
  // Delete audit/safety events before users/districts to avoid FK violations.
  // Uses raw SQL in a transaction with the DB-level escape hatch.
  if (ids.userIds?.length || ids.districtIds?.length) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_audit_cleanup', 'true', true)`
      if (ids.userIds?.length) {
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_events WHERE user_id::text = ANY($1::text[])`,
          ids.userIds,
        )
        await tx.$executeRawUnsafe(
          `DELETE FROM safety_events WHERE user_id::text = ANY($1::text[])`,
          ids.userIds,
        )
      }
      if (ids.districtIds?.length) {
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_events WHERE district_id::text = ANY($1::text[])`,
          ids.districtIds,
        )
        await tx.$executeRawUnsafe(
          `DELETE FROM safety_events WHERE district_id::text = ANY($1::text[])`,
          ids.districtIds,
        )
      }
    })
  }
  // Delete in reverse-dependency order to avoid FK violations
  if (ids.consentIds?.length) {
    await prisma.parentalConsent.deleteMany({ where: { id: { in: ids.consentIds } } })
  }
  if (ids.catalogIds?.length) {
    await prisma.districtAppCatalog.deleteMany({ where: { id: { in: ids.catalogIds } } })
  }
  if (ids.classroomMembershipIds?.length) {
    await prisma.classroomMembership.deleteMany({ where: { id: { in: ids.classroomMembershipIds } } })
  }
  if (ids.classroomIds?.length) {
    await prisma.classroom.deleteMany({ where: { id: { in: ids.classroomIds } } })
  }
  if (ids.appIds?.length) {
    await prisma.app.deleteMany({ where: { id: { in: ids.appIds } } })
  }
  if (ids.userIds?.length) {
    await prisma.user.deleteMany({ where: { id: { in: ids.userIds } } })
  }
  if (ids.schoolIds?.length) {
    await prisma.school.deleteMany({ where: { id: { in: ids.schoolIds } } })
  }
  if (ids.districtIds?.length) {
    await prisma.district.deleteMany({ where: { id: { in: ids.districtIds } } })
  }
}

/**
 * Get a shared PrismaClient instance for test use.
 * Tests should use this instead of creating their own client.
 */
export function getPrisma(): PrismaClient {
  return prisma
}

/**
 * Disconnect the shared PrismaClient. Call in afterAll().
 */
export async function disconnectPrisma() {
  await prisma.$disconnect()
}
