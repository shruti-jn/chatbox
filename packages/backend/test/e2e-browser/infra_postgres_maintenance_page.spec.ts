import { test } from '@playwright/test'

/**
 * CP4 / SHR-131 A2
 *
 * Flow:
 * 1. PostgreSQL is unavailable.
 * 2. Browser navigation or chat request lands on a maintenance / 503 experience.
 * 3. No raw stack trace is shown.
 */

test.describe('CP4 PostgreSQL outage handling', () => {
  test.fixme('browser shows a maintenance experience instead of a stack trace during DB outage', async () => {})
})
