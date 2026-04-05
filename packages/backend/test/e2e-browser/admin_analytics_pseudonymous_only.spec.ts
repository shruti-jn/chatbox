import { test } from '@playwright/test'

/**
 * CP4 / SHR-128 A2
 *
 * Flow:
 * 1. District admin opens analytics.
 * 2. Admin drills down by district, school, and classroom.
 * 3. Rendered data and API payload contain pseudonymous identifiers only.
 *
 * Notes:
 * - Classroom analytics backend currently returns displayName fields.
 * - Keep this spec pending until analytics UI and pseudonymous payload guarantees land.
 */

test.describe('CP4 admin analytics privacy', () => {
  test.fixme('admin analytics stays pseudonymous in both UI and network payloads', async () => {})
})
