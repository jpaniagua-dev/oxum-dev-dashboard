import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { TERMINAL_FONT_SIZE, type ResolvedTheme, type TerminalCompat } from '@shared/contracts.js';
import { createElement } from './dom.js';

/**
 * One xterm instance, configured the way this app has learned it has to be.
 *
 * Lifted out of `TerminalPane` unchanged, and the reason is worth stating plainly: almost every option
 * below is a bug that was paid for once, and each of them fails in a way that looks like something
 * else. The ConPTY double-reflow leaves characters stranded on screen; a WebGL canvas born on a hidden
 * element shows up later as frozen glyphs; `convertEol` makes a full-screen TUI redraw at the wrong
 * column. A **second** copy of this configuration, written for a second window, would drift from this
 * one on exactly those details, and the drift would be invisible until someone reported a terminal that
 * "looks wrong" in one window and not the other.
 *
 * That is the failure this codebase has already recorded twice, with `verdictFor` / `isStaged` and with
 * the context menu's dismissal rule. One definition, two consumers.
 *
 * What is **not** here is anything about panes: no surface to attach to, no tab order, no focus, no
 * layout. Those belong to whoever owns the arrangement, and they are the whole reason a second window
 * can look nothing like the first while driving identical terminals.
 */

/** What a key combination should do inside a terminal. */
export type TerminalKeyAction = 'copy' | 'paste' | 'pass';

/**
 * Decides what `Ctrl`-based keys mean in a terminal.
 *
 * The whole difficulty is `Ctrl+C`. In a terminal it is **SIGINT**, and it has to stay SIGINT: it is how a
 * dev server gets stopped. But it is also the copy shortcut everywhere else, which is why Windows Terminal
 * resolves it the same way this does: **copy when there is a selection, interrupt when there is not**. With
 * `Shift` held it always copies, since `Ctrl+Shift+C` means nothing to a shell.
 *
 * `Ctrl+V` never has a terminal meaning worth keeping, so it always pastes.
 *
 * Pure and exported: this is a two-line rule whose failure modes are "cannot copy" and, far worse,
 * "cannot interrupt a build".
 */
export function decideTerminalKey(
  event: Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  hasSelection: boolean,
): TerminalKeyAction {
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) {
    return 'pass';
  }
  const key = event.key.toLowerCase();
  if (key === 'v') {
    return 'paste';
  }
  if (key === 'c') {
    return event.shiftKey || hasSelection ? 'copy' : 'pass';
  }
  return 'pass';
}

/** Palettes matching the app tokens, since xterm needs literal colours rather than CSS variables. */
export const TERMINAL_THEMES: Record<ResolvedTheme, Record<string, string>> = {
  light: {
    background: '#ffffff',
    foreground: '#1f1f1f',
    cursor: '#e61e3c',
    selectionBackground: '#fbdad5',
  },
  dark: {
    background: '#0e0e0e',
    foreground: '#ededed',
    cursor: '#ea515b',
    selectionBackground: '#3a1f26',
  },
};

/**
 * An xterm instance and the two things every owner of one needs.
 *
 * `webgl` is mutable state and belongs here rather than in the owner: whether the renderer has been
 * engaged, and whether it has permanently fallen back, is a property of this terminal and not of the
 * arrangement it happens to sit in. Anything about position, tab order or announced geometry is
 * deliberately absent, and an owner is free to carry its own fields alongside.
 */
export interface TerminalView {
  readonly term: Terminal;
  readonly fit: FitAddon;
  readonly element: HTMLElement;
  /** WebGL renderer state: not loaded yet, active, or permanently fallen back to the DOM renderer. */
  webgl: WebglAddon | 'failed' | null;
}

export interface TerminalViewOptions {
  /** Font size in pixels. Applied at construction; change it afterwards through `term.options`. */
  readonly fontSize?: number;
  readonly theme: ResolvedTheme;
  /**
   * ConPTY quirks of this Windows build, or null when there is no workaround to apply.
   *
   * Passed rather than detected here: it comes from the main process, which is the only side that can
   * read the OS version.
   */
  readonly compat: TerminalCompat | null;
  /** Keystrokes on their way to the pty. */
  readonly onInput: (data: string) => void;
  /** A selection to put on the system clipboard. */
  readonly onCopy: (text: string) => void;
  /** The system clipboard, for a paste. Resolved text is written into the terminal by this module. */
  readonly onPasteRequest: () => Promise<string>;
  /** A URL printed by a program, to open in the real browser. */
  readonly onOpenLink: (url: string) => void;
}

/**
 * Builds a terminal and its container, ready to be placed anywhere.
 *
 * The element is created here and returned **unattached**: `term.open()` is called on it once and never
 * again, so it has to be a container this module owns, but where that container goes is the caller's
 * business. It is born `hidden`, because a view is routinely created for a tab nobody is looking at yet
 * (output is collected for background sessions) and a terminal that flashed into view on creation would
 * be visible in whatever arrangement the caller had not built yet.
 *
 * The WebGL renderer is deliberately **not** engaged here: see `ensureTerminalRenderer`.
 */
