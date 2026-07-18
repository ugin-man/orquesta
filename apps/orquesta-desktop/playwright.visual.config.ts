import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const configuredChromium = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const linuxChromium = '/usr/bin/chromium';
const executablePath = configuredChromium ?? (existsSync(linuxChromium) ? linuxChromium : undefined);

export default defineConfig({
  testDir: './tests/visual',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  outputDir: './test-results/visual',
  timeout: 30_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.002
    }
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    }
  },
  webServer: {
    command: 'node scripts/serve-dist.mjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe'
  }
});
