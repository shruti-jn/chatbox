import { test } from '@playwright/test'

/**
 * CP4 / SHR-129 A2
 *
 * Flow:
 * 1. Simulate LMS deep-link launch.
 * 2. Teacher selects a chess activity.
 * 3. Launch returns to ChatBridge and opens the linked activity/session.
 *
 * Notes:
 * - LTI OIDC initiate + launch endpoints exist in auth.ts.
 * - Deep-link authoring/selection UI is not yet exposed in this browser harness.
 */

test.describe('CP4 LTI deep linking', () => {
  test.fixme('LTI deep link launches the selected chess activity in ChatBridge', async () => {})
})
