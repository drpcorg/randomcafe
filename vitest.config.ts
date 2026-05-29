import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.integration.test.ts', 'node_modules/**', 'dist/**'],
    globals: true,
    restoreMocks: true,
    testTimeout: 120_000,
  },
});
