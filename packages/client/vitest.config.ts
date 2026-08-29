import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // See the note in packages/server/vitest.config.ts: the prediction test
    // spawns a real server process and measures timing against it.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
  resolve: {
    conditions: ['development', 'import', 'node'],
  },
});
