import { test } from '@playwright/test'

/**
 * CP4 / SHR-127 A1 and A4
 *
 * Flow:
 * 1. Student A sees white-at-bottom and "Your turn".
 * 2. Student B sees black-at-bottom and "Opponent's turn".
 * 3. After A moves, indicators swap.
 * 4. Only the active player can move.
 */

test.describe('CP4 collaborative chess player indicators', () => {
  test.fixme('player orientation and turn indicators match active turn state', async () => {})
})
