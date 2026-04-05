import { test } from '@playwright/test'

/**
 * CP4 / SHR-128 A1
 *
 * Flow:
 * 1. District admin opens the app catalog.
 * 2. Admin drills into an app's review lifecycle.
 * 3. Admin approves it.
 * 4. Admin suspends it.
 * 5. Status persists after reload.
 *
 * Notes:
 * - Backend suspend endpoint exists.
 * - Browser admin catalog/review UI is not yet available in this harness.
 */

test.describe('CP4 admin app catalog lifecycle', () => {
  test.fixme('district admin can approve and suspend an app from the browser catalog', async () => {})
})
