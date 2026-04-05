/**
 * App Health Monitoring Service
 *
 * Tracks tool invocation latency and failure rates per app.
 * Uses in-memory storage (Map) for status, with DB logging for health events.
 *
 * Configurable thresholds (via healthConfig):
 *   - degradedThreshold (default 3) consecutive failures → degraded
 *   - unresponsiveThreshold (default 5) consecutive failures → unresponsive
 *   - 1 success after failures → recovery to healthy
 *
 * Health polling:
 *   For apps with a healthUrl, periodic HTTP checks detect unresponsive apps
 *   and trigger auto-recovery when they come back online.
 */

import { ownerPrisma } from '../middleware/rls.js'

export interface AppHealthStatus {
  appId: string
  status: 'healthy' | 'degraded' | 'unresponsive'
  lastCheckAt: Date
  consecutiveFailures: number
  avgLatencyMs: number
}

/** Configurable health thresholds — mutable for testing and runtime overrides */
export const healthConfig = {
  degradedThreshold: 3,
  unresponsiveThreshold: 5,
  latencyWindow: 20, // rolling average over last N invocations
  maxInvocationsPerMinute: 100,
}

/** In-memory health store */
const healthStore = new Map<string, AppHealthStatus>()

/** Per-app latency samples for rolling average */
const latencySamples = new Map<string, number[]>()

export function getHealthStatus(appId: string): AppHealthStatus {
  return (
    healthStore.get(appId) ?? {
      appId,
      status: 'healthy',
      lastCheckAt: new Date(),
      consecutiveFailures: 0,
      avgLatencyMs: 0,
    }
  )
}

/**
 * Log a health event to the database (non-blocking).
 * Failures are swallowed — health event logging must never break the app.
 */
async function logHealthEvent(
  appId: string,
  eventType: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await ownerPrisma.appHealthEvent.create({
      data: {
        appId,
        eventType,
        details: details ?? undefined,
      },
    })
  } catch {
    // Non-blocking: health event logging failure must not break invocations
  }
}

export async function recordSuccess(appId: string, latencyMs: number): Promise<void> {
  const previous = getHealthStatus(appId)
  const wasUnhealthy = previous.status !== 'healthy'

  const samples = latencySamples.get(appId) ?? []
  samples.push(latencyMs)
  if (samples.length > healthConfig.latencyWindow) samples.shift()
  latencySamples.set(appId, samples)

  const avgLatencyMs = samples.reduce((a, b) => a + b, 0) / samples.length

  healthStore.set(appId, {
    appId,
    status: 'healthy',
    lastCheckAt: new Date(),
    consecutiveFailures: 0,
    avgLatencyMs: Math.round(avgLatencyMs),
  })

  // Log recovery event when transitioning from degraded/unresponsive to healthy
  if (wasUnhealthy) {
    await logHealthEvent(appId, 'recovered', {
      previousStatus: previous.status,
      consecutiveFailures: previous.consecutiveFailures,
    })
  }
}

export async function recordFailure(appId: string): Promise<void> {
  const current = getHealthStatus(appId)
  const previousStatus = current.status
  const failures = current.consecutiveFailures + 1

  let status: AppHealthStatus['status']
  if (failures >= healthConfig.unresponsiveThreshold) {
    status = 'unresponsive'
  } else if (failures >= healthConfig.degradedThreshold) {
    status = 'degraded'
  } else {
    status = current.status === 'healthy' ? 'healthy' : current.status
  }

  healthStore.set(appId, {
    ...current,
    status,
    lastCheckAt: new Date(),
    consecutiveFailures: failures,
  })

  // Log health event on status transitions
  if (status !== previousStatus && status !== 'healthy') {
    await logHealthEvent(appId, status, {
      consecutiveFailures: failures,
    })
  }
}

/** Returns true if the app is degraded (3+ failures) */
export function isDegraded(appId: string): boolean {
  const status = getHealthStatus(appId).status
  return status === 'degraded' || status === 'unresponsive'
}

/** Returns true if the app is unresponsive (5+ failures) */
export function isUnresponsive(appId: string): boolean {
  return getHealthStatus(appId).status === 'unresponsive'
}

/** Returns true if the app should be blocked from invocations (degraded OR unresponsive) */
export function isBlocked(appId: string): boolean {
  return isDegraded(appId)
}

/**
 * Log a rate limit exceeded event to the database.
 */
export async function logRateLimitEvent(appId: string, details?: Record<string, unknown>): Promise<void> {
  await logHealthEvent(appId, 'rate_limit_exceeded', details)
}

// =============================================================================
// Health URL Polling
// =============================================================================

let pollingTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start periodic health polling for all apps that have a healthUrl configured.
 * On each tick:
 *   - Fetch healthUrl for each app
 *   - If 200: recordSuccess (triggers recovery if degraded)
 *   - If error: recordFailure (triggers degradation/unresponsive)
 */
export function startHealthPolling(intervalMs: number = 30000): void {
  stopHealthPolling() // Ensure no duplicate timers
  pollingTimer = setInterval(async () => {
    try {
      const apps = await ownerPrisma.app.findMany({
        where: { healthUrl: { not: null } },
        select: { id: true, healthUrl: true },
      })

      for (const app of apps) {
        if (!app.healthUrl) continue
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 5000)
          const response = await fetch(app.healthUrl, {
            signal: controller.signal,
            method: 'GET',
          })
          clearTimeout(timeout)

          if (response.ok) {
            await recordSuccess(app.id, 0)
          } else {
            await recordFailure(app.id)
          }
        } catch {
          await recordFailure(app.id)
        }
      }
    } catch {
      // DB query failed — skip this polling cycle
    }
  }, intervalMs)
}

/** Stop health polling */
export function stopHealthPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer)
    pollingTimer = null
  }
}

/** Reset all health data — for testing only */
export function _resetHealthStore(): void {
  healthStore.clear()
  latencySamples.clear()
}