export function createTerminalView(options: TerminalViewOptions): TerminalView {
  // A dedicated, permanent container: `open()` is called on it once and never again.
  const element = createElement('div', { className: 'terminal__view' });
  element.hidden = true;

  const term = new Terminal({
    fontFamily: "'Cascadia Code', Consolas, monospace",
    fontSize: options.fontSize ?? TERMINAL_FONT_SIZE.default,
    scrollback: 5000,
    cursorBlink: true,
    /*
     * Told what pty it is driving, xterm stops reflowing its own buffer on resize and grows into
     * the scrollback instead. ConPTY reflows and reprints on its side; two owners rewriting the
     * same rows from different origins is what leaves characters stranded on screen.
     *
     * Spread rather than set to `undefined` off Windows: under `exactOptionalPropertyTypes` an
     * explicit `undefined` is not the same thing as an absent key, and xterm's option is optional
     * without being nullable. Absent is what "no workaround" means here.
     */
    ...(options.compat === null ? {} : { windowsPty: options.compat }),
    /*
     * Shrinks glyphs that are one cell wide in the font's opinion but paint wider than one cell.
     * Ambiguous-width characters do exactly that, and a full-screen TUI is made of them: the box
     * drawing, `⎿`, `●` and the spinner of a Claude Code session all bleed into the neighbouring
     * cell. Under the WebGL renderer only the cells marked dirty are repainted, so the bled pixels
     * of a cell nobody touched this frame simply stay there. WebGL-only option, which is precisely
     * our case.
     */
    rescaleOverlappingGlyphs: true,
    /*
     * No `convertEol`. It makes a bare `\n` also return the carriage, which is a fix for programs
     * whose output is piped straight in, and this output comes from a pty, where the line endings
     * are already whatever the program meant them to be. Left on, a lone line feed emitted to move
     * down *while keeping the column* (what a TUI does when it redraws a frame in place) dropped
     * the cursor to column 0, so the redraw started at the wrong place and never covered the tail
     * of the previous frame.
     */
    theme: TERMINAL_THEMES[options.theme],
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  /*
   * URLs printed in a tab become clickable.
   *
   * Loaded here and not alongside the WebGL addon: this one registers a link provider and reads
   * nothing about the geometry, so a background tab is a perfectly good place to be born.
   *
   * The handler is the caller's rather than the addon's default, which calls `window.open`. That would
   * work by accident, `window.ts` turning every window-open request into a `shell.openExternal`, and it
   * would be the only place in the app where a URL reaches the browser without passing the main
   * process's `http(s)` check. A pty prints whatever a program sends it, `file://` and `vscode://`
   * included, so the check is the point.
   *
   * `preventDefault` is what stops the click from also landing on xterm's own mouse handling, which
   * would move the cursor or start a selection under the link that was just followed.
   */
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault();
      options.onOpenLink(uri);
    }),
  );
  term.onData((data) => options.onInput(data));

  /*
   * Copy and paste, which a terminal does not get for free.
   *
   * `attachCustomKeyEventHandler` is the only hook that runs *before* xterm turns a keystroke into bytes
   * for the pty. Returning false is what stops `Ctrl+V` from reaching the shell as a control character,
   * and `Ctrl+C` from becoming SIGINT when the user meant to copy a selection.
   *
   * `preventDefault` is not optional: returning false only skips xterm's handling, it does not consume
   * the keydown. Left alone, the browser then fires its native `paste` event on xterm's hidden textarea,
   * which xterm also listens to, so the text landed twice: once from us and once from that listener.
   */
  term.attachCustomKeyEventHandler((event) => {
    switch (decideTerminalKey(event, term.hasSelection())) {
      case 'copy':
        event.preventDefault();
        if (term.hasSelection()) {
          options.onCopy(term.getSelection());
        }
        return false;
      case 'paste':
        event.preventDefault();
        void options.onPasteRequest().then((text) => {
          if (text.length > 0) {
            term.paste(text);
          }
        });
        return false;
      case 'pass':
        return true;
    }
  });

  term.open(element);

  return { term, fit, element, webgl: null };
}

/**
 * Switches a terminal to the WebGL renderer on its first real display.
 *
 * xterm's default renderer draws the screen as DOM nodes, and under Chromium's GPU compositing that
 * leaves stale text layers on screen while scrolling: frozen glyphs outside the grid, seen in the
 * wild here. The WebGL renderer repaints its whole canvas, so nothing can be left behind.
 *
 * Never called from `createTerminalView`: a view can be created for a *background* tab (output is
 * collected for hidden sessions), and a WebGL canvas initialised on a `display: none` element is born
 * with a garbage geometry that later shows up as exactly those frozen glyphs. Calling this only once
 * the element is on screen and fitted means the canvas gets its real dimensions. Every owner of a view
 * has to respect that ordering, which is why it is a separate exported function and not a flag.
 *
 * On context loss (Chromium caps live WebGL contexts per page and evicts the oldest), the addon is
 * disposed and xterm falls back to the DOM renderer on its own; marked `failed` so it is not
 * reloaded just to be evicted again.
 */
export function ensureTerminalRenderer(view: TerminalView): void {
  if (view.webgl !== null) {
    return;
  }
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      console.warn('[terminal] WebGL context lost, falling back to the DOM renderer');
      webgl.dispose();
      view.webgl = 'failed';
    });
    view.term.loadAddon(webgl);
    view.webgl = webgl;
  } catch (error) {
    // Logged rather than swallowed: a silent fallback here already cost a diagnosis once.
    view.webgl = 'failed';
    console.warn(`[terminal] renderer: dom (WebGL failed: ${String(error)})`);
  }
}
