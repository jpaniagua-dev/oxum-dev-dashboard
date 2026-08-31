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
    // few drive a real pty. The slowest sits at 2.4 s here, and a Windows CI runner is markedly
    // slower at spawning processes, so Vitest's 5 s default is a flake waiting for a slow day.
    testTimeout: 30_000,
  },
});
