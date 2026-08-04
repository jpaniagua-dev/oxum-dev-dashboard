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
  /**
   * @param defaults Size to fall back to. Passed in because the settings window is a different
   * shape from the dashboard, and a store that only ever knew the dashboard's bounds would open it
   * at the wrong size on first launch.
   */
  constructor(
    private readonly filePath: string,
    private readonly defaults: WindowBounds = DEFAULT_BOUNDS,
  ) {}

  async load(): Promise<WindowBounds> {
    if (!fileExists(this.filePath)) {
      return { ...this.defaults };
    }
    try {
      const raw: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      return validateBounds(raw, this.defaults);
    } catch {
      return { ...this.defaults };
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
function validateBounds(raw: unknown, defaults: WindowBounds): WindowBounds {
  if (typeof raw !== 'object' || raw === null) {
    return { ...defaults };
  }
  const input = raw as Record<string, unknown>;
  const bounds: WindowBounds = {
    x: typeof input.x === 'number' ? Math.round(input.x) : defaults.x,
    y: typeof input.y === 'number' ? Math.round(input.y) : defaults.y,
    width: typeof input.width === 'number' ? Math.round(input.width) : defaults.width,
    height: typeof input.height === 'number' ? Math.round(input.height) : defaults.height,
  };

  if (bounds.width < 380 || bounds.height < 260) {
    return { ...defaults };
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

  return visible ? bounds : { ...defaults };
}
