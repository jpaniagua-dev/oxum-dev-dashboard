import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import type { WindowBounds } from '@shared/contracts.js';
import type { WindowStateStore } from './store/window-state.js';

const BOUNDS_SAVE_DEBOUNCE_MS = 400;

/**
 * The dashboard window.
 *
 * Unlike the sibling prompt editor, this is not a popup: it is a window you leave open on a second
 * monitor, so it is neither always-on-top nor hidden on close. Closing it really does quit, which
 * is why the quit path asks for confirmation when it owns running dev servers.
 */
export class DashboardWindow {
  private window: BrowserWindow | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly stateStore: WindowStateStore) {}

  async create(options: { preloadPath: string; backgroundColor: string }): Promise<BrowserWindow> {
    const bounds = await this.stateStore.load();

    const window = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      ...resolvePosition(bounds),
      minWidth: 900,
      minHeight: 560,
      show: false,
      title: 'Oxum Dev Dashboard',
      // Matches the resolved theme: this is the colour painted before the page renders.
      backgroundColor: options.backgroundColor,
      webPreferences: {
        preload: options.preloadPath,
        // The renderer displays branch names, error text and pull request titles from outside, so
        // it gets no Node access and cannot reach the filesystem.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    window.setMenuBarVisibility(false);

    // Any link opens in the real browser rather than hijacking the dashboard.
    window.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });

    window.on('resize', () => this.scheduleBoundsSave());
    window.on('move', () => this.scheduleBoundsSave());
    window.once('ready-to-show', () => window.show());

    this.window = window;
    return window;
  }

  get browserWindow(): BrowserWindow | null {
    return this.window;
  }

  send(channel: string, payload: unknown): void {
    const window = this.window;
    if (window !== null && !window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }

  setBackgroundColor(color: string): void {
    this.window?.setBackgroundColor(color);
  }

  async saveBounds(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const window = this.window;
    if (window === null || window.isDestroyed()) {
      return;
    }
    await this.stateStore.save(window.getBounds());
  }

  private scheduleBoundsSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      void this.saveBounds();
    }, BOUNDS_SAVE_DEBOUNCE_MS);
  }
}

/** Resolves the preload script path for both dev and packaged runs. */
export function preloadPath(): string {
  return join(__dirname, '../preload/index.js');
}

/** `-1/-1` means "never positioned yet": let Electron centre the window. */
function resolvePosition(bounds: WindowBounds): { x?: number; y?: number; center?: boolean } {
  if (bounds.x === -1 && bounds.y === -1) {
    return { center: true };
  }
  return { x: bounds.x, y: bounds.y };
}
