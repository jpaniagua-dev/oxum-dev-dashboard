import type { ResolvedTheme, TerminalCompat, TerminalId, TerminalSession, ThemeState } from '@shared/contracts.js';
import { clearChildren, createElement, requireElement } from './ui/dom.js';
import {
  createTerminalView,
  ensureTerminalRenderer,
  TERMINAL_THEMES,
  type TerminalView,
} from './ui/terminal-view.js';
import { applyUiFontSize } from './ui/ui-font.js';

/**
 * The servers window.
 *
 * A third renderer over the same preload bridge, like the settings window, so it reads and writes
 * through exactly the capabilities the dashboard has and nothing more.
 *
 * Its whole job is a glance: every dev server visible at once, so "does one of them need me" is answered
 * without reading a line and without cycling through tabs. Everything follows from that:
 *
 * - **A grid derived from the session list**, not a layout. There is no tab order, no split, no active
 *   pane and nothing to persist, which is what makes this file a fraction of `TerminalPane`. The
 *   arrangement is a function of what the main process says this window owns.
 * - **The terminals are the real thing**, built by `createTerminalView`, the same function the dashboard
 *   uses. Not a log view, not a copy: the same hard-won xterm configuration, so a server looks and
 *   behaves identically in either window. Rewriting it here is the one mistake that would matter.
 * - **This window is the sole owner of the ptys it shows.** The main process sends it only its own
 *   sessions and routes only their output here, so no pty is ever told two different geometries by two
 *   windows. That invariant is why detaching is a main-process decision and not a rendering trick.
 * - **Closing hands the sessions back.** Enforced in the main process, not here: a window can be closed
 *   in ways a renderer never hears about, and a running server owned by a window that no longer exists
 *   would be work with nothing able to show or stop it.
 */
class ServersView {
  private readonly views = new Map<TerminalId, Tile>();
  private sessions: readonly TerminalSession[] = [];
  private theme: ResolvedTheme = 'light';
  private fontSize = 14;
  private compat: TerminalCompat | null = null;
  /** Sessions whose buffered scrollback has been replayed, so it is not written twice. */
  private readonly replayed = new Set<TerminalId>();

  async start(): Promise<void> {
    const bootstrap = await window.api.bootstrap();
    this.theme = bootstrap.theme.resolved;
    this.applyTheme(bootstrap.theme);
    applyUiFontSize(bootstrap.settings.uiFontSize);
    this.fontSize = bootstrap.settings.terminalFontSize;
    this.compat = bootstrap.terminalCompat;

    // Filtered here, unlike `onTerminalsChanged` below: `bootstrap` is the one payload the main process
    // does not tailor per window, so this is where `role` earns its place in the contract.
    this.setSessions(bootstrap.terminals.filter((session) => session.role === 'server'));

    window.api.onTerminalsChanged((sessions) => this.setSessions(sessions));
    window.api.onPtyOutput(({ terminalId, data }) => {
      this.tile(terminalId)?.view.term.write(data);
    });
    window.api.onThemeChanged((state) => this.applyTheme(state));
    window.api.onSettingsChanged((settings) => {
      applyUiFontSize(settings.uiFontSize);
      this.setFontSize(settings.terminalFontSize);
    });

    // One refit for the whole grid: every tile's geometry changes together when the window does.
    window.addEventListener('resize', () => this.fitAll());
  }

  /**
   * Replaces the grid with the sessions this window owns.
   *
   * Rebuilt rather than diffed, with one exception that matters: the tiles themselves are **kept** in
   * `this.views` across renders. A terminal is an xterm instance with a scrollback; recreating it because
   * a sibling appeared would clear the very history this window exists to show. So the DOM order is
   * rebuilt, the terminals are not.
   */
  private setSessions(sessions: readonly TerminalSession[]): void {
    this.sessions = sessions;
    const live = new Set(sessions.map((session) => session.id));

    for (const [id, tile] of this.views) {
      if (!live.has(id)) {
        // Gone, or handed back to the dashboard. Disposed rather than hidden: the dashboard is about to
        // build its own view of the same pty, and two live xterms on one pty is the state that gets a
        // resize wrong. `replayed` is cleared with it, so a session that comes back replays again.
        tile.view.term.dispose();
        tile.element.remove();
        this.views.delete(id);
        this.replayed.delete(id);
      }
    }

    this.render();
  }

