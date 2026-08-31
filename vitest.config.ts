import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Not a pure unit suite: around 60 tests fork a real `git` against a temporary repository and a
    // few drive a real pty, so their duration follows process spawning and disk, not the code under
    // test. Between this machine and a CI runner the same file measured 12.5 s and 8.9 s: the spread
    // is a factor of 2 in either direction, and Vitest's 5 s default has no room for the bad side.
    testTimeout: 30_000,
  },
});
