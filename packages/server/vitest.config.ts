import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each integration test file spawns a REAL server process — its own port,
    // its own uWebSockets event loop, its own 30 Hz tick. Running the files in
    // parallel puts three of those plus three test runners on the same cores,
    // and the timing-sensitive assertions (a 30-second reconnection window, a
    // 3-second countdown) start missing their deadlines for reasons that have
    // nothing to do with the code under test.
    //
    // Serial is also simply faster here: the bottleneck is CPU, not waiting.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    // Resolve `@pong/game-core` to its TypeScript source rather than to the
    // built `dist`, so tests exercise what you just edited.
    conditions: ['development', 'import', 'node'],
  },
});
