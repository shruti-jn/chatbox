import { PrismaClient } from '@prisma/client'

// ---------------------------------------------------------------------------
// Append-only enforcement for audit tables
// ---------------------------------------------------------------------------
// Prisma 5+ removed $use middleware. We use $extends with a query component
// to intercept mutating operations on append-only models.
const APPEND_ONLY_MODELS = ['AuditEvent', 'SafetyEvent'] as const

function withAppendOnlyGuard(client: PrismaClient) {
  return client.$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        // Runtime check: allow cleanup in test environment
        if (process.env.ALLOW_AUDIT_CLEANUP === '1') return query(args)

        if (
          model &&
          APPEND_ONLY_MODELS.includes(model as (typeof APPEND_ONLY_MODELS)[number]) &&
          ['update', 'updateMany', 'delete', 'deleteMany'].includes(operation)
        ) {
          throw new Error(
            `${model} is append-only: ${operation} is prohibited`
          )
        }
        return query(args)
      },
    },
  })
}

// Use DATABASE_URL_APP (chatbridge_app role — NOSUPERUSER, NOBYPASSRLS) for all
// application queries so RLS policies are enforced.  Fall back to DATABASE_URL
// only when the dedicated app URL hasn't been configured yet (dev convenience).
const appDatabaseUrl = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL

const prisma = withAppendOnlyGuard(
  new PrismaClient({
    datasources: { db: { url: appDatabaseUrl } },
  })
)

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

/**
 * Owner-level Prisma client (superuser — bypasses RLS).
 * ONLY for: migrations, test seeding, and admin maintenance scripts.
 * NEVER use in application request handlers.
 *
 * Append-only enforcement still applies — even superusers cannot mutate
 * audit records through the ORM.
 */
const ownerPrisma = withAppendOnlyGuard(
  new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  })
)

export { prisma, ownerPrisma }
