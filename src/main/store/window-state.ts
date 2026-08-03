import { readFile } from 'node:fs/promises';
import { screen } from 'electron';
import type { WindowBounds } from '@shared/contracts.js';
import { atomicWriteFile, fileExists } from './atomic-write.js';
import { DEFAULT_BOUNDS } from './settings-store.js';

/**
 * Remembers where the popup was last placed.
 *
 * Bounds are validated against the current displays on load: a window restored onto a
 * monitor that is no longer connected would otherwise open off-screen and look like a
 * broken shortcut.
 */
export class WindowStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<WindowBounds> {
    if (!fileExists(this.filePath)) {
      return { ...DEFAULT_BOUNDS };
    }
    try {
      const raw: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      return validateBounds(raw);
    } catch {
      return { ...DEFAULT_BOUNDS };
    }
  }

  async save(bounds: WindowBounds): Promise<void> {
    try {
      await atomicWriteFile(this.filePath, `${JSON.stringify(bounds, null, 2)}\n`);
    } catch (error) {
      console.error('[window-state] failed to persist bounds', error);
    }
  }
}

/** Falls back to defaults unless the bounds are sane and land on a connected display. */
function validateBounds(raw: unknown): WindowBounds {
  if (typeof raw !== 'object' || raw === null) {
    return { ...DEFAULT_BOUNDS };
  }
  const input = raw as Record<string, unknown>;
  const bounds: WindowBounds = {
    x: typeof input.x === 'number' ? Math.round(input.x) : DEFAULT_BOUNDS.x,
    y: typeof input.y === 'number' ? Math.round(input.y) : DEFAULT_BOUNDS.y,
    width: typeof input.width === 'number' ? Math.round(input.width) : DEFAULT_BOUNDS.width,
    height: typeof input.height === 'number' ? Math.round(input.height) : DEFAULT_BOUNDS.height,
  };

  if (bounds.width < 380 || bounds.height < 260) {
    return { ...DEFAULT_BOUNDS };
  }
  if (bounds.x === -1 && bounds.y === -1) {
    return bounds;
  }

  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  });

  return visible ? bounds : { ...DEFAULT_BOUNDS };
}
