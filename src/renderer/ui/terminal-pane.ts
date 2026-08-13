import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import {
  TERMINAL_FONT_SIZE,
  type PaneDirection,
  type ResolvedTheme,
  type ShellProfile,
  type TerminalCompat,
  type TerminalGroup,
  type TerminalId,
  type TerminalLayout,
  type TerminalSession,
} from '@shared/contracts.js';
import {
  activateTab,
  addTab,
  closeGroup,
  groupIndexOf,
  moveTab,
  normalizeGroups,
  splitGroup,
  tabsAfter,
} from '@shared/terminal-groups.js';
import { showContextMenu, type MenuItem } from './context-menu.js';
import { clearChildren, createElement, createIcon } from './dom.js';

/**
 * The chevron of the shell picker.
 *
 * Drawn as a stroke so it keeps the same weight as the `+` next to it at any zoom, which the `⌄`
 * character did not: as text its size and baseline were the font's decision.
 */
function chevronDown(): SVGSVGElement {
  return createIcon('M3.5 6l4.5 4.5L12.5 6', { paint: 'stroke' });
}

/* ------------------------------------------------------------------ *
 * Clipboard keys
 * ------------------------------------------------------------------ */

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
const THEMES: Record<ResolvedTheme, Record<string, string>> = {
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

export interface TerminalPaneActions {
  onInput: (terminalId: TerminalId, data: string) => void;
  onResize: (terminalId: TerminalId, cols: number, rows: number) => void;
  onClose: (terminalId: TerminalId) => void;
  onRename: (terminalId: TerminalId, title: string) => void;
  /** Open a new shell tab from a profile, in the focused pane. */
  onNewShell: (profileId: string) => void;
  /** The panes and their tabs after a gesture. One call for every shape the surface can take. */
  onLayout: (groups: readonly TerminalGroup[], direction: PaneDirection) => void;
  /**
   * Open a new shell in a directory, for a split.
   *
   * The pane resolves nothing itself: it hands over the working directory of the pane being split and
   * the caller decides which profile that means.
   */
  onSplitShell: (cwd: string, direction: PaneDirection) => void;
  /** Puts a selection on the system clipboard. */
  onCopy: (text: string) => void;
  /**
   * Reads the system clipboard for a paste.
   *
   * Goes through the main process rather than `navigator.clipboard`: reading the clipboard from a renderer
   * needs a permission and a secure context, neither of which a `file://` page under a locked-down CSP
   * has, while Electron's own clipboard has no such condition.
   */
  onPasteRequest: () => Promise<string>;
  /**
   * Tells the pty its screen was cleared.
   *
   * Clearing xterm alone is not enough on ConPTY, which keeps its own copy of the screen and reprints
   * it at the next repaint it decides to make.
   */
  onClear: (terminalId: TerminalId) => void;
}

/** Which side of a tab a drop lands on. */
type DropSide = 'before' | 'after';

interface View {
  readonly term: Terminal;
  readonly fit: FitAddon;
  readonly element: HTMLElement;
  /** WebGL renderer state: not loaded yet, active, or permanently fallen back to the DOM renderer. */
  webgl: WebglAddon | 'failed' | null;
  /**
   * Geometry last announced to the pty, so an unchanged one is never announced again.
   *
   * `null` until the first fit. See `fitVisible` for why a redundant resize is not free.
   */
  sent: { cols: number; rows: number } | null;
}

/**
 * The terminal surface: one or more panes, each a complete terminal with its own tab strip.
 *
 * **A pane is a group of tabs, not a session.** Splitting used to divide the *view* while a single
 * strip above the surface went on listing every session in the app, so a split gave you two windows
 * onto one tab bar. A group owns its tabs and its active one, so splitting gives you a terminal,
 * tabs included, and dragging a tab from one pane to another is just moving it between groups.
 *
 * **Each terminal gets its own permanent container and is opened exactly once.** xterm's `open()`
 * early-returns when the terminal already has an element, so detaching that element and re-opening
 * leaves the terminal alive in memory but invisible forever: it believes it is attached while the
 * pane stays blank. Nothing here ever moves a view in the DOM. Every view and every strip is a direct
 * child of the surface, and placement is done by assigning explicit grid lines — which is also why
 * the surface is a grid rather than a flex row.
 */
export class TerminalPane {
  private readonly views = new Map<TerminalId, View>();
  private sessions: readonly TerminalSession[] = [];
  private profiles: readonly ShellProfile[] = [];
  private theme: ResolvedTheme = 'light';
  /** Overwritten from the settings as soon as the bootstrap lands; this is only the pre-bootstrap value. */
  private fontSize: number = TERMINAL_FONT_SIZE.default;
  /** Index of the group whose profile menu is open, if any. */
  private menuOpen: number | null = null;
  /** Id of the tab currently being renamed in place, if any. */
  private renaming: TerminalId | null = null;
  /** Tab being dragged, if any. Held so a drop knows what to move. */
  private dragging: TerminalId | null = null;
  /** The panes, mirroring what the main process holds. */
  private layout: TerminalLayout = { direction: 'columns', groups: [] };
  /**
   * Index of the pane the keyboard and every "here" gesture belong to.
   *
   * A new tab, a split and the shortcuts all need a pane to act on, and with several complete
   * terminals on screen "the current one" is no longer implied by there being a single strip.
   */
  private focused = 0;
  /**
   * Relative size of each pane, one entry per group.
   *
   * Renderer-only, unlike the layout itself: it is a pixel preference rather than user intent, and
   * resetting it when the number of panes changes is what keeps the arithmetic simple.
   */
  private sizes: number[] = [];
  /** Tab strips, one per pane, reused across renders rather than rebuilt. */
  private readonly strips: HTMLElement[] = [];
  /** Splitters between panes, reused across renders rather than rebuilt. */
  private readonly splitters: HTMLElement[] = [];

  constructor(
    private readonly surface: HTMLElement,
    private readonly actions: TerminalPaneActions,
    /**
     * The pty backend behind every session, or `null` off Windows.
     *
     * A constructor argument rather than a setter: it decides an option xterm reads when a terminal is
     * built, so a terminal created before it landed would keep the wrong behaviour for its whole life.
     */
    private readonly compat: TerminalCompat | null = null,
  ) {
    window.addEventListener('resize', () => this.fitVisible());
    // Any click outside closes the profile menu, which is what every menu in every app does. The context
    // menu dismisses itself, in the shared module.
    document.addEventListener('click', () => {
      if (this.menuOpen !== null) {
        this.menuOpen = null;
        this.renderStrips();
      }
    });
    this.bindShortcuts();
  }

  /**
   * Keyboard equivalents of the pane and tab menus.
   *
   * On `document` and in the **capture** phase: the focused terminal is an xterm, which claims every
   * keystroke it can reach, so a listener on the bubble phase would never see these.
   *
   * `Alt+Shift` plus a letter, which is Windows Terminal's own chord, and deliberately **not**
   * `Ctrl+Alt`: on a Swiss French keyboard `Ctrl+Alt` is what AltGr sends, so every AltGr character
   * would walk through this handler. Letters rather than digits for the same family of reason, the digit
   * row needing Shift on that layout.
   *
   * `Alt+Shift+W` closes the active tab, the everyday gesture, so it sits on the everyday chord.
   * Closing the focused pane, the rarer gesture, lives on `Ctrl+Alt+W`: the one accepted exception
   * to the no-`Ctrl+Alt` rule, survivable for this key and only this key because `W` carries no
   * AltGr character on the Swiss French layout, so the combination types nothing and there is
   * nothing to shadow. It is matched on `event.code` rather than `event.key` precisely because that
   * assumption is about the *physical* key: under a chord that some layouts do map, `key` becomes
   * the composed character and the comparison would quietly stop matching. Any future `Ctrl+Alt`
   * chord has to be checked against the layout the same way, or it will eat a character someone
   * types for real.
   */
  private bindShortcuts(): void {
    document.addEventListener(
      'keydown',
      (event) => {
        // Holding a chord must not fire once per repeat: the keys stay down for as long as a finger
        // rests on them, and each repeat is a fresh `keydown`.
        if (event.repeat || !event.altKey || event.metaKey) {
          return;
        }

        if (event.ctrlKey) {
          if (!event.shiftKey && event.code === 'KeyW' && this.layout.groups.length > 1) {
            event.preventDefault();
            this.closeFocusedGroup();
          }
          return;
        }
        if (!event.shiftKey) {
          return;
        }

        const focused = this.activeId;
        const session = this.sessions.find((entry) => entry.id === focused);
        const key = event.key.toLowerCase();

        if (key === 'd' && session !== undefined) {
          event.preventDefault();
          this.actions.onSplitShell(session.cwd, 'columns');
        } else if (key === 'b' && session !== undefined) {
          event.preventDefault();
          this.actions.onSplitShell(session.cwd, 'rows');
        } else if (key === 'w') {
          event.preventDefault();
          this.closeActiveTab();
        }
      },
      true,
    );
  }

  /**
   * Closes the tab the keyboard is on.
   *
   * Silent when that tab cannot be closed, which is the whole point of `closable` being derived: a dev
   * server that is still running keeps its tab, and `Stop` stays the deliberate gesture for it. A
   * shortcut able to take down a build by muscle memory is exactly what that rule exists to prevent,
   * and refusing quietly is the same answer the tab's own cross gives — it simply is not there.
   */
  private closeActiveTab(): void {
    const active = this.activeId;
    const session = this.sessions.find((entry) => entry.id === active);
    if (session !== undefined && session.closable) {
      this.actions.onClose(session.id);
    }
  }

  /** Adopts the layout the main process reports. */
  setLayout(layout: TerminalLayout): void {
    this.adopt(layout.groups, layout.direction);
    this.render();
  }

  setTheme(theme: ResolvedTheme): void {
    this.theme = theme;
    for (const view of this.views.values()) {
      view.term.options.theme = THEMES[theme];
    }
  }

  setProfiles(profiles: readonly ShellProfile[]): void {
    this.profiles = profiles;
    this.renderStrips();
  }

  /**
   * Applies a font size to every terminal, live.
   *
   * Refitting afterwards is not cosmetic: the cell size changed, so the number of columns and rows did
   * too, and a pty still told the old geometry wraps its output at the wrong width.
   */
  setFontSize(size: number): void {
    if (!Number.isFinite(size)) {
      // A renderer hot-reloaded ahead of its main process reads this key as `undefined` from an older
      // bootstrap. Clamping would turn that into `NaN` and hand it to xterm, which then measures a cell
      // of no size and stops painting entirely. Keeping the current size is the harmless answer.
      return;
    }
    const clamped = Math.min(
      Math.max(Math.round(size), TERMINAL_FONT_SIZE.min),
      TERMINAL_FONT_SIZE.max,
    );
    if (clamped === this.fontSize) {
      return;
    }
    this.fontSize = clamped;
    for (const view of this.views.values()) {
      view.term.options.fontSize = clamped;
    }
    this.fitVisible();
  }

  /** The tab the keyboard goes to: the active one of the focused pane. */
  get activeId(): TerminalId | null {
    return this.layout.groups[this.focused]?.active ?? null;
  }

  /**
   * Reconciles the strips with the sessions the main process reports.
   *
   * Views for sessions that disappeared are disposed here: a closed tab must free its xterm, or the
   * surface leaks a renderer per closed terminal.
   */
  setSessions(sessions: readonly TerminalSession[]): void {
    this.sessions = sessions;
    const live = new Set(sessions.map((session) => session.id));

    for (const [id, view] of this.views) {
      if (!live.has(id)) {
        view.term.dispose();
        view.element.remove();
        this.views.delete(id);
      }
    }

    // A dead session cannot hold a tab, and a pane left with none must go. The main process says the
    // same thing a moment later, but waiting for it would leave a hole on the surface meanwhile.
    this.adopt(this.layout.groups, this.layout.direction);
    this.render();
  }

  /** Appends output, creating the view on demand so a background tab still collects its history. */
  write(terminalId: TerminalId, data: string): void {
    this.ensure(terminalId).term.write(data);
  }

  /** Replaces a view's content, used when replaying a buffer on first display. */
  reset(terminalId: TerminalId, content: string): void {
    const view = this.ensure(terminalId);
    view.term.reset();
    if (content.length > 0) {
      view.term.write(content);
    }
  }

  /**
   * Brings a session to the foreground.
   *
   * It is shown in **its own pane**, and the pane it lives in becomes the focused one. Nothing is
   * replaced and no pane is collapsed: with each pane carrying its own strip, clicking a tab can only
   * ever mean "show this one, here". A session that belongs to no pane yet — one just spawned — is
   * adopted by the focused pane.
   */
  select(terminalId: TerminalId): void {
    this.ensure(terminalId);
    const at = groupIndexOf(this.layout.groups, terminalId);
    if (at === -1) {
      this.applyLayout(addTab(this.layout.groups, this.focused, terminalId), this.layout.direction);
    } else {
      this.focused = at;
      this.applyLayout(activateTab(this.layout.groups, terminalId), this.layout.direction);
    }
    this.render();
    this.views.get(terminalId)?.term.focus();
  }

  /** Puts a session in a brand new pane beside the focused one, which is what a split does. */
  addPane(terminalId: TerminalId, direction: PaneDirection): void {
    this.ensure(terminalId);
    const at = this.focused;
    this.applyLayout(splitGroup(this.layout.groups, at, terminalId), direction);
    this.focused = groupIndexOf(this.layout.groups, terminalId);
    this.render();
    this.views.get(terminalId)?.term.focus();
  }

  /** Re-fits every visible terminal, needed after the surface is shown or resized. */
  refit(): void {
    this.fitVisible();
  }

  /* --------------------------------------------------------------- layout */

  /**
   * Takes in a set of groups, whoever computed them, and makes the local state match.
   *
   * Everything a gesture or the main process can produce goes through `normalizeGroups` here, so the
   * renderer holds exactly the layout the main process will hold once the round trip completes. The
   * views are created for every tab, including the ones in the background, because output is written
   * to a session's view whether or not it is on screen.
   */
  private adopt(groups: readonly TerminalGroup[], direction: PaneDirection): void {
    const live = this.sessions.map((session) => session.id);
    const next = normalizeGroups(groups, live);
    this.layout = { direction, groups: next };
    if (this.sizes.length !== next.length) {
      // Equal shares on every change of count: keeping old fractions would make a new pane inherit a
      // width that meant something for a different number of panes.
      this.sizes = next.map(() => 1);
    }
    for (const group of next) {
      for (const id of group.tabs) {
        this.ensure(id);
      }
    }
    this.focused = Math.min(Math.max(this.focused, 0), Math.max(next.length - 1, 0));
  }

  /**
   * Applies a layout locally and reports it.
   *
   * Applied at once rather than waiting for the round trip, because these all follow a click and a
   * click has to feel immediate. The main process is still the authority: its push arrives moments
   * later with the same value, or with a corrected one if a session died in between.
   */
  private applyLayout(groups: readonly TerminalGroup[], direction: PaneDirection): void {
    this.adopt(groups, direction);
    this.actions.onLayout(this.layout.groups, direction);
  }

  /** Closes the focused pane, its tabs moving to a neighbour rather than dying with it. */
  private closeFocusedGroup(): void {
    const at = this.focused;
    this.applyLayout(closeGroup(this.layout.groups, at), this.layout.direction);
    this.focused = Math.min(at, this.layout.groups.length - 1);
    this.render();
  }

  private render(): void {
    this.renderSurface();
    this.renderStrips();
  }

  /**
   * Places every pane on the surface.
   *
   * **No terminal is ever moved in the DOM.** Each keeps the permanent container it was opened on, and
   * placement is done by assigning explicit grid lines: detaching an xterm element to reorder it would
   * leave the terminal alive but blank forever. A pane is two cells of that grid, the strip above its
   * view, so both are direct children of the surface and neither wraps the other.
   */
  private renderSurface(): void {
    const { groups, direction } = this.layout;
    const columns = direction === 'columns';

    const tracks: string[] = [];
    groups.forEach((_group, index) => {
      if (index > 0) {
        tracks.push('var(--pane-splitter)');
      }
      // In a column layout a pane is one track wide and the strip/view split is the two fixed rows.
      // Stacked, a pane is two tracks tall, so its own strip and view each need one.
      tracks.push(columns ? `${this.sizes[index] ?? 1}fr` : `auto ${this.sizes[index] ?? 1}fr`);
    });
    const template = tracks.join(' ');

    this.surface.classList.toggle('terminal__surface--split', groups.length > 1);
    this.surface.style.gridTemplateColumns = columns ? template : '1fr';
    this.surface.style.gridTemplateRows = columns ? 'auto 1fr' : template;

    this.syncStrips(groups.length);
    this.syncSplitters(groups.length, direction);

    this.strips.forEach((strip, index) => {
      strip.hidden = index >= groups.length;
      place(strip, columns, stripLine(index, columns), columns ? '1' : undefined);
    });

    const focusedActive = groups[this.focused]?.active ?? null;
    for (const [id, view] of this.views) {
      const at = groupIndexOf(groups, id);
      const group = at === -1 ? undefined : groups[at];
      view.element.hidden = group === undefined || group.active !== id;
      if (group !== undefined) {
        place(view.element, columns, viewLine(at, columns), columns ? '2' : undefined);
      }
      view.element.classList.toggle(
        'terminal__view--focused',
        groups.length > 1 && id === focusedActive,
      );
    }

    this.splitters.forEach((splitter, index) => {
      if (splitter.hidden) {
        return;
      }
      const line = String(splitterLine(index, columns));
      if (columns) {
        splitter.style.gridColumn = line;
        splitter.style.gridRow = '1 / 3';
      } else {
        splitter.style.gridColumn = '1';
        splitter.style.gridRow = line;
      }
    });

    this.fitVisible();
  }

  /** Keeps one strip per pane, reusing the elements across renders. */
  private syncStrips(paneCount: number): void {
    while (this.strips.length < paneCount) {
      const index = this.strips.length;
      const strip = createElement('div', { className: 'terminal__strip' });
      this.attachStripDrop(strip, index);
      this.surface.append(strip);
      this.strips.push(strip);
    }
  }

  /** Keeps one splitter per gap between panes, reusing the elements across renders. */
  private syncSplitters(paneCount: number, direction: PaneDirection): void {
    const needed = Math.max(0, paneCount - 1);
    while (this.splitters.length < needed) {
      const index = this.splitters.length;
      const splitter = createElement('div', { className: 'terminal__splitter' });
      splitter.setAttribute('role', 'separator');
      this.attachSplitterDrag(splitter, index);
      this.surface.append(splitter);
      this.splitters.push(splitter);
    }
    this.splitters.forEach((splitter, index) => {
      splitter.hidden = index >= needed;
      splitter.classList.toggle('terminal__splitter--rows', direction === 'rows');
    });
  }

  /**
   * Dragging a splitter moves size from one neighbour to the other.
   *
   * Only the two panes it sits between are touched, so the others keep exactly the space they had.
   * Pointer capture on the splitter is what makes a fast drag survive leaving the element.
   */
  private attachSplitterDrag(splitter: HTMLElement, index: number): void {
    let dragging = false;
    let startPos = 0;
    let before = 1;
    let after = 1;
    let extent = 1;

    splitter.addEventListener('pointerdown', (event) => {
      const rows = this.layout.direction === 'rows';
      dragging = true;
      splitter.setPointerCapture(event.pointerId);
      startPos = rows ? event.clientY : event.clientX;
      before = this.sizes[index] ?? 1;
      after = this.sizes[index + 1] ?? 1;
      const box = this.surface.getBoundingClientRect();
      extent = rows ? box.height : box.width;
      event.preventDefault();
    });

    splitter.addEventListener('pointermove', (event) => {
      if (!dragging || extent <= 0) {
        return;
      }
      const rows = this.layout.direction === 'rows';
      const moved = (rows ? event.clientY : event.clientX) - startPos;
      // Pixels to fractions: the pair shares `before + after` of the total, so the same ratio applies.
      const total = before + after;
      const perPixel = total / extent;
      const delta = moved * perPixel;
      // A pane narrower than this is unusable, and a zero-width xterm throws on fit.
      const min = total * 0.12;
      const nextBefore = Math.min(Math.max(before + delta, min), total - min);
      this.sizes[index] = nextBefore;
      this.sizes[index + 1] = total - nextBefore;
      this.renderSurface();
    });

    const end = (event: PointerEvent): void => {
      if (!dragging) {
        return;
      }
      dragging = false;
      if (splitter.hasPointerCapture(event.pointerId)) {
        splitter.releasePointerCapture(event.pointerId);
      }
    };
    splitter.addEventListener('pointerup', end);
    splitter.addEventListener('pointercancel', end);
  }

  private ensure(terminalId: TerminalId): View {
    const existing = this.views.get(terminalId);
    if (existing !== undefined) {
      return existing;
    }

    // A dedicated, permanent container: `open()` is called on it once and never again.
    const element = createElement('div', { className: 'terminal__view' });
    element.hidden = true;
    this.surface.append(element);

    const term = new Terminal({
      fontFamily: "'Cascadia Code', Consolas, monospace",
      fontSize: this.fontSize,
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
      ...(this.compat === null ? {} : { windowsPty: this.compat }),
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
       * whose output is piped straight in — and this output comes from a pty, where the line endings
       * are already whatever the program meant them to be. Left on, a lone line feed emitted to move
       * down *while keeping the column* (what a TUI does when it redraws a frame in place) dropped
       * the cursor to column 0, so the redraw started at the wrong place and never covered the tail
       * of the previous frame.
       */
      theme: THEMES[this.theme],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.onData((data) => this.actions.onInput(terminalId, data));

    /*
     * Copy and paste, which a terminal does not get for free.
     *
     * `attachCustomKeyEventHandler` is the only hook that runs *before* xterm turns a keystroke into bytes
     * for the pty. Returning false is what stops `Ctrl+V` from reaching the shell as a control character,
     * and `Ctrl+C` from becoming SIGINT when the user meant to copy a selection.
     *
     * `preventDefault` is not optional: returning false only skips xterm's handling, it does not consume
     * the keydown. Left alone, the browser then fires its native `paste` event on xterm's hidden textarea,
     * which xterm also listens to — so the text landed twice, once from us and once from that listener.
     */
    term.attachCustomKeyEventHandler((event) => {
      switch (decideTerminalKey(event, term.hasSelection())) {
        case 'copy':
          event.preventDefault();
          this.copySelection(term);
          return false;
        case 'paste':
          event.preventDefault();
          this.pasteInto(term);
          return false;
        case 'pass':
          return true;
      }
    });

    term.open(element);

    // Clicking a pane focuses it. Capture phase, because xterm swallows the event on its own surface.
    element.addEventListener(
      'mousedown',
      () => {
        const at = groupIndexOf(this.layout.groups, terminalId);
        if (at !== -1 && at !== this.focused) {
          this.focused = at;
          this.render();
        }
      },
      true,
    );
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.openPaneMenu(terminalId, event.clientX, event.clientY);
    });

    const view: View = { term, fit, element, webgl: null, sent: null };
    this.views.set(terminalId, view);
    return view;
  }

  /**
   * Switches a pane to the WebGL renderer on its first real display.
   *
   * xterm's default renderer draws the screen as DOM nodes, and under Chromium's GPU compositing that
   * leaves stale text layers on screen while scrolling: frozen glyphs outside the grid, seen in the
   * wild here. The WebGL renderer repaints its whole canvas, so nothing can be left behind.
   *
   * Never called from `ensure()`: a view can be created for a *background* tab (`write` collects
   * history for hidden sessions), and a WebGL canvas initialised on a `display: none` element is born
   * with a garbage geometry that later shows up as exactly those frozen glyphs. Loading only from
   * `fitVisible`, after the pane is on screen and fitted, means the canvas gets its real dimensions.
   *
   * On context loss (Chromium caps live WebGL contexts per page and evicts the oldest), the addon is
   * disposed and xterm falls back to the DOM renderer on its own; marked `failed` so it is not
   * reloaded just to be evicted again.
   */
  private ensureRenderer(view: View): void {
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

  /**
   * Refits every pane on screen.
   *
   * All of them, not just the focused one: with a split, each pane has its own geometry and each pty
   * needs to be told about it, or the ones in the background wrap their output at the wrong width.
   *
   * Also where the WebGL renderer is engaged and a full repaint forced: this runs precisely when a
   * pane's geometry may have changed (shown, resized, split), which is when stale pixels appear.
   *
   * **The pty is only told when the geometry actually changed.** This method runs on every render:
   * switching tabs, focusing a pane, opening the notes panel, and once per `pointermove` while a
   * splitter is dragged. A resize of the same size is not free on Windows — ConPTY reprints the
   * screen it holds — and a full-screen TUI answers each one by redrawing its whole frame. Dozens of
   * those per second, interleaved with output already in flight, is how frames end up painted over
   * each other. The comparison costs nothing and removes every redundant one.
   */
  private fitVisible(): void {
    for (const group of this.layout.groups) {
      const view = this.views.get(group.active);
      if (view === undefined) {
        continue;
      }
      try {
        view.fit.fit();
        const { cols, rows } = view.term;
        if (view.sent === null || view.sent.cols !== cols || view.sent.rows !== rows) {
          view.sent = { cols, rows };
          this.actions.onResize(group.active, cols, rows);
        }
        this.ensureRenderer(view);
        // A resize repaints the new grid, not what the old one left outside it: repaint everything.
        view.term.refresh(0, rows - 1);
      } catch {
        // Fitting fails while the pane is hidden and has no size; harmless.
      }
    }
  }

  /* --------------------------------------------------------- copy & paste */

  /** Sends the selection to the system clipboard, via the main process. */
  private copySelection(term: Terminal): void {
    if (term.hasSelection()) {
      this.actions.onCopy(term.getSelection());
    }
  }

  /**
   * Pastes the system clipboard into a terminal.
   *
   * `term.paste` rather than writing the text straight through: it wraps the payload in bracketed paste
   * markers when the running program asked for them, which is what stops a multi-line paste from being
   * executed line by line.
   */
  private pasteInto(term: Terminal): void {
    void this.actions.onPasteRequest().then((text) => {
      if (text.length > 0) {
        term.paste(text);
      }
    });
  }

  /** Clears a pane, both ends: the xterm buffer and the pty's own copy of the screen. */
  private clear(terminalId: TerminalId): void {
    this.views.get(terminalId)?.term.clear();
    this.actions.onClear(terminalId);
  }

  /* --------------------------------------------------------- context menus */

  /**
   * The menu on a pane: splitting, and unsplitting.
   *
   * A split opens a **new shell in that pane's own directory**, the way Windows Terminal duplicates the
   * profile you split from: splitting a repository shell to get a second one in the same repository is
   * the whole point, and re-running the pane's command instead would be surprising for a dev server.
   *
   * Closing a pane hands its tabs to a neighbour: its processes keep running and its tabs stay
   * reachable. Killing a terminal remains the cross on its tab, so one stray click in a menu cannot
   * take down a build.
   */
  private openPaneMenu(terminalId: TerminalId, x: number, y: number): void {
    const session = this.sessions.find((entry) => entry.id === terminalId);
    const view = this.views.get(terminalId);
    const at = groupIndexOf(this.layout.groups, terminalId);
    if (session === undefined || view === undefined || at === -1) {
      return;
    }
    const { groups, direction } = this.layout;

    this.showMenu(x, y, [
      {
        label: 'Copy',
        hint: 'Ctrl+C with a selection, or Ctrl+Shift+C',
        // Same rule as the shortcut: nothing selected means nothing to copy, not "copy the screen".
        disabled: !view.term.hasSelection(),
        run: () => {
          this.copySelection(view.term);
          view.term.focus();
        },
      },
      {
        label: 'Paste',
        hint: 'Ctrl+V',
        run: () => {
          this.pasteInto(view.term);
          view.term.focus();
        },
      },
      {
        label: 'Split right',
        hint: 'Alt+Shift+D',
        run: () => this.actions.onSplitShell(session.cwd, 'columns'),
      },
      {
        label: 'Split down',
        hint: 'Alt+Shift+B',
        run: () => this.actions.onSplitShell(session.cwd, 'rows'),
      },
      {
        label: 'Close this pane',
        // Nothing to close when it is the only one, and its terminals must not die here.
        disabled: groups.length <= 1,
        hint: 'Ctrl+Alt+W: the tabs move to the neighbouring pane',
        run: () => {
          this.focused = at;
          this.closeFocusedGroup();
        },
      },
      {
        label: 'Merge into a single pane',
        disabled: groups.length <= 1,
        run: () => {
          const tabs = groups.flatMap((group) => group.tabs);
          this.focused = 0;
          this.applyLayout([{ tabs, active: terminalId }], direction);
          this.render();
        },
      },
    ]);
  }

  /** The menu on a tab: moving it to a pane of its own, renaming, closing. */
  private openTabMenu(session: TerminalSession, x: number, y: number): void {
    const alone = (this.layout.groups[groupIndexOf(this.layout.groups, session.id)]?.tabs.length ?? 0) <= 1;

    /*
     * "Close the tabs to the right" resolves to sessions here rather than in `tabsAfter`, because the
     * ones that refuse to close are a property of the session and not of the strip: a running dev
     * server is not closable, so it is **skipped and left in place** instead of turning the whole
     * gesture into a failure. The count in the label is the number that will actually go, and the hint
     * names what stays — a menu item promising four closures and doing three is how you stop trusting
     * the menu.
     */
    const rightward = tabsAfter(this.layout.groups, session.id);
    const closable = rightward
      .map((id) => this.sessions.find((entry) => entry.id === id))
      .filter((entry): entry is TerminalSession => entry !== undefined && entry.closable);
    const kept = rightward.length - closable.length;

    this.showMenu(x, y, [
      {
        label: 'Move to a pane on the right',
        // The only tab of its pane is already alone: moving it would close one pane to open another.
        disabled: alone,
        run: () => this.moveToOwnPane(session.id, 'columns'),
      },
      {
        label: 'Move to a pane below',
        disabled: alone,
        run: () => this.moveToOwnPane(session.id, 'rows'),
      },
      {
        label: 'Rename',
        run: () => {
          this.renaming = session.id;
          this.renderStrips();
        },
      },
      {
        label: 'Close the tab',
        hint: 'Alt+Shift+W on the active tab',
        disabled: !session.closable,
        run: () => this.actions.onClose(session.id),
      },
      {
        label:
          closable.length > 0
            ? `Close tabs to the right (${closable.length})`
            : 'Close tabs to the right',
        // Nothing to the right, or nothing there that can be closed: either way there is no gesture.
        disabled: closable.length === 0,
        hint:
          kept > 0
            ? `${kept} tab(s) stay: a running server does not close here, it stops with "Stop".`
            : 'Closes the following tabs of this pane only, not those of a neighbouring pane.',
        run: () => {
          for (const entry of closable) {
            this.actions.onClose(entry.id);
          }
        },
      },
    ]);
  }

  /** Takes a tab out of its pane and gives it one of its own, beside the pane it came from. */
  private moveToOwnPane(terminalId: TerminalId, direction: PaneDirection): void {
    const from = groupIndexOf(this.layout.groups, terminalId);
    this.applyLayout(splitGroup(this.layout.groups, from, terminalId), direction);
    this.focused = groupIndexOf(this.layout.groups, terminalId);
    this.render();
    this.views.get(terminalId)?.term.focus();
  }

  private showMenu(x: number, y: number, items: readonly MenuItem[]): void {
    showContextMenu(x, y, items);
  }

  /* ---------------------------------------------------------------- strips */

  /**
   * True while the rename input is on screen, which is when the strips must not be rebuilt.
   *
   * A render can land in the middle of a rename: double-clicking an inactive tab first *activates*
   * it, the layout change comes back as a broadcast from the main process, and rebuilding the strip
   * then replaces the input mid-edit — the fresh field never reliably wins the focus back from the
   * terminal, so the name sits there refusing keystrokes. Same invariant as the project table and
   * the Git panel: nothing redraws under an inline edit. Checked on the DOM rather than on
   * `renaming` alone, because entering rename mode goes through `renderStrips` to build the very
   * input this guard protects.
   */
  private renameInputLive(): boolean {
    return this.strips.some((strip) => strip.querySelector('.terminal__tab-input') !== null);
  }

  private renderStrips(): void {
    if (this.renaming !== null && !this.sessions.some((entry) => entry.id === this.renaming)) {
      // The session died mid-rename: nothing is left to name, so the edit cannot be kept open.
      this.renaming = null;
    }
    if (this.renaming !== null && this.renameInputLive()) {
      return;
    }
    this.layout.groups.forEach((group, index) => {
      const strip = this.strips[index];
      if (strip === undefined) {
        return;
      }
      clearChildren(strip);
      strip.classList.toggle('terminal__strip--focused', index === this.focused);

      const tabs = createElement('div', { className: 'terminal__tabs' });
      for (const id of group.tabs) {
        const session = this.sessions.find((entry) => entry.id === id);
        if (session !== undefined) {
          tabs.append(this.buildTab(session, group, index));
        }
      }
      tabs.append(this.buildNewTabButton(index));
      strip.append(tabs);

      const clear = createElement('button', {
        className: 'button button--quiet terminal__strip-clear',
        text: 'Clear',
      });
      clear.type = 'button';
      clear.title = 'Erase this tab\'s output';
      clear.addEventListener('click', (event) => {
        event.stopPropagation();
        this.clear(group.active);
      });
      strip.append(clear);
    });
  }

  private buildTab(session: TerminalSession, group: TerminalGroup, groupIndex: number): HTMLElement {
    // Two levels of highlight: `visible` says "this is what its pane is showing", `active` says "the
    // keyboard goes here", which with several panes on screen are genuinely different things.
    const classes = ['terminal__tab'];
    if (group.active === session.id) {
      classes.push('terminal__tab--visible');
      if (groupIndex === this.focused) {
        classes.push('terminal__tab--active');
      }
    }
    const wrapper = createElement('span', { className: classes.join(' ') });
    wrapper.dataset.terminalId = session.id;
    wrapper.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.openTabMenu(session, event.clientX, event.clientY);
    });

    if (this.renaming === session.id) {
      wrapper.append(this.buildRenameInput(session));
    } else {
      const label = createElement('button', {
        className: 'terminal__tab-label',
        text: session.title,
        // The working directory is the one thing you always want to know about a shell tab.
        title: `${session.cwd}\n(double-click to rename, drag to reorder or change pane)`,
      });
      label.type = 'button';
      label.setAttribute('aria-selected', String(session.id === this.activeId));
      label.addEventListener('click', () => this.select(session.id));
      // Double-click to rename in place, the convention every tabbed app already trained the user on.
      label.addEventListener('dblclick', (event) => {
        event.preventDefault();
        this.renaming = session.id;
        this.renderStrips();
      });
      wrapper.append(label);

      // Draggable only outside a rename: while the input is up, a drag would fight text selection in
      // the field. Both the wrapper and the label carry the flag, because the grab almost always starts
      // on the label and a `<button>` is not draggable on its own.
      wrapper.draggable = true;
      label.draggable = true;
      this.attachDragHandlers(wrapper, session.id, groupIndex);
    }

    // A dot marks a live process, so a finished tab is visibly inert rather than looking active.
    if (session.running) {
      wrapper.append(createElement('span', { className: 'terminal__tab-dot' }));
    }

    if (session.closable) {
      const close = createElement('button', { className: 'terminal__tab-close', text: '×' });
      close.type = 'button';
      close.title = 'Close this tab';
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        this.actions.onClose(session.id);
      });
      wrapper.append(close);
    }

    return wrapper;
  }

  /* ------------------------------------------------------------------ drag */

  /**
   * Drag and drop for one tab, within its pane or into another.
   *
   * **Nothing re-renders during a drag.** Replacing the dragged element mid-gesture cancels the drag in
   * Chromium, so the drop marker is toggled as a class on the live nodes and the strips are only
   * rebuilt once the main process reports the new layout. That is also what makes the result
   * authoritative rather than optimistic: what is shown is always what the main process holds.
   */
  private attachDragHandlers(wrapper: HTMLElement, id: TerminalId, groupIndex: number): void {
    wrapper.addEventListener('dragstart', (event) => {
      this.dragging = id;
      wrapper.classList.add('terminal__tab--dragging');
      if (event.dataTransfer !== null) {
        event.dataTransfer.effectAllowed = 'move';
        // Some payload is required for a drag to start at all in Chromium.
        event.dataTransfer.setData('text/plain', id);
      }
    });

    wrapper.addEventListener('dragover', (event) => {
      if (this.dragging === null || this.dragging === id) {
        return;
      }
      // Without this the drop is refused and the cursor shows "not allowed".
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer !== null) {
        event.dataTransfer.dropEffect = 'move';
      }
      this.markDropTarget(wrapper, this.sideOf(wrapper, event.clientX));
    });

    wrapper.addEventListener('drop', (event) => {
      const moved = this.dragging;
      if (moved === null || moved === id) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const before = this.neighbourOf(groupIndex, id, moved, this.sideOf(wrapper, event.clientX));
      this.endDrag();
      this.commitMove(moved, groupIndex, before);
    });

    // Covers a drag released outside the strips or cancelled with Escape: markers must not survive.
    wrapper.addEventListener('dragend', () => this.endDrag());
  }

  /**
   * Dropping on a strip rather than on one of its tabs appends to that pane.
   *
   * This is what makes an empty-ish strip a valid target at all, and it is the gesture for "put this
   * terminal in that pane" when the aim is the pane rather than a position in its order.
   */
  private attachStripDrop(strip: HTMLElement, groupIndex: number): void {
    strip.addEventListener('dragover', (event) => {
      if (this.dragging === null) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer !== null) {
        event.dataTransfer.dropEffect = 'move';
      }
      strip.classList.add('terminal__strip--drop');
    });
    strip.addEventListener('dragleave', () => strip.classList.remove('terminal__strip--drop'));
    strip.addEventListener('drop', (event) => {
      const moved = this.dragging;
      if (moved === null) {
        return;
      }
      event.preventDefault();
      this.endDrag();
      this.commitMove(moved, groupIndex, null);
    });
  }

  /**
   * Reports a move and waits for the answer.
   *
   * Deliberately not applied locally first, unlike every other gesture: a drop is the one case where
   * an optimistic render would land while Chromium is still finishing the drag, and the strips are
   * exactly the nodes it is dragging from.
   */
  private commitMove(moved: TerminalId, toGroup: number, before: TerminalId | null): void {
    this.actions.onLayout(
      moveTab(this.layout.groups, moved, toGroup, before),
      this.layout.direction,
    );
  }

  /**
   * The tab a drop should land in front of, `null` to land last.
   *
   * Read from the target pane's tabs **with the dragged one removed**, which is what `moveTab`
   * expects and what removes the off-by-one of a rightwards move: an index taken from a list that
   * still contains the dragged tab points one slot short the moment it leaves.
   */
  private neighbourOf(
    groupIndex: number,
    target: TerminalId,
    moved: TerminalId,
    side: DropSide,
  ): TerminalId | null {
    const tabs = (this.layout.groups[groupIndex]?.tabs ?? []).filter((id) => id !== moved);
    const at = tabs.indexOf(target);
    if (at === -1) {
      return null;
    }
    return side === 'before' ? target : (tabs[at + 1] ?? null);
  }

  /** Left half means "insert before", right half "insert after". */
  private sideOf(wrapper: HTMLElement, clientX: number): DropSide {
    const box = wrapper.getBoundingClientRect();
    return clientX < box.left + box.width / 2 ? 'before' : 'after';
  }

  private markDropTarget(wrapper: HTMLElement, side: DropSide): void {
    this.clearDropMarkers();
    wrapper.classList.add(`terminal__tab--drop-${side}`);
  }

  private clearDropMarkers(): void {
    for (const strip of this.strips) {
      strip.classList.remove('terminal__strip--drop');
      for (const tab of strip.querySelectorAll('.terminal__tab')) {
        tab.classList.remove(
          'terminal__tab--dragging',
          'terminal__tab--drop-before',
          'terminal__tab--drop-after',
        );
      }
    }
  }

  private endDrag(): void {
    this.dragging = null;
    this.clearDropMarkers();
  }

  /**
   * Inline editor for a tab name.
   *
   * Enter commits, Escape cancels, losing focus commits too: clicking away after typing a name is a
   * far more common gesture than wanting to discard it, so treating blur as a cancel would routinely
   * throw the name away.
   */
  private buildRenameInput(session: TerminalSession): HTMLElement {
    const input = createElement('input', { className: 'terminal__tab-input' });
    input.type = 'text';
    input.value = session.title;
    input.setAttribute('aria-label', 'Rename this tab');

    let settled = false;
    const commit = (accept: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      this.renaming = null;
      if (accept) {
        this.actions.onRename(session.id, input.value);
      }
      this.renderStrips();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        commit(false);
      }
    });
    input.addEventListener('blur', () => commit(true));
    // Stops a click inside the field from bubbling to the document handler that closes the menu.
    input.addEventListener('click', (event) => event.stopPropagation());

    // Focus after the element is in the DOM, and preselect so typing replaces the old name. A
    // microtask rather than `requestAnimationFrame`: the strip render that carries this input
    // finishes the current task, so the microtask already finds it attached — and an animation
    // frame is throttled in an occluded window, which left the field on screen but never focused.
    queueMicrotask(() => {
      input.focus();
      input.select();
    });

    return input;
  }

  /**
   * The new-tab control of one pane: a click opens the default profile, the caret lists the others.
   *
   * Same split as Windows Terminal, because that is the gesture already in the user's hands. One per
   * pane, and it opens the tab **in that pane**: with each pane carrying its own strip, a single
   * global `+` would leave the user guessing where the tab went.
   */
  private buildNewTabButton(groupIndex: number): HTMLElement {
    const group = createElement('span', { className: 'terminal__new' });

    const add = createElement('button', { className: 'terminal__new-button', text: '+' });
    add.type = 'button';
    add.title = 'New tab in this pane';
    add.addEventListener('click', (event) => {
      event.stopPropagation();
      const first = this.profiles[0];
      if (first !== undefined) {
        this.focused = groupIndex;
        this.actions.onNewShell(first.id);
      }
    });
    group.append(add);

    if (this.profiles.length > 1) {
      const caret = createElement('button', { className: 'terminal__new-caret' });
      caret.type = 'button';
      // A drawn chevron rather than the `⌄` character: as text it renders at whatever size and
      // baseline the font decides, which is why it looked like a stray mark next to the `+`.
      caret.append(chevronDown());
      caret.title = 'Choose a shell';
      caret.setAttribute('aria-label', 'Choose a shell');
      caret.addEventListener('click', (event) => {
        event.stopPropagation();
        this.menuOpen = this.menuOpen === groupIndex ? null : groupIndex;
        this.renderStrips();
      });
      group.append(caret);
    }

    if (this.menuOpen === groupIndex) {
      group.append(this.buildProfileMenu(groupIndex));
    }

    return group;
  }

  private buildProfileMenu(groupIndex: number): HTMLElement {
    const menu = createElement('div', { className: 'terminal__menu' });
    for (const profile of this.profiles) {
      const item = createElement('button', {
        className: 'terminal__menu-item',
        text: profile.label,
        title: profile.file,
      });
      item.type = 'button';
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        this.menuOpen = null;
        this.focused = groupIndex;
        this.actions.onNewShell(profile.id);
      });
      menu.append(item);
    }
    return menu;
  }
}

