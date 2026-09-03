import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4173', trace: 'on-first-retry' },
  webServer: process.env.QUICK_MOVER_FILE_TEST
    ? undefined
    : {
        command: './node_modules/.bin/vite --config tests/vite.config.ts',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: !process.env.CI
      }
})
