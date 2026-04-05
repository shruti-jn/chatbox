import { test } from '@playwright/test'

/**
 * CP4 / SHR-125 A3 and SHR-128 access constraints
 *
 * Flow:
 * 1. Student navigates directly to the Mission Control route.
 * 2. Student is redirected or denied.
 *
 * Notes:
 * - Mission Control route is not yet implemented in the renderer fixture served by Playwright.
 * - Replace this with a concrete route and expected denial UX once shipped.
 */

test.describe('CP4 Mission Control authorization', () => {
  test.fixme('student cannot access Mission Control directly', async () => {})
})
