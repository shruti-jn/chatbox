import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * RLS Middleware: SET LOCAL app.tenant_id per transaction
 *
 * CRITICAL: Uses SET LOCAL (transaction-scoped), NOT SET (session-scoped)
 * SET would persist across connection pool reuse → cross-tenant data leakage
 * SET LOCAL resets automatically on transaction commit
 */
export async function withTenantContext<T>(
  tenantId: string,
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // SET LOCAL is transaction-scoped — safe for connection pooling
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return fn(tx)
  })
}

/**
 * Get a Prisma client configured for the current tenant.
 * For use outside explicit transactions.
 */
export async function setTenantContext(tenantId: string): Promise<void> {
  // This is for non-transactional reads where SET LOCAL in a transaction isn't practical.
  // Use withTenantContext for writes.
  await prisma.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
}

export { prisma }
