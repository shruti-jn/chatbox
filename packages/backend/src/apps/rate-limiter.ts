/**
 * Per-App Rate Limiter
 *
 * Sliding-window counter: 100 invocations per minute per app.
 * In-memory storage (Map) — not persisted to DB.
 */

export interface RateLimitEntry {
  count: number
  windowStart: number // epoch ms
}

/** Configurable rate limit settings */
export const rateLimitConfig = {
  maxInvocations: parseInt(process.env.APP_RATE_LIMIT_MAX ?? '100', 10),
  windowMs: parseInt(process.env.APP_RATE_LIMIT_WINDOW_MS ?? '60000', 10),
}

/** In-memory rate limit store */
const rateLimitStore = new Map<string, RateLimitEntry>()

export interface RateLimitResult {
  allowed: boolean
  /** Seconds until the current window resets (for Retry-After header) */
  retryAfterSec: number
  remaining: number
}

/**
 * Check and consume a rate limit token for the given appId.
 * Returns whether the request is allowed plus retry metadata.
 */
export function checkRateLimit(appId: string, now = Date.now()): RateLimitResult {
  let entry = rateLimitStore.get(appId)

  // Start a new window if none exists or current window has elapsed
  if (!entry || now - entry.windowStart >= rateLimitConfig.windowMs) {
    entry = { count: 1, windowStart: now }
    rateLimitStore.set(appId, entry)
    return { allowed: true, retryAfterSec: 0, remaining: rateLimitConfig.maxInvocations - 1 }
  }

  // Within current window
  entry.count += 1
  if (entry.count > rateLimitConfig.maxInvocations) {
    const retryAfterSec = Math.ceil((entry.windowStart + rateLimitConfig.windowMs - now) / 1000)
    return { allowed: false, retryAfterSec, remaining: 0 }
  }

  return { allowed: true, retryAfterSec: 0, remaining: rateLimitConfig.maxInvocations - entry.count }
}

/** Reset all rate limit data — for testing only */
export function _resetRateLimitStore(): void {
  rateLimitStore.clear()
}
