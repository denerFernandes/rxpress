import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 30000,
    hookTimeout: 15000,
    fileParallelism: true,
  },
});
