import { test } from '@playwright/test'

/**
 * CP4 / SHR-125 A2
 *
 * Flow:
 * 1. Teacher changes classroom AI mode to socratic.
 * 2. Student asks a direct question.
 * 3. The next response is guiding/questions-based rather than direct.
 *
 * Notes:
 * - Classroom config PATCH route exists.
 * - Browser classroom-config UI is not yet present in this test harness.
 * - Final assertion should run against a real model response in a browser session.
 */

test.describe('CP4 classroom socratic mode', () => {
  test.fixme('teacher can switch a classroom to socratic mode and affect the next student response', async () => {})
})
