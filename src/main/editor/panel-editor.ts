import type { IPty } from '@lydell/node-pty';
import type { WebContents } from 'electron';
import { IpcChannel, type TerminalSize } from '@shared/contracts.js';
import {
  IDLE_PANEL_EDITOR,
  type ExplorerOpenResult,
  type PanelEditorState,
} from '@shared/explorer.js';
import { killTree } from '../terminal/terminal-manager.js';
import { terminalEnvironment } from '../terminal/terminal-environment.js';
import { EDITOR_QUIT_KEY, spawnEditor, type EditorRequest } from './editor-process.js';
import type { EditorWindows } from './editor-windows.js';

/**
 * Said when a line was asked for a file an editor already shows.
 *
 * The start position is an argument, so it only applies when the editor starts. Moving the cursor of
 * a running one would mean typing into it blind, while it may be holding a prompt of its own, and
 * restarting it would ask about unsaved changes for a jump. The editor has its own gesture for this.
 */
export const ALREADY_OPEN_LINE_HINT = 'Ctrl+L goes to a line in micro';

/** A file waiting for the current editor to quit, and where it goes once it has. */
interface Pending {
  readonly request: EditorRequest;
  readonly target: 'panel' | 'window';
}

/**
 * The editor beside the Explorer's list: one process at a time, shown in the dashboard.
 *
 * Like the editor windows, it is **not** a `TerminalManager` session: it never appears among the
 * terminal tabs, and its output goes to the dashboard on its own channel. One owner per pty is the
 * rule the removal of the servers window wrote down.
 *
 * ⚠️ **Opening another file asks the editor to quit; it never kills it.** The app cannot tell whether
 * the buffer is saved, and the editor can: `EDITOR_QUIT_KEY` makes a clean editor exit at once and a
 * modified one ask "Save changes?" in the panel. The next file is started from the exit, whatever the
 * answer was, and a cancelled quit simply leaves it waiting (the panel says so, and the next click
 * replaces it).
 *
 * A file that already has a window of its own is brought forward there rather than opened twice.
 */
export class PanelEditor {
  private pty: IPty | null = null;
  private state: PanelEditorState = IDLE_PANEL_EDITOR;
  private request: EditorRequest | null = null;
  private pending: Pending | null = null;
  private size: TerminalSize = { cols: 100, rows: 24 };
  /** Unsaved changes, as the dashboard reads them off the editor's status line. */
  private modified = false;
  private counter = 0;

  constructor(
    private readonly deps: {
      /** The dashboard's page, the only one allowed to drive this editor. */
      readonly owner: () => Pick<WebContents, 'id' | 'send'> | null;
      readonly windows: Pick<EditorWindows, 'has' | 'open'>;
      /** Starts the editor's process. `spawnEditor` in the app, a fake in a test. */
      readonly spawn?: (request: EditorRequest, size: TerminalSize) => IPty;
    },
  ) {}

  read(): PanelEditorState {
    return this.state;
  }

  /** Whether a page may type into this editor: the dashboard, and nothing else. */
  ownedBy(sender: Pick<WebContents, 'id'>): boolean {
    return this.deps.owner()?.id === sender.id;
  }

  /** Shows a file beside the list. */
  open(request: EditorRequest, size: TerminalSize): ExplorerOpenResult {
    this.size = size;
    if (this.deps.windows.has(request.key)) {
      this.deps.windows.open(request);
      return {
        ok: true,
        message: `Already open in its own window${request.line === null ? '' : `. ${ALREADY_OPEN_LINE_HINT}`}`,
      };
    }
    if (this.pty !== null && this.request?.key === request.key) {
      // The same file again: drop a file that was waiting, the click says this one is wanted.
      this.pending = null;
      this.publish({ pending: null });
      return { ok: true, message: request.line === null ? '' : `Already open here. ${ALREADY_OPEN_LINE_HINT}` };
    }
    if (this.pty !== null) {
      this.pending = { request, target: 'panel' };
      this.pty.write(EDITOR_QUIT_KEY);
      this.publish({ pending: request.title });
      return { ok: true, message: '' };
    }
    this.start(request);
    return { ok: true, message: '' };
  }

