import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/renderer/test/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    css: true,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 2
  }
});
