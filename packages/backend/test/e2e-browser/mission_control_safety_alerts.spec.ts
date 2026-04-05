import { test } from '@playwright/test'

/**
 * CP4 / SHR-124 A2
 *
 * Flow:
 * 1. Student sends a safety-triggering message.
 * 2. Teacher Mission Control tile turns amber/red within a few seconds.
 * 3. Teacher opens alert details from the tile.
 *
 * Notes:
 * - Safety events and Mission Control WS plumbing exist on the backend.
 * - A browser Mission Control alert UI is not yet wired in this harness.
 */

test.describe('CP4 Mission Control safety alerts', () => {
  test.fixme('teacher sees live safety alert state and can inspect details', async () => {})
})
