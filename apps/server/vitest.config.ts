import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // better-sqlite3 is a native module; forks are the safe pool for it.
    pool: 'forks',
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
