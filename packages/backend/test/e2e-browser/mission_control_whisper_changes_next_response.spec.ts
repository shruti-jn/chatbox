import { test } from '@playwright/test'

/**
 * CP4 / SHR-125 A1
 *
 * Flow:
 * 1. Teacher opens a student tile in Mission Control.
 * 2. Teacher sends a whisper.
 * 3. Student sends a normal prompt.
 * 4. The next AI response reflects the whisper guidance.
 *
 * Existing coverage:
 * - See shr115-whisper.spec.ts for current API + persistence validation.
 *
 * TODO:
 * - Convert the live whisper verification to a teacher/student browser path once
 *   the Mission Control whisper UI is available in the renderer.
 */

test.describe('CP4 Mission Control whisper', () => {
  test.fixme('teacher whisper changes the next student response from the browser', async () => {})
})
