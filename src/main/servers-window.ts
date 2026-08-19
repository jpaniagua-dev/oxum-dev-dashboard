import { BrowserWindow, shell } from 'electron';
import type { WindowBounds } from '@shared/contracts.js';
import type { WindowStateStore } from './store/window-state.js';
import { forwardConsole, loadRendererPage, windowIcon } from './window.js';

const BOUNDS_SAVE_DEBOUNCE_MS = 400;

/**
 * Default shape of the servers window.
 *
 * Wide rather than tall, the opposite of the settings window and for the opposite reason: the content is
 * a row of terminals side by side, and width is what keeps each one wide enough for a build log to stop
 * wrapping. Large enough to be dropped on a second monitor and left there, which is what it is for.
 */
export const SERVERS_WINDOW_BOUNDS: WindowBounds = { x: -1, y: -1, width: 1280, height: 720 };

/**
 * The window that holds the dev servers.
 *
 * Its reason to exist is a glance: every server visible at once, so "does one of them need me" is
 * answered without reading a line and without cycling through tabs. That is why it is a **grid** and not
 * a second copy of the dashboard's pane surface, and why it has no tab bar, no splitter and no layout to
 * persist. Its arrangement is derived from the sessions it owns, so there is nothing to keep in sync.
 *
 * Same two decisions as the settings window, and for the same reasons:
 *
 * - **Not an Electron child window.** A `parent` would keep it pinned above the dashboard and drag it
 *   along when the dashboard is minimised, which is the opposite of a window you park on another screen.
 * - **Its own bounds**, so the position it was left in on that screen is where it comes back.
 *
 * What it adds over the settings window is a **lifecycle obligation**. It paints processes, and this app
 * does not let work run where it can neither be shown nor stopped. So closing it must hand the sessions
 * back to the dashboard rather than leave them owned by a window that no longer exists, which is what
 * `onClosed` is for and why it is not optional.
 */
export class ServersWindow {
  private window: BrowserWindow | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly stateStore: WindowStateStore,
    private readonly options: {
      readonly preloadPath: string;
      readonly backgroundColor: () => string;
      /**
       * Called once the window is gone, however it went.
       *
       * The hand-back of the sessions lives here rather than in a `close` handler on purpose: `close`
       * can still be cancelled, and re-attaching sessions to a window that then stays open would leave
       * the servers painted in two places. `closed` is the only moment the window is certainly gone.
       */
      readonly onClosed: () => void;
    },
  ) {}

  get browserWindow(): BrowserWindow | null {
    return this.window;
  }

  get isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  /** Opens the window, or brings the existing one forward. */
  async open(): Promise<void> {
    const existing = this.window;
    if (existing !== null && !existing.isDestroyed()) {
      if (existing.isMinimized()) {
        existing.restore();
      }
      existing.show();
      existing.focus();
      return;
    }

    const bounds = await this.stateStore.load();
    const window = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      ...(bounds.x === -1 && bounds.y === -1 ? { center: true } : { x: bounds.x, y: bounds.y }),
      minWidth: 480,
      minHeight: 320,
      show: false,
      title: 'Servers - Oxum Dev Dashboard',
      ...windowIcon(),
      backgroundColor: this.options.backgroundColor(),
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    window.setMenuBarVisibility(false);
    forwardConsole(window, 'servers');
    // A URL printed by a dev server and clicked in a tile goes to the real browser, never into this
    // window: the same rule the dashboard's terminals follow, and the reason the link handler is ours.
    window.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });

    window.on('resize', () => this.scheduleBoundsSave());
    window.on('move', () => this.scheduleBoundsSave());
    window.once('ready-to-show', () => window.show());

    window.on('closed', () => {
      this.window = null;
      this.options.onClosed();
    });

    this.window = window;
    await loadRendererPage(window, 'servers.html');
  }

  /** Closes the window if it is open. `closed` then hands the sessions back. */
  close(): void {
    const window = this.window;
    if (window !== null && !window.isDestroyed()) {
      window.close();
    }
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

  /**
   * Saves the bounds after a pause, not on every event.
   *
   * A drag across a monitor fires dozens of `move` events, and writing the file on each one is a write
   * per frame for a value only the last of which matters. Same debounce as the other two windows.
   */
  private scheduleBoundsSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveBounds();
    }, BOUNDS_SAVE_DEBOUNCE_MS);
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
}
