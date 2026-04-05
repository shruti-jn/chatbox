import { test } from '@playwright/test'

/**
 * CP4 / SHR-126 A2 and SHR-127 A1
 *
 * Flow:
 * 1. Open the same collaborative game in two browser contexts.
 * 2. Make a move in one context.
 * 3. Confirm the other updates within 1 second and board state matches.
 *
 * Notes:
 * - WS route exists at /api/v1/ws/collab/:sessionId.
 * - This should become one of the first active CP4 browser specs once the UI exists.
 */

test.describe('CP4 collaborative chess board sync', () => {
  test.fixme('board state stays synchronized across two browser clients', async () => {})
})