  private render(): void {
    const bar = requireElement('servers-bar');
    const grid = requireElement('servers-grid');
    clearChildren(bar);

    bar.append(
      createElement('span', {
        className: 'strip__meta',
        text:
          this.sessions.length === 0
            ? 'No server running'
            : `${this.sessions.length} server${this.sessions.length === 1 ? '' : 's'}`,
      }),
    );

    const back = createElement('button', {
      className: 'servers__back',
      text: 'Back to the dashboard',
      title: 'Hand these terminals back to the dashboard and close this window',
    });
    back.type = 'button';
    // The window is closed by the main process on the way out of `detachServers`, so this button and
    // the title bar's cross end in the same place: one hand-back, one close, in one order.
    back.addEventListener('click', () => void window.api.detachServers(false));
    bar.append(back);

    if (this.sessions.length === 0) {
      clearChildren(grid);
      grid.append(
        createElement('p', {
          className: 'pulls__empty',
          text: 'Nothing here yet. Start a server from the dashboard and it will appear.',
        }),
      );
      return;
    }

    /*
     * The grid, sized to be square-ish.
     *
     * `ceil(sqrt(n))` columns is what keeps four servers at two by two rather than one by four: on a
     * wide screen a single row of four is four tall thin strips, and a build log in a thin strip wraps
     * every line. Set as a custom property rather than a class per count, so any number works.
     */
    grid.style.setProperty('--servers-columns', String(Math.ceil(Math.sqrt(this.sessions.length))));

    // Detached and re-appended in order rather than cleared: `clearChildren` would remove the tiles, and
    // re-appending a live xterm element is fine while recreating it is not.
    for (const session of this.sessions) {
      grid.append(this.ensure(session).element);
    }

    // After the DOM, never before: a fit measures the element, and an element not yet in the grid has no
    // size to measure. The renderer is engaged from here too, for the same reason.
    this.fitAll();
    this.replayMissing();
  }

  private tile(terminalId: TerminalId): Tile | undefined {
    return this.views.get(terminalId);
  }

  /** The tile of a session, created on first sight. */
  private ensure(session: TerminalSession): Tile {
    const existing = this.views.get(session.id);
    if (existing !== undefined) {
      existing.title.textContent = session.title;
      return existing;
    }

    const element = createElement('section', { className: 'servers__tile' });
    const title = createElement('span', { className: 'servers__tile-title', text: session.title });
    const head = createElement('header', { className: 'servers__tile-head' });
    head.append(title);
    element.append(head);

    const view = createTerminalView({
      fontSize: this.fontSize,
      theme: this.theme,
      compat: this.compat,
      onInput: (data) => window.api.sendPtyInput(session.id, data),
      onCopy: (text) => void window.api.writeClipboard(text),
      onPasteRequest: () => window.api.readClipboard(),
      onOpenLink: (url) => void window.api.openExternal(url),
    });
    // `createTerminalView` returns its container hidden, a dashboard tab being routinely created for a
    // session nobody is looking at. Here every tile is on screen by construction.
    view.element.hidden = false;
    element.append(view.element);

    const tile: Tile = { element, title, view, sent: null };
    this.views.set(session.id, tile);
    return tile;
  }

  /**
   * Replays the scrollback of any tile that has not had it yet.
   *
   * A server has usually been running for a while before this window opens, and its output so far lives
   * in the main process's buffer. Without this, a freshly detached server shows an empty tile until it
   * next prints something, which for a settled `serving` process can be a long time, and reads as a
   * server that died.
   */
  private replayMissing(): void {
    for (const session of this.sessions) {
      if (this.replayed.has(session.id)) {
        continue;
      }
      this.replayed.add(session.id);
      void window.api.readPtyBuffer(session.id).then((buffer) => {
        const tile = this.tile(session.id);
        if (tile === undefined) {
          return;
        }
        tile.view.term.reset();
        if (buffer.length > 0) {
          tile.view.term.write(buffer);
        }
      });
    }
  }

  /**
   * Refits every tile and tells each pty its new geometry.
   *
   * **Only when it actually changed**, which is the same rule the dashboard's `fitVisible` follows and
   * for the same measured reason: a resize of the same size is not free on Windows, ConPTY reprints the
   * screen it holds, and a full-screen TUI answers by redrawing its whole frame. This runs on every
   * render and on every window resize event, so redundant calls would arrive in bursts.
   */
  private fitAll(): void {
    for (const [id, tile] of this.views) {
      // Engaged here rather than at creation: a WebGL canvas initialised before its element has a real
      // size is born with a garbage geometry that shows up later as frozen glyphs.
      ensureTerminalRenderer(tile.view);
      try {
        tile.view.fit.fit();
      } catch {
        // A tile of zero size, mid-layout. The next fit has real dimensions to work with.
        continue;
      }
      const { cols, rows } = tile.view.term;
      if (tile.sent?.cols === cols && tile.sent.rows === rows) {
        continue;
      }
      tile.sent = { cols, rows };
      window.api.resizePty(id, { cols, rows });
    }
  }

  private setFontSize(size: number): void {
    if (size === this.fontSize) {
      return;
    }
    this.fontSize = size;
    for (const tile of this.views.values()) {
      tile.view.term.options.fontSize = size;
    }
    this.fitAll();
  }

  private applyTheme(state: ThemeState): void {
    document.documentElement.dataset.theme = state.resolved;
    this.theme = state.resolved;
    for (const tile of this.views.values()) {
      tile.view.term.options.theme = TERMINAL_THEMES[state.resolved];
    }
  }
}

/** One server on screen: its terminal, its heading, and the geometry its pty was last told. */
interface Tile {
  readonly element: HTMLElement;
  readonly title: HTMLElement;
  readonly view: TerminalView;
  /** Last geometry announced to the pty. See `fitAll` for why a redundant resize is not free. */
  sent: { cols: number; rows: number } | null;
}

void new ServersView().start().catch((error: unknown) => {
  console.error('[servers] servers window failed to start:', error);
});
