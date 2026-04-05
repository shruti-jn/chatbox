import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { ownerPrisma } from '../src/middleware/rls.js'

// Create a separate guarded client for testing immutability.
// The shared ownerPrisma has ALLOW_AUDIT_CLEANUP=1 so tests can clean up.
// This client applies the guard explicitly regardless of env flags.
const APPEND_ONLY_MODELS = ['AuditEvent', 'SafetyEvent']
const guardedPrisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
}).$extends({
  query: {
    $allOperations({ model, operation, args, query }) {
      if (
        model &&
        APPEND_ONLY_MODELS.includes(model) &&
        ['update', 'updateMany', 'delete', 'deleteMany'].includes(operation)
      ) {
        throw new Error(`${model} is append-only: ${operation} is prohibited`)
      }
      return query(args)
    },
  },
})

describe('Audit Immutability', () => {
  let districtId: string
  let userId: string
  let eventId: string

  beforeAll(async () => {
    // Create prerequisite district + user for FK constraints (use unguarded client)
    const district = await ownerPrisma.district.create({
      data: { name: 'Audit Immutability Test District' },
    })
    districtId = district.id

    const user = await ownerPrisma.user.create({
      data: {
        districtId,
        role: 'teacher',
        displayName: 'Audit Test User',
        gradeBand: 'g68',
      },
    })
    userId = user.id

    // Create a test audit event (insert is allowed)
    const event = await guardedPrisma.auditEvent.create({
      data: {
        districtId,
        userId,
        action: 'test_action',
        resourceType: 'test',
        resourceId: 'test-id',
      },
    })
    eventId = event.id
  })

  afterAll(async () => {
    // Clean up via ownerPrisma with DB-level escape hatch for audit immutability trigger
    try {
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.allow_audit_cleanup', 'true', true)`
        await tx.auditEvent.deleteMany({ where: { districtId } })
      })
      await ownerPrisma.user.deleteMany({ where: { districtId } })
      await ownerPrisma.district.delete({ where: { id: districtId } })
    } catch {
      // Best-effort cleanup
    }
  })

  it('blocks update on AuditEvent', async () => {
    await expect(
      guardedPrisma.auditEvent.update({
        where: { id: eventId },
        data: { action: 'modified' },
      })
    ).rejects.toThrow(/append-only|prohibited/i)
  })

  it('blocks delete on AuditEvent', async () => {
    await expect(
      guardedPrisma.auditEvent.delete({
        where: { id: eventId },
      })
    ).rejects.toThrow(/append-only|prohibited/i)
  })

  it('blocks deleteMany on AuditEvent', async () => {
    await expect(
      guardedPrisma.auditEvent.deleteMany({
        where: { id: eventId },
      })
    ).rejects.toThrow(/append-only|prohibited/i)
  })

  it('blocks updateMany on AuditEvent', async () => {
    await expect(
      guardedPrisma.auditEvent.updateMany({
        where: { id: eventId },
        data: { action: 'modified' },
      })
    ).rejects.toThrow(/append-only|prohibited/i)
  })

  it('allows create on AuditEvent (insert is permitted)', async () => {
    const event = await guardedPrisma.auditEvent.create({
      data: {
        districtId,
        userId,
        action: 'another_action',
        resourceType: 'test',
        resourceId: 'test-id-2',
      },
    })
    expect(event.id).toBeDefined()
  })

  it('allows findMany on AuditEvent (read is permitted)', async () => {
    const events = await guardedPrisma.auditEvent.findMany({
      where: { districtId },
    })
    expect(events.length).toBeGreaterThan(0)
  })
})
