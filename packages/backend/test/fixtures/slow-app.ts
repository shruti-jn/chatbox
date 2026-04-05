/**
 * Slow app fixture for testing 5s tool invocation timeout.
 *
 * Simulates an app whose tool takes longer than the 5s budget.
 * Used by apps.test.ts to verify the timeout mechanism fires.
 */

export const SLOW_APP_PAYLOAD = {
  name: 'Slow Test App',
  description: 'An app that simulates slow tool execution for timeout testing',
  toolDefinitions: [
    {
      name: 'slow_operation',
      description: 'A tool that takes 10 seconds to complete (exceeds 5s timeout)',
      inputSchema: { type: 'object', properties: { delayMs: { type: 'number' } } },
    },
  ],
  uiManifest: { url: 'https://test.example.com/slow-app' },
  permissions: { network: true },
  complianceMetadata: { coppaCompliant: true },
  version: '1.0.0',
}