  /** Moves a file to a window of its own, once the panel's editor has let go of it. */
  popOut(request: EditorRequest): ExplorerOpenResult {
    if (this.pty !== null && this.request?.key === request.key) {
      this.pending = { request, target: 'window' };
      this.pty.write(EDITOR_QUIT_KEY);
      this.publish({ pending: request.title });
      return { ok: true, message: '' };
    }
    this.deps.windows.open(request);
    return { ok: true, message: '' };
  }

  /** Asks the editor to quit, and leaves the panel empty once it has. */
  close(): void {
    this.pending = null;
    if (this.pty !== null) {
      this.pty.write(EDITOR_QUIT_KEY);
      this.publish({ pending: null });
      return;
    }
    this.request = null;
    this.state = IDLE_PANEL_EDITOR;
    this.send(this.state);
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(size: TerminalSize): void {
    this.size = size;
    try {
      this.pty?.resize(size.cols, size.rows);
    } catch {
      // A resize racing the process's exit: nothing left to resize.
    }
  }

  setModified(modified: boolean): void {
    this.modified = modified;
  }

  /** 1 while the editor here holds unsaved changes, which the dashboard's quit confirmation counts. */
  modifiedCount(): number {
    return this.pty !== null && this.modified ? 1 : 0;
  }

  /** Ends the editor without asking: the caller already did. */
  stop(): void {
    const child = this.pty;
    this.pty = null;
    this.pending = null;
    if (child !== null) {
      killTree(child);
    }
  }

  private start(request: EditorRequest): void {
    this.counter += 1;
    const session = this.counter;
    this.request = request;
    this.pending = null;
    this.modified = false;
    let child: IPty;
    try {
      child = (this.deps.spawn ?? ((what, size) => spawnEditor(what, size, terminalEnvironment(process.env))))(
        request,
        this.size,
      );
    } catch (error) {
      this.pty = null;
      this.state = {
        ...IDLE_PANEL_EDITOR,
        session,
        projectId: request.projectId,
        path: request.path,
        title: request.title,
        message: `Could not launch ${request.file}: ${error instanceof Error ? error.message : String(error)}`,
      };
      this.send(this.state);
      return;
    }
    this.pty = child;
    this.state = {
      session,
      projectId: request.projectId,
      path: request.path,
      title: request.title,
      running: true,
      exitCode: null,
      pending: null,
      message: '',
    };
    this.send(this.state);

    child.onData((data) => {
      if (this.pty === child) {
        this.deps.owner()?.send(IpcChannel.PanelEditorOutput, data);
      }
    });
    child.onExit(({ exitCode }) => {
      if (this.pty !== child) {
        return;
      }
      this.pty = null;
      this.modified = false;
      const next = this.pending;
      this.pending = null;
      if (next !== null) {
        if (next.target === 'window') {
          this.request = null;
          this.state = IDLE_PANEL_EDITOR;
          this.send(this.state);
          this.deps.windows.open(next.request);
        } else {
          this.start(next.request);
        }
        return;
      }
      if (exitCode === 0) {
        // Quit on purpose: the panel goes back to the list's hint.
        this.request = null;
        this.state = IDLE_PANEL_EDITOR;
      } else {
        // Anything else stays on screen with its output, the only account of what went wrong.
        this.state = { ...this.state, running: false, exitCode, pending: null };
      }
      this.send(this.state);
    });
  }

  private publish(change: Partial<PanelEditorState>): void {
    this.state = { ...this.state, ...change };
    this.send(this.state);
  }

  private send(state: PanelEditorState): void {
    this.deps.owner()?.send(IpcChannel.PanelEditorState, state);
  }
}
