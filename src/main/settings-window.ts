import { BrowserWindow, dialog, shell } from 'electron';
import type { WindowBounds } from '@shared/contracts.js';
import type { WindowStateStore } from './store/window-state.js';
import { forwardConsole, loadRendererPage, windowIcon } from './window.js';

const BOUNDS_SAVE_DEBOUNCE_MS = 400;

/**
 * Default shape of the settings window.
 *
 * Tall rather than wide: the content is a vertical list of project and profile cards, so height is
 * what removes scrolling.
 */
export const SETTINGS_WINDOW_BOUNDS: WindowBounds = { x: -1, y: -1, width: 880, height: 820 };

/**
 * The settings window.
 *
 * A window of its own rather than an overlay in the dashboard. As a modal it fought normal text
 * selection (releasing the button outside the panel closed it) and it hid the table it configures.
 * A separate window can sit next to the dashboard, be moved to another monitor, and stay open while
 * the rows update behind it.
 *
 * Deliberately not an Electron child window: a `parent` would keep it pinned above the dashboard and
 * drag it along when the dashboard is minimised, which is the opposite of "fenêtre à part entière".
 */
export class SettingsWindow {
  private window: BrowserWindow | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  /**
   * Unsaved edits, reported by the renderer.
   *
   * Held here because the confirmation has to happen in the window's own `close` handler, which is
   * the only place that can still cancel it.
   */
  private dirty = false;

  constructor(
    private readonly stateStore: WindowStateStore,
    private readonly options: {
      readonly preloadPath: string;
      readonly backgroundColor: () => string;
    },
  ) {}

  get browserWindow(): BrowserWindow | null {
    return this.window;
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
      minWidth: 620,
      minHeight: 480,
      show: false,
      title: 'Réglages — Oxum Dev Dashboard',
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
    forwardConsole(window, 'settings');
    window.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });

    window.on('resize', () => this.scheduleBoundsSave());
    window.on('move', () => this.scheduleBoundsSave());
    window.once('ready-to-show', () => window.show());

    // Asked synchronously: a `close` handler can only cancel the close before it returns, so the
    // question cannot be awaited.
    window.on('close', (event) => {
      if (!this.dirty) {
        return;
      }
      const { response } = dialogSync(window);
      if (response === 1) {
        event.preventDefault();
      } else {
        this.dirty = false;
      }
    });

    window.on('closed', () => {
      this.window = null;
      this.dirty = false;
    });

    this.window = window;
    await loadRendererPage(window, 'settings.html');
  }

  /** Records the renderer's unsaved-changes state, used by the close confirmation. */
  setDirty(dirty: boolean): void {
    this.dirty = dirty;
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

  private scheduleBoundsSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      const window = this.window;
      if (window !== null && !window.isDestroyed()) {
        void this.stateStore.save(window.getBounds());
      }
    }, BOUNDS_SAVE_DEBOUNCE_MS);
  }
}

/** The unsaved-changes prompt, kept out of the handler so the flow above stays readable. */
function dialogSync(window: BrowserWindow): { response: number } {
  const response = dialog.showMessageBoxSync(window, {
    type: 'warning',
    buttons: ['Fermer sans enregistrer', 'Annuler'],
    defaultId: 1,
    cancelId: 1,
    title: 'Réglages',
    message: 'Des modifications ne sont pas enregistrées.',
    detail: 'Fermer maintenant les perdra.',
  });
  return { response };
}
