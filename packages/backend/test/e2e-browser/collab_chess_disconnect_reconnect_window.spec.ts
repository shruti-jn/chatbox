import { test } from '@playwright/test'

/**
 * CP4 / SHR-127 A2
 *
 * Flow:
 * 1. Disconnect Student B.
 * 2. Student A sees "opponent disconnected" and the board freezes.
 * 3. Student B reconnects within 5 minutes.
 * 4. Game resumes with state intact.
 */

test.describe('CP4 collaborative chess reconnect window', () => {
  test.fixme('game freezes during disconnect and resumes after reconnect within the allowed window', async () => {})
})
