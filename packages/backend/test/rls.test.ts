import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

// Owner role for seeding (bypasses RLS)
const OWNER_URL = process.env.DATABASE_URL ?? 'postgresql://chatbridge:chatbridge@localhost:5435/chatbridge'
// App role for testing (RLS enforced)
const APP_URL = 'postgresql://chatbridge_app:chatbridge_app@localhost:5435/chatbridge'

describe('RLS Multi-Tenant Isolation (FERPA)', () => {
  let ownerPrisma: PrismaClient
  let prisma: PrismaClient
  let districtAId: string
  let districtBId: string

  beforeAll(async () => {
    ownerPrisma = new PrismaClient({ datasources: { db: { url: OWNER_URL } } })
    prisma = new PrismaClient({ datasources: { db: { url: APP_URL } } })

    // Seed with owner role (bypasses RLS)
    const districtA = await ownerPrisma.district.create({
      data: { name: 'District Alpha' },
    })
    const districtB = await ownerPrisma.district.create({
      data: { name: 'District Beta' },
    })
    districtAId = districtA.id
    districtBId = districtB.id

    // Seed users with owner role
    await ownerPrisma.user.create({
      data: {
        districtId: districtAId,
        role: 'student',
        displayName: 'Student A',
        gradeBand: 'g68',
      },
    })
    await ownerPrisma.user.create({
      data: {
        districtId: districtBId,
        role: 'student',
        displayName: 'Student B',
        gradeBand: 'g912',
      },
    })
  })

  afterAll(async () => {
    // Clean up with owner role — disable RLS temporarily for cleanup
    try {
      await ownerPrisma.$executeRawUnsafe('SET LOCAL row_security TO off')
      await ownerPrisma.user.deleteMany({ where: { districtId: { in: [districtAId, districtBId] } } })
      await ownerPrisma.district.deleteMany({ where: { id: { in: [districtAId, districtBId] } } })
    } catch {
      // If RLS blocks cleanup, use raw SQL
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM users WHERE district_id IN ('${districtAId}', '${districtBId}')`)
      await ownerPrisma.$executeRawUnsafe(`DELETE FROM districts WHERE id IN ('${districtAId}', '${districtBId}')`)
    }
    await ownerPrisma.$disconnect()
    await prisma.$disconnect()
  })

  it('SET LOCAL scopes query to tenant district', async () => {
    const users = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${districtAId}, true)`
      return tx.user.findMany()
    })

    expect(users).toHaveLength(1)
    expect(users[0].displayName).toBe('Student A')
    expect(users[0].districtId).toBe(districtAId)
  })

  it('District A cannot see District B data', async () => {
    const usersA = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${districtAId}, true)`
      return tx.user.findMany()
    })

    const usersB = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${districtBId}, true)`
      return tx.user.findMany()
    })

    // Each district sees only its own users
    expect(usersA).toHaveLength(1)
    expect(usersA[0].displayName).toBe('Student A')

    expect(usersB).toHaveLength(1)
    expect(usersB[0].displayName).toBe('Student B')
  })

  it('SET LOCAL resets per transaction (no connection pool contamination)', async () => {
    // First transaction: set tenant A
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${districtAId}, true)`
      const users = await tx.user.findMany()
      expect(users).toHaveLength(1)
    })

    // Second transaction: set tenant B — should not see tenant A's data
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${districtBId}, true)`
      const users = await tx.user.findMany()
      expect(users).toHaveLength(1)
      expect(users[0].displayName).toBe('Student B')
    })
  })

  it('Apps table is RLS-exempt (platform-global)', async () => {
    // Create an app with owner role (apps table is RLS-exempt)
    const app = await ownerPrisma.app.create({
      data: {
        name: 'Chess',
        description: 'Interactive chess game',
        toolDefinitions: {},
        uiManifest: { url: 'https://chess.app' },
        permissions: {},
        complianceMetadata: {},
        version: '1.0.0',
      },
    })

    // App visible from any tenant context
    const appsFromA = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${districtAId}, true)`
      return tx.app.findMany()
    })

    expect(appsFromA.length).toBeGreaterThanOrEqual(1)
    expect(appsFromA.some(a => a.name === 'Chess')).toBe(true)

    // Clean up
    await ownerPrisma.app.delete({ where: { id: app.id } })
  })
})
