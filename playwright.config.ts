import { defineConfig } from '@playwright/test';

// E2E_PORT lets the suite target another preview server when 4173 is taken.
const port = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/.out/results',
  globalSetup: './e2e/global-setup.ts',
  // Stations share one simulated room per browser context; keep each file's tests in order.
  fullyParallel: false,
  workers: process.env.CI ? 1 : 2,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  // Sound is slow: one message is a few seconds of airtime, plus random relay backoff.
  timeout: 120_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