/* ------------------------------------------------------------------ *
 * Grid arithmetic
 *
 * A pane occupies two cells: its strip and its view. In a column layout the two live in the two fixed
 * rows of the grid and a pane is one column; stacked, a pane is two rows of a single column. Pure
 * functions rather than inline arithmetic because "which line is pane 3 on" is exactly the kind of
 * off-by-one that shows up as a pane silently drawn on top of another.
 * ------------------------------------------------------------------ */

/** Grid line of a pane's tab strip: its column when side by side, its row when stacked. */
export function stripLine(index: number, columns: boolean): number {
  return columns ? index * 2 + 1 : index * 3 + 1;
}

/** Grid line of a pane's terminal view. */
export function viewLine(index: number, columns: boolean): number {
  return columns ? index * 2 + 1 : index * 3 + 2;
}

/** Grid line of the splitter sitting after pane `index`. */
export function splitterLine(index: number, columns: boolean): number {
  return columns ? index * 2 + 2 : index * 3 + 3;
}

/** Puts an element on a grid line, on the axis the layout runs along. */
function place(element: HTMLElement, columns: boolean, line: number, row: string | undefined): void {
  if (columns) {
    element.style.gridColumn = String(line);
    element.style.gridRow = row ?? 'auto';
  } else {
    element.style.gridColumn = '1';
    element.style.gridRow = String(line);
  }
}
