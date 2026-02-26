import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Retry flaky tests up to 2 times before marking as failed
    // Alert rule evaluations can be timing-sensitive on loaded CI runners
    retry: 2,
  },
});
