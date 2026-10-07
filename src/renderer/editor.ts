import type { ThemeState } from '@shared/contracts.js';
import { requireElement } from './ui/dom.js';
import { watchModified } from './ui/editor-modified.js';
import {
  createTerminalView,
  ensureTerminalRenderer,
  TERMINAL_THEMES,
  type TerminalView,
} from './ui/terminal-view.js';
import { applyUiFontSize } from './ui/ui-font.js';

/**
 * An editor window: one file, open in the editor program, in a terminal of its own.
 *
 * A renderer over the same preload bridge as the other pages, so it can do nothing they cannot. It
 * names no file and no process: the main process knows which file this window is for and routes the
 * program's output here alone, so all this page does is draw a terminal and carry keys and geometry.
 *
 * The terminal is `createTerminalView`, the dashboard's own. The xterm options in it are each a bug
 * paid for once, and a full-screen editor is exactly the kind of program they were tuned for.
 */
class EditorPage {
  private view: TerminalView | null = null;
  /** Last geometry announced to the pty: a resize of the same size makes ConPTY reprint the screen. */
  private sent: { cols: number; rows: number } | null = null;
  private readonly host = requireElement('editor-terminal');
  private readonly status = requireElement('editor-status');
  private readonly unsaved = requireElement('editor-unsaved');

  async start(): Promise<void> {
    const bootstrap = await window.api.bootstrap();
    applyTheme(bootstrap.theme);
    applyUiFontSize(bootstrap.settings.uiFontSize);

    const view = createTerminalView({
      fontSize: bootstrap.settings.terminalFontSize,
      theme: bootstrap.theme.resolved,
      compat: bootstrap.terminalCompat,
      onInput: (data) => window.api.sendEditorInput(data),
      onCopy: (text) => void window.api.writeClipboard(text),
      onPasteRequest: () => window.api.readClipboard(),
      onOpenLink: (url) => void window.api.openExternal(url),
    });
    view.element.hidden = false;
    this.host.append(view.element);
    this.view = view;

    window.api.onEditorOutput((data) => view.term.write(data));
    // Read off the editor's status line: shown at the top, and what the close question depends on.
    watchModified(view, (modified) => {
      this.unsaved.hidden = !modified;
      window.api.reportEditorModified(modified);
      this.fit();
    });
    window.api.onEditorExited((exitCode) => {
      this.say(`The editor ended with exit code ${exitCode}. Close this window when you have read it.`);
    });
    window.api.onThemeChanged((state) => {
      applyTheme(state);
      view.term.options.theme = TERMINAL_THEMES[state.resolved];
    });
    window.api.onSettingsChanged((settings) => {
      applyUiFontSize(settings.uiFontSize);
      if (view.term.options.fontSize !== settings.terminalFontSize) {
        view.term.options.fontSize = settings.terminalFontSize;
        this.fit();
      }
    });
    window.addEventListener('resize', () => this.fit());

    // Measured before the program starts, so it draws its first frame at the size it will keep.
    ensureTerminalRenderer(view);
    this.fit();
    const answer = await window.api.startEditor({ cols: view.term.cols, rows: view.term.rows });
    if (answer.title.length > 0) {
      document.title = answer.title;
    }
    if (!answer.ok) {
      this.say(answer.message);
      return;
    }
    view.term.focus();
  }

  private fit(): void {
    const view = this.view;
    if (view === null) {
      return;
    }
    try {
      view.fit.fit();
    } catch {
      // Zero size mid-layout; the next resize event has real dimensions.
      return;
    }
    const { cols, rows } = view.term;
    if (this.sent?.cols === cols && this.sent.rows === rows) {
      return;
    }
    this.sent = { cols, rows };
    window.api.resizeEditor({ cols, rows });
  }

  private say(message: string): void {
    this.status.textContent = message;
    this.status.hidden = false;
    this.fit();
  }
}

function applyTheme(state: ThemeState): void {
  document.documentElement.dataset.theme = state.resolved;
}

void new EditorPage().start().catch((error: unknown) => {
  console.error('[editor] editor window failed to start:', error);
});
