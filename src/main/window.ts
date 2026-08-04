import { app, BrowserWindow, shell } from 'electron';
import { existsSync } from 'node:fs';
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
      ...windowIcon(),
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
    forwardConsole(window, 'renderer');

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

/**
 * Window icon, and only in development.
 *
 * A packaged Windows app takes its icon from the executable, which electron-builder stamps from
 * `resources/icon.ico`; passing it here as well would be redundant, and the file is not inside the
 * bundle anyway. Running from source has no executable of its own, so without this the taskbar shows
 * the default Electron icon all day long.
 */
export function windowIcon(): { icon: string } | Record<string, never> {
  if (app.isPackaged) {
    return {};
  }
  // `__dirname` is `out/main` in development, so the project root is two levels up.
  const icon = join(__dirname, '../../resources/icon.ico');
  return existsSync(icon) ? { icon } : {};
}

/**
 * Loads one of the renderer pages, from the dev server when there is one and from disk otherwise.
 *
 * Shared by both windows: the app now ships two HTML entry points, and duplicating the dev-server
 * branch is how one of them ends up loading from disk in development and silently missing hot
 * reload.
 */
export async function loadRendererPage(
  window: BrowserWindow,
  page: 'index.html' | 'settings.html',
): Promise<void> {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl !== undefined && devServerUrl.length > 0) {
    await window.loadURL(`${devServerUrl.replace(/\/$/, '')}/${page}`);
    return;
  }
  await window.loadFile(join(__dirname, '../renderer', page));
}

/**
 * Forwards renderer console output to the main process log.
 *
 * Without this, an exception in a renderer is invisible from the terminal running the app: the
 * window simply behaves oddly with no trace anywhere, which cost real debugging time.
 */
export function forwardConsole(window: BrowserWindow, label: string): void {
  window.webContents.on('console-message', (event) => {
    const level = event.level === 'error' || event.level === 'warning' ? event.level : 'info';
    console.log(`[${label}:${level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
}

/** `-1/-1` means "never positioned yet": let Electron centre the window. */
function resolvePosition(bounds: WindowBounds): { x?: number; y?: number; center?: boolean } {
  if (bounds.x === -1 && bounds.y === -1) {
    return { center: true };
  }
  return { x: bounds.x, y: bounds.y };
}
