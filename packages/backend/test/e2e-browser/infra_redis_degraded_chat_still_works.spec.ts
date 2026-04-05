import { test } from '@playwright/test'

/**
 * CP4 / SHR-131 A1
 *
 * Flow:
 * 1. Redis is intentionally unavailable.
 * 2. User sends a browser chat message.
 * 3. The request still completes.
 * 4. The health/degraded UI indicates partial outage instead of crashing.
 *
 * Notes:
 * - Backend already falls back when Redis is unavailable for rate limiting.
 * - Browser degraded-mode UX still needs a concrete surface in this harness.
 */

test.describe('CP4 Redis degraded mode', () => {
  test.fixme('chat still works when Redis is down and the browser shows degraded mode', async () => {})
})
