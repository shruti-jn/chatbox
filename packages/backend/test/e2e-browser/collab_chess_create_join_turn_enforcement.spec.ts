import { test } from '@playwright/test'

/**
 * CP4 / SHR-126 A1
 *
 * Flow:
 * 1. Student A creates a collaborative chess session.
 * 2. Student B joins by code.
 * 3. A makes one legal move.
 * 4. A is rejected when attempting a second immediate move.
 * 5. B can then move.
 *
 * Notes:
 * - Collaborative session create/join routes exist.
 * - Turn-enforced multi-user chess browser UX is not yet exposed in this harness.
 */

test.describe('CP4 collaborative chess turn enforcement', () => {
  test.fixme('two students can create, join, and obey turn order in collaborative chess', async () => {})
})
