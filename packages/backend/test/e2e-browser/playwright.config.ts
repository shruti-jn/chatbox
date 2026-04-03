import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'cd ../.. && set -a && source ../../.env && set +a && DATABASE_URL="postgresql://chatbridge:chatbridge@localhost:5435/chatbridge" npx tsx src/server.ts',
      port: 3001,
      reuseExistingServer: true,
    },
    {
      command: 'npx serve ../../../release/app/dist/renderer -l 3000 --cors',
      port: 3000,
      reuseExistingServer: true,
    },
  ],
})
