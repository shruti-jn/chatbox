import { test } from '@playwright/test'

/**
 * CP4 / SHR-129 A4
 *
 * Flow:
 * 1. Complete an LTI launch and roster sync.
 * 2. Teacher opens classroom / Mission Control.
 * 3. LMS roster appears locally.
 *
 * Notes:
 * - This is only partially browser-observable; roster sync verification also needs API/DB assertions.
 */

test.describe('CP4 LTI roster visibility', () => {
  test.fixme('post-launch roster sync is visible in the teacher classroom experience', async () => {})
})
