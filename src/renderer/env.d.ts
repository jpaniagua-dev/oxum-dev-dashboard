import type { RendererApi } from '../shared/contracts.js';

/**
 * The bridge the preload script installs, as seen from the renderer.
 *
 * Declared beside the renderer rather than next to the preload source: TypeScript skips a
 * `foo.d.ts` when a `foo.ts` sits in the same directory, so an ambient declaration in
 * `src/preload/` is silently dropped from any project that also compiles `src/preload/index.ts`.
 */
declare global {
  interface Window {
    readonly api: RendererApi;
  }
}

export {};
