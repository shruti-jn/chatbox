import { test } from '@playwright/test'

/**
 * CP4 / SHR-128 A3
 *
 * Flow:
 * 1. Student or teacher navigates to /admin.
 * 2. The user is redirected or denied.
 *
 * Notes:
 * - This test becomes concrete when the renderer exposes an admin route.
 */

test.describe('CP4 admin route authorization', () => {
  test.fixme('non-admin users cannot access the admin experience', async () => {})
})
