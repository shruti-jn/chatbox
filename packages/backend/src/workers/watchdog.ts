/**
 * Watchdog Workers — SHR-210
 *
 * Background sweepers that run on intervals:
 * 1. Heartbeat watchdog: active instances with no heartbeat → unresponsive (60s) → terminated (5 min)
 * 2. Session TTL sweeper: active/suspended instances older than 8 hours → terminated
 * 3. Dead-letter: failed jobs are preserved, never deleted
 *
 * All sweepers are non-blocking and log their actions.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
})

const HEARTBEAT_UNRESPONSIVE_MS = 60 * 1000 // 60 seconds
const HEARTBEAT_TERMINATED_MS = 5 * 60 * 1000 // 5 minutes
const SESSION_TTL_MS = 8 * 60 * 60 * 1000 // 8 hours

/**
 * Heartbeat watchdog: mark instances with stale heartbeats.
 * active + no heartbeat for 60s → error
 * error + no heartbeat for 5 min → terminated
 */
export async function sweepStaleHeartbeats(): Promise<{ unresponsive: number; terminated: number }> {
  const now = new Date()

  // Step 1: active instances with stale heartbeat → error (unresponsive)
  const staleThreshold = new Date(now.getTime() - HEARTBEAT_UNRESPONSIVE_MS)
  const markedUnresponsive = await prisma.appInstance.updateMany({
    where: {
      status: 'active',
      lastHeartbeatAt: { lt: staleThreshold },
    },
    data: { status: 'error' },
  })

  // Step 2: error instances with very stale heartbeat → terminated
  const terminateThreshold = new Date(now.getTime() - HEARTBEAT_TERMINATED_MS)
  const markedTerminated = await prisma.appInstance.updateMany({
    where: {
      status: 'error',
      lastHeartbeatAt: { lt: terminateThreshold },
    },
    data: { status: 'terminated', terminatedAt: now },
  })

  if (markedUnresponsive.count > 0 || markedTerminated.count > 0) {
    console.log(`[watchdog] Heartbeat sweep: ${markedUnresponsive.count} → error, ${markedTerminated.count} → terminated`)
  }

  return { unresponsive: markedUnresponsive.count, terminated: markedTerminated.count }
}

/**
 * Session TTL sweeper: terminate long-running instances.
 * active/suspended instances with updatedAt > 8 hours → terminated
 */
export async function sweepExpiredSessions(): Promise<{ terminated: number }> {
  const ttlThreshold = new Date(Date.now() - SESSION_TTL_MS)

  const terminated = await prisma.appInstance.updateMany({
    where: {
      status: { in: ['active', 'suspended'] },
      updatedAt: { lt: ttlThreshold },
    },
    data: { status: 'terminated', terminatedAt: new Date() },
  })

  if (terminated.count > 0) {
    console.log(`[watchdog] Session TTL sweep: ${terminated.count} → terminated (>8h old)`)
  }

  return { terminated: terminated.count }
}

/**
 * Dead-letter check: count failed/non-retryable jobs (never deleted, always queryable).
 */
export async function getDeadLetterCount(): Promise<number> {
  return prisma.appInvocationJob.count({
    where: {
      status: 'failed',
      retryable: false,
    },
  })
}

/**
 * Start all watchdog timers.
 */
export function startWatchdogs() {
  console.log('[watchdog] Starting heartbeat (10s), session TTL (60s) sweepers')

  // Heartbeat watchdog: every 10 seconds
  setInterval(() => {
    sweepStaleHeartbeats().catch((err) => {
      console.error('[watchdog] Heartbeat sweep error:', err)
    })
  }, 10_000)

  // Session TTL sweeper: every 60 seconds
  setInterval(() => {
    sweepExpiredSessions().catch((err) => {
      console.error('[watchdog] Session TTL sweep error:', err)
    })
  }, 60_000)
}

export { HEARTBEAT_UNRESPONSIVE_MS, HEARTBEAT_TERMINATED_MS, SESSION_TTL_MS }
