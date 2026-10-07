import type { IPty } from '@lydell/node-pty';
import { BrowserWindow, dialog, shell, type WebContents } from 'electron';
import { IpcChannel, type EditorStart, type TerminalSize } from '@shared/contracts.js';
import { killTree } from '../terminal/terminal-manager.js';
import { spawnEditor, type EditorRequest } from './editor-process.js';
import { terminalEnvironment } from '../terminal/terminal-environment.js';
import { forwardConsole, loadRendererPage, windowIcon } from '../window.js';

interface Editor {
  readonly request: EditorRequest;
  readonly window: BrowserWindow;
  pty: IPty | null;
  /** Set once the user agreed to lose unsaved work, or the program ended: the next close goes through. */
  closing: boolean;
  /** Unsaved changes, as the page reads them off the editor's status line. */
  modified: boolean;
}

/**
 * The editor windows: one per open file, each running the editor program in a pty of its own.
 *
 * ⚠️ **Deliberately outside `TerminalManager`.** The servers window removed in 10.0.0 showed sessions
 * the dashboard also owned, and that second owner cost a session ownership map, a filtered layout and
 * three routed channels. These windows own their pty outright: it is not a session, it never appears
 * in the dashboard's tabs, and its output goes to one `webContents` only. The renderer side reuses
 * `createTerminalView`, so the terminal itself is the same hard-won configuration.
 *
 * The window is identified by the `webContents` that sends, never by an id from the renderer: a page
 * can only ever type into, resize or read its own editor.
 *
 * The pty is spawned when the page says it is ready and how big it is, not when the window opens.
 * A full-screen editor draws for the size it starts at; started at a guess and resized a moment later,
 * it redraws at best and leaves the first frame's debris at worst.
 */
export class EditorWindows {
  private readonly byKey = new Map<string, Editor>();
  private readonly byContents = new Map<number, Editor>();

  constructor(
    private readonly options: {
      readonly preloadPath: string;
      readonly backgroundColor: () => string;
    },
  ) {}

  /** Opens a file's window, or brings forward the one already showing it. */
  open(request: EditorRequest): void {
    const existing = this.byKey.get(request.key);
    if (existing !== undefined && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) {
        existing.window.restore();
      }
      existing.window.show();
      existing.window.focus();
      return;
    }

    const window = new BrowserWindow({
      width: 980,
      height: 720,
      minWidth: 420,
      minHeight: 240,
      show: false,
      title: request.title,
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
    const editor: Editor = { request, window, pty: null, closing: false, modified: false };
    const contentsId = window.webContents.id;
    this.byKey.set(request.key, editor);
    this.byContents.set(contentsId, editor);

    window.setMenuBarVisibility(false);
    forwardConsole(window, 'editor');
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    // The file is the title, not the page's own `<title>`, which is the same for every editor.
    window.on('page-title-updated', (event) => event.preventDefault());
    window.once('ready-to-show', () => window.show());

    // Asked only when the page saw unsaved changes on the editor's status line: a question on every
    // close was one nobody read. Quitting the editor itself closes the window without a question,
    // since it asks about its own unsaved work.
    window.on('close', (event) => {
      if (editor.closing || editor.pty === null || !editor.modified) {
        return;
      }
      event.preventDefault();
      void dialog
        .showMessageBox(window, {
          type: 'warning',
          buttons: ['Close', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'Close the editor',
          message: `${request.title} has unsaved changes.`,
          detail: 'Closing the window now loses them.',
        })
        .then(({ response }) => {
          if (response === 0 && !window.isDestroyed()) {
            editor.closing = true;
            window.close();
          }
        });
    });

    window.on('closed', () => {
      this.stop(editor);
      this.byKey.delete(request.key);
      this.byContents.delete(contentsId);
    });

    void loadRendererPage(window, 'editor.html');
  }

  /**
   * Starts the editor of the page that asks, at the size it measured. Called once per page load; a
   * reload of a page whose editor still runs gets the same answer without a second process.
   */
  start(sender: WebContents, size: TerminalSize): EditorStart {
    const editor = this.byContents.get(sender.id);
    if (editor === undefined) {
      return { ok: false, title: '', message: 'This window has no file to edit' };
    }
    const { request } = editor;
    if (editor.pty !== null) {
      return { ok: true, title: request.title, message: '' };
    }
    let child: IPty;
    try {
      child = spawnEditor(request, size, terminalEnvironment(process.env));
    } catch (error) {
      return {
        ok: false,
        title: request.title,
        message: `Could not launch ${request.file}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    editor.pty = child;
    child.onData((data) => {
      if (!editor.window.isDestroyed()) {
        editor.window.webContents.send(IpcChannel.EditorOutput, data);
      }
    });
    child.onExit(({ exitCode }) => {
      if (editor.pty !== child) {
        return;
      }
      editor.pty = null;
      if (editor.window.isDestroyed()) {
        return;
      }
      // A clean exit is the editor being quit: the window has done its job. Anything else stays on
      // screen, since the output is then the only account of what went wrong.
      if (exitCode === 0) {
        editor.closing = true;
        editor.window.close();
      } else {
        editor.window.webContents.send(IpcChannel.EditorExited, exitCode);
      }
    });
    return { ok: true, title: request.title, message: '' };
  }

  /** Records what the page read on the status line, and marks the title the way editors do. */
  setModified(sender: WebContents, modified: boolean): void {
    const editor = this.byContents.get(sender.id);
    if (editor === undefined || editor.modified === modified) {
      return;
    }
    editor.modified = modified;
    if (!editor.window.isDestroyed()) {
      editor.window.setTitle(modified ? `● ${editor.request.title}` : editor.request.title);
    }
  }

  write(sender: WebContents, data: string): void {
    this.byContents.get(sender.id)?.pty?.write(data);
  }

  resize(sender: WebContents, size: TerminalSize): void {
    try {
      this.byContents.get(sender.id)?.pty?.resize(size.cols, size.rows);
    } catch {
      // A resize racing the process's exit: nothing left to resize.
    }
  }

  /** Whether a file has a window of its own, which the panel's editor then defers to. */
  has(key: string): boolean {
    const editor = this.byKey.get(key);
    return editor !== undefined && !editor.window.isDestroyed();
  }

  /** How many windows hold unsaved changes, which the dashboard's quit confirmation counts. */
  modifiedCount(): number {
    let count = 0;
    for (const editor of this.byKey.values()) {
      if (editor.pty !== null && editor.modified) {
        count += 1;
      }
    }
    return count;
  }

  /** Ends every editor and its window, without asking: the caller already did. */
  closeAll(): void {
    for (const editor of [...this.byKey.values()]) {
      editor.closing = true;
      this.stop(editor);
      if (!editor.window.isDestroyed()) {
        editor.window.destroy();
      }
    }
  }

  setBackgroundColor(color: string): void {
    for (const editor of this.byKey.values()) {
      if (!editor.window.isDestroyed()) {
        editor.window.setBackgroundColor(color);
      }
    }
  }

  private stop(editor: Editor): void {
    const child = editor.pty;
    editor.pty = null;
    if (child !== null) {
      killTree(child);
    }
  }
}
