import type {
  ProjectRow,
  ResolvedTheme,
  TerminalCompat,
  TerminalId,
  TerminalSession,
  ThemeState,
} from '@shared/contracts.js';
import { clearChildren, createElement, requireElement } from './ui/dom.js';
import { presentServer } from './ui/presenters.js';
import { buildPill } from './ui/project-table.js';
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
  /**
   * The project rows, for the phase of each tile.
   *
   * This is the part that makes the window worth building rather than opening a second terminal beside
   * the app: `serving`, `lint failed`, `build failed` and `crashed` are read from the process output by
   * the main process, so a tile can say which one it is without anybody reading a log. A bare terminal
   * cannot do that at any price.
   */
  private rows: readonly ProjectRow[] = [];
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

    /*
     * One forced read at startup, rather than waiting for the poll.
     *
     * The phases arrive on the project monitor's own cadence, so a window opened between two pushes
     * would show its tiles with no phase for up to ten seconds. That is precisely the window in which
     * somebody is looking at it to find out whether anything needs them, so the answer cannot be blank.
     * The cost is one refresh, once, when the window opens.
     */
    this.rows = await window.api.refreshNow();
    this.paintPhases();

    window.api.onRowsChanged((rows) => {
      this.rows = rows;
      // Only the heads are repainted: rebuilding the grid on every poll would re-append live terminals
      // ten times a minute for a pill that changed colour.
      this.paintPhases();
    });
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
    // A tile created in this pass has an empty phase slot until something repaints it, and the next
    // poll can be ten seconds away.
    this.paintPhases();
  }

  private tile(terminalId: TerminalId): Tile | undefined {
    return this.views.get(terminalId);
  }

  /**
   * Repaints the phase of every tile, and nothing else.
   *
   * Its own pass rather than part of `render`, because the two have completely different cadences: the
   * grid changes when a server starts or stops, the phase changes on every poll. Rebuilding the grid
   * for a pill would re-append live terminals ten times a minute.
   *
   * `presentServer` is the projects table's own function, reused rather than reimplemented: what
   * `serving`, `lint failed` and `crashed` look like is decided once for the whole app, so a tile and a
   * row can never disagree about the same process.
   */
  private paintPhases(): void {
    const byProject = new Map(this.rows.map((row) => [row.project.id, row]));
    for (const session of this.sessions) {
      const tile = this.views.get(session.id);
      if (tile === undefined) {
        continue;
      }
      const row = session.projectId === null ? undefined : byProject.get(session.projectId);
      clearChildren(tile.phase);
      if (row === undefined) {
        // A tile with no row behind it: a shell moved here by hand, which has no project and therefore
        // no phase. Left blank rather than labelled "unknown", which would read as a fault.
        tile.element.dataset.tone = '';
        continue;
      }
      const pill = presentServer(row.server);
      tile.phase.append(buildPill(pill));
      // The tone on the tile itself, not just in the pill: the whole point is an answer read from
      // across a room, and a coloured edge is visible where four characters of text are not.
      tile.element.dataset.tone = pill.tone;
    }
  }

  /** The tile of a session, created on first sight. */
  private ensure(session: TerminalSession): Tile {
    const existing = this.views.get(session.id);
    if (existing !== undefined) {
      existing.title.textContent = session.title;
      // Repainted here rather than in `paintPhases`, because it changes on the cadence of the session
      // list and not of the project poll: a server's exit broadcasts sessions, which is what flips this
      // entry from `Stop` to a cross. Putting it in the phase pass would have it follow the wrong clock.
      paintLifecycle(existing, session);
      return existing;
    }

    const element = createElement('section', { className: 'servers__tile' });
    const title = createElement('span', { className: 'servers__tile-title', text: session.title });
    const phase = createElement('span', { className: 'servers__tile-phase' });
    const head = createElement('header', { className: 'servers__tile-head' });
    head.append(title, phase);

    /*
     * Sending one tile back on its own, without closing the window.
     *
     * The counterpart of the dashboard's "Move to the servers window", and the reason both exist: the
     * role knows what a `Run` action is and cannot know what somebody typed into a shell. Either
     * direction has to be sayable, or the automatic rule becomes a cage.
     */
    const back = createElement('button', {
      className: 'servers__tile-back',
      text: '→',
      title: 'Send this terminal back to the dashboard',
    });
    back.type = 'button';
    back.setAttribute('aria-label', `Send ${session.title} back to the dashboard`);
    back.addEventListener('click', () => void window.api.moveTerminalToServers(session.id, false));
    head.append(back);

    /*
     * Ending a terminal from here, which this window could not do at all until now.
     *
     * ONE slot with two states, driven by `session.closable`, which is the field that already answers
     * "may this be ended now" for the whole app: a shell and a one-shot task always may, a `server`
     * only once its process has stopped, so `Stop` stays the deliberate way to end a build. The
     * dashboard reads the same field to decide whether a tab gets a cross at all.
     *
     * A bare cross was the obvious version and is the wrong one here. `TerminalManager.close` does
     * stop a running process on its way out, so it would have worked mechanically, and that is exactly
     * the trap: this window is several running builds side by side, and one misclick would take one
     * down with no step in between. Two states cost a click and turn a slip into a stop.
     *
     * Not two buttons either, one of them permanently disabled on a window whose tiles are servers by
     * construction: that is the dead control the projects table refuses on its `Add a tag` entry.
     */
    const lifecycle = createElement('button', { className: 'servers__tile-life' });
    lifecycle.type = 'button';
    lifecycle.addEventListener('click', () => {
      /*
       * The session is looked up at CLICK time and not captured here.
       *
       * The head is built once per tile and survives every render, so a handler closed over the
       * session this tile was born with would still be stopping a process that exited ten minutes
       * ago. `this.sessions` is replaced whole on every broadcast, so reading it now is reading the
       * state the button is currently painted for.
       */
      const current = this.sessions.find((entry) => entry.id === session.id);
      if (current === undefined) {
        return;
      }
      if (current.closable) {
        void window.api.closeTerminal(session.id);
      } else {
        // `stopPty` and not `stopProjectServer`: a tile IS a session, and it knows which one. Going
        // through the project would ask the manager to find "a" running server action for it, which is
        // the same pty here and an indirection that can only ever aim at the wrong one.
        void window.api.stopPty(session.id);
      }
    });
    head.append(lifecycle);
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

    const tile: Tile = { element, title, phase, lifecycle, view, sent: null };
    this.views.set(session.id, tile);
    paintLifecycle(tile, session);
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

/**
 * Paints the tile's one life-cycle control for the state the session is in.
 *
 * Free function rather than a method, because it touches nothing but the two arguments it is given,
 * and because both callers of `ensure` need it: a tile is painted when it is created and repainted
 * every time the session list is broadcast.
 *
 * The two states are `closable`, and they are not a matter of taste. It is the field the main process
 * already derives for exactly this question, so a tile and a dashboard tab can never disagree about
 * whether a process may be ended: a shell and a one-shot task always may, a `server` only once it has
 * stopped. The label follows the field rather than the role, which is what makes a shell dragged into
 * this window behave here the way it does over there.
 */
function paintLifecycle(tile: Tile, session: TerminalSession): void {
  const stop = !session.closable;
  // The stop square and the cross of `.terminal__tab-close`, in text like the `→` beside them: this
  // head has never held an SVG, and a glyph nobody else draws does not belong in `icons.ts`.
  tile.lifecycle.textContent = stop ? '■' : '×';
  tile.lifecycle.title = stop
    ? 'Stop this server (its output stays, and a cross then closes the tile)'
    : 'Close this terminal, here and in the dashboard';
  tile.lifecycle.setAttribute(
    'aria-label',
    stop ? `Stop ${session.title}` : `Close ${session.title}`,
  );
  // The tone follows the state, so the destructive half is the only one painted as such. Mirrors
  // `.terminal__tab-close`, which is the app's other cross on a terminal.
  tile.lifecycle.classList.toggle('servers__tile-life--close', !stop);
}

/** One server on screen: its terminal, its heading, and the geometry its pty was last told. */
interface Tile {
  readonly element: HTMLElement;
  readonly title: HTMLElement;
  /** Where the phase pill goes, repainted on its own cadence. See `paintPhases`. */
  readonly phase: HTMLElement;
  /** The stop-then-close control, whose two states follow `session.closable`. See `paintLifecycle`. */
  readonly lifecycle: HTMLButtonElement;
  readonly view: TerminalView;
  /** Last geometry announced to the pty. See `fitAll` for why a redundant resize is not free. */
  sent: { cols: number; rows: number } | null;
}

void new ServersView().start().catch((error: unknown) => {
  console.error('[servers] servers window failed to start:', error);
});
