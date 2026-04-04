/**
 * App Health Monitoring Service
 *
 * Tracks tool invocation latency and failure rates per app.
 * Uses in-memory storage (Map) — not persisted to DB.
 *
 * Thresholds:
 *   - 3 consecutive failures → degraded
 *   - 5 consecutive failures → unresponsive
 *   - 1 success after failures → recovery to healthy
 */

export interface AppHealthStatus {
  appId: string
  status: 'healthy' | 'degraded' | 'unresponsive'
  lastCheckAt: Date
  consecutiveFailures: number
  avgLatencyMs: number
}

const DEGRADED_THRESHOLD = 3
const UNRESPONSIVE_THRESHOLD = 5
const LATENCY_WINDOW = 20 // rolling average over last N invocations

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

export function recordSuccess(appId: string, latencyMs: number): void {
  const samples = latencySamples.get(appId) ?? []
  samples.push(latencyMs)
  if (samples.length > LATENCY_WINDOW) samples.shift()
  latencySamples.set(appId, samples)

  const avgLatencyMs = samples.reduce((a, b) => a + b, 0) / samples.length

  healthStore.set(appId, {
    appId,
    status: 'healthy',
    lastCheckAt: new Date(),
    consecutiveFailures: 0,
    avgLatencyMs: Math.round(avgLatencyMs),
  })
}

export function recordFailure(appId: string): void {
  const current = getHealthStatus(appId)
  const failures = current.consecutiveFailures + 1

  let status: AppHealthStatus['status']
  if (failures >= UNRESPONSIVE_THRESHOLD) {
    status = 'unresponsive'
  } else if (failures >= DEGRADED_THRESHOLD) {
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
}

export function isUnresponsive(appId: string): boolean {
  return getHealthStatus(appId).status === 'unresponsive'
}

/** Reset all health data — for testing only */
export function _resetHealthStore(): void {
  healthStore.clear()
  latencySamples.clear()
}
