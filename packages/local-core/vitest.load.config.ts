import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['load/**/*.load.test.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1
  }
});
