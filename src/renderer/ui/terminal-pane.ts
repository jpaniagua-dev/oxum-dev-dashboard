import type { Terminal } from '@xterm/xterm';
import { TAG_COLORS } from '@shared/project-tags.js';
import {
  PANE_COLUMNS_AUTO,
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
  paneGrid,
  panePlacement,
  splitGroup,
  spreadTabs,
  tabsAfter,
  type PaneGrid,
} from '@shared/terminal-groups.js';
import { AGENT_ICON } from './icons.js';
import { showContextMenu, type MenuItem } from './context-menu.js';
import { clearChildren, createElement, createIcon } from './dom.js';
import { buildTagDots, primaryTagColor, type TagPalette } from './tags.js';
import {
  createTerminalView,
  ensureTerminalRenderer,
  TERMINAL_THEMES,
  type TerminalView,
} from './terminal-view.js';

/**
 * The chevron of the shell picker.
 *
 * Drawn as a stroke so it keeps the same weight as the `+` next to it at any zoom, which the `⌄`
 * character did not: as text its size and baseline were the font's decision.
 */
function chevronDown(): SVGSVGElement {
  return createIcon('M3.5 6l4.5 4.5L12.5 6', { paint: 'stroke' });
}

/**
 * Four arrows pushing outwards: this pane takes the whole surface.
 *
 * Corners rather than a plain square, which is what the operating system's own maximise button uses
 * and therefore what already means "restore" to anyone who has seen a window.
 */
function growIcon(): SVGSVGElement {
  return createIcon('M6.5 2.5h-4v4M9.5 2.5h4v4M6.5 13.5h-4v-4M9.5 13.5h4v-4', { paint: 'stroke' });
}

/** A terminal: a screen with a prompt in it. Opens the default shell. */
function terminalIcon(): SVGSVGElement {
  return createIcon('M2.5 3.5h11v9h-11zM5 6.6l1.7 1.4L5 9.4M8.6 9.8h3.2', { paint: 'stroke' });
}

/** The same four arrows pulled back in: put this pane back in the grid. */
function shrinkIcon(): SVGSVGElement {
  return createIcon('M2.5 6.5h4v-4M13.5 6.5h-4v-4M2.5 9.5h4v4M13.5 9.5h-4v4', { paint: 'stroke' });
}

/**
 * The shapes the picker offers, in the order it lists them.
 *
 * Four, and the cap is **vertical**. The terminal shares this window with the project strip, which
 * leaves it around two thirds of the height; split into three rows that is roughly nine lines per
 * cell here, and a Claude Code session spends five or six of them on its own frame and status line.
 * A three-row preset would therefore offer three lines of conversation, which is a shape that looks
 * like a feature and is not one. Three columns are fine: they cost width, and width is what this
 * window has. Folding the strip is what buys the height back, which is why that button sits beside
 * this one.
 */
export const PANE_COLUMN_CHOICES: readonly {
  readonly columns: number;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    columns: PANE_COLUMNS_AUTO,
    label: 'Side by side',
    hint: 'One row, one column per pane. What splitting right has always done.',
  },
  { columns: 1, label: 'Stacked', hint: 'One column, the panes under one another.' },
  { columns: 2, label: 'Two columns', hint: 'Four panes make a 2x2. Fold the strip for the height.' },
  { columns: 3, label: 'Three columns', hint: 'Wide window only: a third of the width per pane.' },
];

export interface TerminalPaneActions {
  onInput: (terminalId: TerminalId, data: string) => void;
  onResize: (terminalId: TerminalId, cols: number, rows: number) => void;
  onClose: (terminalId: TerminalId) => void;
  onRename: (terminalId: TerminalId, title: string) => void;
  /** Open a new shell tab from a profile, in the focused pane. */
  onNewShell: (profileId: string) => void;
  /**
   * Open the configured coding agent in a tab of its own.
   *
   * Its own action and not a profile in the list above, because it is not a shell: it starts in the
   * workspace root whatever the focused pane is doing, it belongs to no project, and it is what the
   * Agents tab lists. Folding it into `onNewShell` would mean a profile id that is not a profile.
   */
  onNewAgent: () => void;
  /** The panes and their tabs after a gesture. One call for every shape the surface can take. */
  onLayout: (groups: readonly TerminalGroup[], columns: number) => void;
  /**
   * Open a new shell in a directory, for a split.
   *
   * The pane resolves nothing itself: it hands over the working directory of the pane being split and
   * the caller decides which profile that means.
   */
  onSplitShell: (cwd: string, direction: PaneDirection) => void;
  /** Hands one tab over to the servers window. Only offered while that window is open. */
  onMoveToServers: (terminalId: TerminalId) => void;
  /** Opens the note editor, which lives on the board. See the menu entry for why. */
  onEditNote: (terminalId: TerminalId) => void;
  /** Whether the board is the surface on screen, and so whether a note can be edited at all. */
  canEditNote: () => boolean;
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
  /**
   * Opens a URL printed in the terminal, in the real browser.
   *
   * A callback and not a direct `window.api` call, like every other side effect this pane has: the
   * pane builds DOM and knows nothing about the process boundary. The renderer cannot open a browser
   * itself anyway, `shell.openExternal` living in the main process behind the same `http(s)`-only
   * guard the pull request rows already go through.
   */
  onOpenLink: (url: string) => void;
}

/** Which side of a tab a drop lands on. */
type DropSide = 'before' | 'after';

/**
 * A terminal, plus the one thing only a pane needs to remember about it.
 *
 * Everything about xterm itself lives in `TerminalView`, shared with any other owner of a terminal.
 * `sent` is the pane's alone: it exists because *this* surface refits on every render, which is not
 * true of an arrangement that never splits or reorders.
 */
interface View extends TerminalView {
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
  /** Id of the tab currently being renamed in place, if any. */
  private renaming: TerminalId | null = null;
  /**
   * Whether the servers window is open, which decides whether a tab can be sent there.
   *
   * Mirrored from the main process through `setServersDetached`, never inferred: that window can be
   * closed by its own cross, and a pane offering to move a tab into a window that is gone would take
   * the tab off this surface and hand it to nobody.
   */
  private serversDetached = false;
  /** Tab being dragged, if any. Held so a drop knows what to move. */
  private dragging: TerminalId | null = null;
  /** The panes, mirroring what the main process holds. */
  private layout: TerminalLayout = { columns: PANE_COLUMNS_AUTO, groups: [] };
  /**
   * Which project carries which tag, for the colour a strip takes.
   *
   * Handed in rather than looked up, the same value the pull request, Git and worktree rows are
   * given: a tag is a fact about a project, and four views resolving it four ways is four chances to
   * paint the same repository two colours.
   */
  private palette: TagPalette = { projects: [], colors: {} };
  /**
   * Index of the pane the keyboard and every "here" gesture belong to.
   *
   * A new tab, a split and the shortcuts all need a pane to act on, and with several complete
   * terminals on screen "the current one" is no longer implied by there being a single strip.
   */
  private focused = 0;
  /**
   * Relative width of each grid column, and height of each grid row.
   *
   * Renderer-only, unlike the layout itself: a pixel preference rather than user intent. Two arrays
   * and not one per pane, because the tracks are shared: dragging the divider between the first and
   * second column moves it on **every** row, which is the only thing a CSS grid can express and also
   * the only thing that keeps the cells aligned. Reset to equal shares whenever the shape changes,
   * a fraction that meant something for three columns being meaningless for two.
   */
  private colSizes: number[] = [];
  private rowSizes: number[] = [];
  /**
   * The controls that act on the whole surface, which ride in the first pane's strip.
   *
   * Owned by the page and only placed here: they are application chrome, and building them in this
   * class would give the pane an opinion about what the application offers. `null` until handed over.
   */
  private surfaceControls: HTMLElement | null = null;
  /** Where those controls live when there is no strip to put them in. */
  private surfaceControlsHome: HTMLElement | null = null;
  /** Tab strips, one per pane, reused across renders rather than rebuilt. */
  private readonly strips: HTMLElement[] = [];
  /**
   * Which group each strip is currently drawing, by strip position.
   *
   * A strip is reused across renders and its drop handler is bound once, so the handler cannot close
   * over a group index: zooming draws one pane at position 0 that is not group 0, and a dropped tab
   * would land in the wrong pane. The handler reads this instead, which is rewritten on every render.
   */
  private stripOwner: number[] = [];
  /** Dividers between two columns, spanning the rows. Reused across renders. */
  private readonly colSplitters: HTMLElement[] = [];
  /** Dividers between two rows, spanning the columns. Reused across renders. */
  private readonly rowSplitters: HTMLElement[] = [];
  /**
   * The pane blown up to the whole surface, named by its active tab, or `null`.
   *
   * Renderer-only and named by a **session** rather than by a group index: a group index shifts when
   * a pane closes, so a zoom held that way would silently move to another pane. Cleared on its own
   * when that session dies, which `zoomedIndex` does by answering `null` for an id in no group.
   *
   * Deliberately **not** bound to `Escape`. A terminal owns that key: it is how you leave insert mode
   * in vim and how Claude Code interrupts itself, both printed on screen a few lines under the strip.
   * A surface-level listener would have to swallow it before xterm sees it, and the gesture it would
   * buy is already on a button and on `Alt+Shift+Z`.
   */
  private zoomed: TerminalId | null = null;

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
        } else if (key === 'z') {
          event.preventDefault();
          this.toggleZoom();
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
    this.adopt(layout.groups, layout.columns);
    this.render();
  }

  /** Panes per row, as the surface currently holds it. */
  get columns(): number {
    return this.layout.columns;
  }

  /**
   * Rearranges the surface into a different number of columns, one session per cell.
   *
   * **It spreads the tabs, and that is the whole point.** A pane is a group of tabs and every
   * session opens into the focused one, so a surface left alone holds a single pane however many
   * sessions are running, and a column count then resolves to one. Picking a shape and watching
   * nothing move is what this does without the spread, which is exactly how it shipped first.
   *
   * Nothing is killed and nothing is hidden: the same sessions are held one per pane, the grid grows
   * downwards to fit them all, and the pane menu's "Merge into a single pane" is the way back. Zoom
   * is dropped, picking a shape being a statement about seeing several panes at once.
   */
  setColumns(columns: number): void {
    this.zoomed = null;
    this.applyLayout(spreadTabs(this.layout.groups), columns);
    this.render();
  }

  /**
   * Adopts the surface-wide controls, to be shown in the first pane's strip.
   *
   * **The first pane and not every one**, which is the decision worth stating: these act on the
   * whole surface, so one copy per pane would be nine copies of one control at 3x3, and a reader
   * would reasonably expect the one in a pane's strip to act on that pane. First rather than last
   * because the first strip is the top-left one, which is where a grid is read from.
   */
  setSurfaceControls(element: HTMLElement | null): void {
    this.surfaceControls = element;
    // Captured once and kept. Re-reading the parent on every call would record wherever the element
    // happens to be at the time, and it spends part of its life inside the board's own toolbar.
    if (this.surfaceControlsHome === null && element !== null) {
      this.surfaceControlsHome = element.parentElement;
    }
    this.renderStrips();
  }

  /** The tag colours, for the accent a strip takes from its project. */
  setTagPalette(palette: TagPalette): void {
    this.palette = palette;
    this.render();
  }

  setTheme(theme: ResolvedTheme): void {
    this.theme = theme;
    for (const view of this.views.values()) {
      view.term.options.theme = TERMINAL_THEMES[theme];
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
  /** Tells the pane whether the servers window exists, for the one menu entry that depends on it. */
  setServersDetached(detached: boolean): void {
    this.serversDetached = detached;
  }

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
    this.adopt(this.layout.groups, this.layout.columns);
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
      this.applyLayout(addTab(this.layout.groups, this.focused, terminalId), this.layout.columns);
    } else {
      this.focused = at;
      this.applyLayout(activateTab(this.layout.groups, terminalId), this.layout.columns);
    }
    // A tab clicked in another pane while one is blown up: the click says "show me this", so the
    // zoom has to give way rather than hide the pane the user just asked for.
    if (this.zoomed !== null && groupIndexOf(this.layout.groups, this.zoomed) !== this.focused) {
      this.zoomed = null;
    }
    this.render();
    this.views.get(terminalId)?.term.focus();
  }

  /** Puts a session in a brand new pane beside the focused one, which is what a split does. */
  addPane(terminalId: TerminalId, direction: PaneDirection): void {
    this.ensure(terminalId);
    const at = this.focused;
    this.zoomed = null;
    this.applyLayout(splitGroup(this.layout.groups, at, terminalId), this.afterSplit(direction));
    this.focused = groupIndexOf(this.layout.groups, terminalId);
    this.render();
    this.views.get(terminalId)?.term.focus();
  }

  /**
   * What the grid becomes when the user splits right or splits down.
   *
   * Only the two shapes that have a direction answer to this. A surface on one row asked to split
   * downwards becomes a single column, and a single column asked to split rightwards goes back to
   * one row, which is exactly the pair this app had before the grid existed. Once a fixed grid is
   * picked the direction is **ignored**: where a new pane lands is then the grid's business, and
   * rearranging the whole surface because somebody chose one menu entry over the other would undo
   * a choice they made deliberately.
   */
  private afterSplit(direction: PaneDirection): number {
    const current = this.layout.columns;
    if (direction === 'rows' && current === PANE_COLUMNS_AUTO) {
      return 1;
    }
    if (direction === 'columns' && current === 1) {
      return PANE_COLUMNS_AUTO;
    }
    return current;
  }

  /* ----------------------------------------------------------------- zoom */

  /** The group currently blown up, or `null`. Answers `null` for a session that has since died. */
  private zoomedIndex(): number | null {
    if (this.zoomed === null) {
      return null;
    }
    const at = groupIndexOf(this.layout.groups, this.zoomed);
    return at === -1 ? null : at;
  }

  /**
   * Blows the focused pane up to the whole surface, or puts it back.
   *
   * A no-op with a single pane: there is nothing to hide and nothing to come back to, and a button
   * that appears to do nothing is worse than one that is not offered.
   */
  private toggleZoom(): void {
    if (this.zoomedIndex() !== null) {
      this.zoomed = null;
    } else if (this.layout.groups.length > 1) {
      this.zoomed = this.activeId;
    }
    this.render();
    const active = this.activeId;
    if (active !== null) {
      this.views.get(active)?.term.focus();
    }
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
  private adopt(groups: readonly TerminalGroup[], columns: number): void {
    const live = this.sessions.map((session) => session.id);
    const next = normalizeGroups(groups, live);
    this.layout = { columns, groups: next };
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
  private applyLayout(groups: readonly TerminalGroup[], columns: number): void {
    this.adopt(groups, columns);
    this.actions.onLayout(this.layout.groups, this.layout.columns);
  }

  /** Closes the focused pane, its tabs moving to a neighbour rather than dying with it. */
  private closeFocusedGroup(): void {
    const at = this.focused;
    this.zoomed = null;
    this.applyLayout(closeGroup(this.layout.groups, at), this.layout.columns);
    this.focused = Math.min(at, this.layout.groups.length - 1);
    this.render();
  }

  private render(): void {
    this.renderSurface();
    this.renderStrips();
  }

  /**
   * The panes currently drawn, with the index of the group each one holds.
   *
   * One entry per group normally, and exactly one while a pane is blown up. Every render walks this
   * rather than `layout.groups`, which is what keeps zooming from becoming a special case in four
   * separate places.
   */
  private visiblePanes(): { group: TerminalGroup; index: number }[] {
    const { groups } = this.layout;
    const zoomAt = this.zoomedIndex();
    if (zoomAt === null) {
      return groups.map((group, index) => ({ group, index }));
    }
    const group = groups[zoomAt];
    return group === undefined ? [] : [{ group, index: zoomAt }];
  }

  /**
   * Places every pane on the surface.
   *
   * **No terminal is ever moved in the DOM.** Each keeps the permanent container it was opened on, and
   * placement is done by assigning explicit grid lines: detaching an xterm element to reorder it would
   * leave the terminal alive but blank forever. A pane is two cells of that grid, the strip above its
   * view, so both are direct children of the surface and neither wraps the other.
   *
   * The grid runs on two axes now, and the track pattern differs between them, which is the piece of
   * arithmetic worth stating here. A column is a single `fr` track, so pane column `c` sits on line
   * `2c + 1` with its divider on the even line after it. A row is **two** tracks, `auto` for the strip
   * and `fr` for the view, so pane row `r` puts its strip on `3r + 1`, its view on `3r + 2` and its
   * divider on `3r + 3`. Getting one of those wrong draws a pane on top of another, which reads as a
   * pane that simply failed to appear, so both live in named functions pinned by test.
   */
  private renderSurface(): void {
    const { groups } = this.layout;
    const panes = this.visiblePanes();
    const zoomed = this.zoomedIndex() !== null;

    // The sizes are keyed to the real shape and not to the drawn one: zooming must not reset the
    // fractions the user dragged, being a temporary look at one pane rather than a new layout.
    const shape = paneGrid(this.layout.columns, groups.length);
    if (this.colSizes.length !== shape.columns) {
      this.colSizes = Array.from({ length: shape.columns }, () => 1);
    }
    if (this.rowSizes.length !== shape.rows) {
      this.rowSizes = Array.from({ length: shape.rows }, () => 1);
    }

    const grid: PaneGrid = zoomed ? { columns: 1, rows: 1 } : shape;
    const columnTracks: string[] = [];
    for (let column = 0; column < grid.columns; column += 1) {
      if (column > 0) {
        columnTracks.push('var(--pane-splitter)');
      }
      columnTracks.push(`${zoomed ? 1 : (this.colSizes[column] ?? 1)}fr`);
    }
    const rowTracks: string[] = [];
    for (let row = 0; row < grid.rows; row += 1) {
      if (row > 0) {
        rowTracks.push('var(--pane-splitter)');
      }
      rowTracks.push('auto', `${zoomed ? 1 : (this.rowSizes[row] ?? 1)}fr`);
    }

    this.surface.style.gridTemplateColumns = columnTracks.join(' ');
    this.surface.style.gridTemplateRows = rowTracks.join(' ');

    this.syncStrips(panes.length);
    this.syncSplitters(grid, panes.length);

    // Where each drawn pane sits, keyed by the group it holds, so a view can find its own cell
    // without walking the list a second time.
    const cells = new Map<number, { columnLines: string; stripRow: string; viewRow: string }>();
    panes.forEach((pane, position) => {
      const { row, column, span } = panePlacement(position, panes.length, grid);
      const columnLines = `${paneColumnLine(column)} / ${paneColumnLine(column + span - 1) + 1}`;
      cells.set(pane.index, {
        columnLines,
        stripRow: String(stripRowLine(row)),
        viewRow: String(viewRowLine(row)),
      });
    });

    this.stripOwner = panes.map((pane) => pane.index);
    this.strips.forEach((strip, position) => {
      const pane = panes[position];
      strip.hidden = pane === undefined;
      const cell = pane === undefined ? undefined : cells.get(pane.index);
      if (cell !== undefined) {
        strip.style.gridColumn = cell.columnLines;
        strip.style.gridRow = cell.stripRow;
      }
    });

    const focusedActive = groups[this.focused]?.active ?? null;
    for (const [id, view] of this.views) {
      const at = groupIndexOf(groups, id);
      const group = at === -1 ? undefined : groups[at];
      const cell = cells.get(at);
      view.element.hidden = group === undefined || group.active !== id || cell === undefined;
      if (cell !== undefined) {
        view.element.style.gridColumn = cell.columnLines;
        view.element.style.gridRow = cell.viewRow;
      }
      view.element.classList.toggle(
        'terminal__view--focused',
        groups.length > 1 && id === focusedActive,
      );
    }

    this.fitVisible();
  }

  /** Keeps one strip per drawn pane, reusing the elements across renders. */
  private syncStrips(paneCount: number): void {
    while (this.strips.length < paneCount) {
      const position = this.strips.length;
      const strip = createElement('div', { className: 'terminal__strip' });
      this.attachStripDrop(strip, position);
      this.surface.append(strip);
      this.strips.push(strip);
    }
  }

  /**
   * Keeps one divider per gap in the grid, reusing the elements across renders.
   *
   * A column divider spans every row and a row divider spans every column, which is what a shared
   * track means: there is one boundary between the first and second column, not one per row.
   *
   * The exception is the **short last row**. Its last pane stretches to the end of the row, so a
   * column gap falling inside that stretch has no boundary there and has to stop above it, or a
   * divider is drawn straight through a pane. `filled` is how many panes that last row holds.
   */
  private syncSplitters(grid: PaneGrid, paneCount: number): void {
    const columnGaps = Math.max(0, grid.columns - 1);
    const rowGaps = Math.max(0, grid.rows - 1);

    while (this.colSplitters.length < columnGaps) {
      this.colSplitters.push(this.buildSplitter(this.colSplitters.length, 'columns'));
    }
    while (this.rowSplitters.length < rowGaps) {
      this.rowSplitters.push(this.buildSplitter(this.rowSplitters.length, 'rows'));
    }

    const filled = paneCount - (grid.rows - 1) * grid.columns;
    this.colSplitters.forEach((splitter, gap) => {
      splitter.hidden = gap >= columnGaps;
      if (splitter.hidden) {
        return;
      }
      // `grid.rows < 2` cannot reach the short-row branch today, a single row always being full by
      // construction in `paneGrid`. Guarded all the same: the else branch would ask for row line 0,
      // which is not a line, and CSS answers an invalid grid placement by silently ignoring it.
      const toLastRow = grid.rows < 2 || filled === grid.columns || gap < filled - 1;
      splitter.style.gridColumn = String(columnSplitterLine(gap));
      splitter.style.gridRow = toLastRow ? '1 / -1' : `1 / ${rowSplitterLine(grid.rows - 2)}`;
    });

    this.rowSplitters.forEach((splitter, gap) => {
      splitter.hidden = gap >= rowGaps;
      if (splitter.hidden) {
        return;
      }
      splitter.style.gridColumn = '1 / -1';
      splitter.style.gridRow = String(rowSplitterLine(gap));
    });
  }

  private buildSplitter(gap: number, axis: PaneDirection): HTMLElement {
    const splitter = createElement('div', {
      className:
        axis === 'rows' ? 'terminal__splitter terminal__splitter--rows' : 'terminal__splitter',
    });
    splitter.setAttribute('role', 'separator');
    this.attachSplitterDrag(splitter, gap, axis);
    this.surface.append(splitter);
    return splitter;
  }

  /**
   * Dragging a splitter moves size from one neighbour to the other.
   *
   * Only the two panes it sits between are touched, so the others keep exactly the space they had.
   * Pointer capture on the splitter is what makes a fast drag survive leaving the element.
   */
  private attachSplitterDrag(splitter: HTMLElement, gap: number, axis: PaneDirection): void {
    const rows = axis === 'rows';
    let dragging = false;
    let startPos = 0;
    let before = 1;
    let after = 1;
    let extent = 1;

    // The track array this divider moves size within. Read through a function rather than captured,
    // because a change of shape replaces the arrays wholesale.
    const sizes = (): number[] => (rows ? this.rowSizes : this.colSizes);

    splitter.addEventListener('pointerdown', (event) => {
      dragging = true;
      splitter.setPointerCapture(event.pointerId);
      startPos = rows ? event.clientY : event.clientX;
      before = sizes()[gap] ?? 1;
      after = sizes()[gap + 1] ?? 1;
      const box = this.surface.getBoundingClientRect();
      extent = rows ? box.height : box.width;
      event.preventDefault();
    });

    splitter.addEventListener('pointermove', (event) => {
      if (!dragging || extent <= 0) {
        return;
      }
      const moved = (rows ? event.clientY : event.clientX) - startPos;
      // Pixels to fractions: the pair shares `before + after` of the total, so the same ratio applies.
      const total = before + after;
      const perPixel = total / extent;
      const delta = moved * perPixel;
      // A pane narrower than this is unusable, and a zero-width xterm throws on fit.
      const min = total * 0.12;
      const nextBefore = Math.min(Math.max(before + delta, min), total - min);
      const track = sizes();
      track[gap] = nextBefore;
      track[gap + 1] = total - nextBefore;
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

  /**
   * The view of a terminal, created on first need.
   *
   * Split in two on purpose. `createTerminalView` builds the xterm instance, which is the part every
   * owner of a terminal needs and which no second window may re-derive; everything below it is about
   * **this** surface: where the container goes, what a click on it focuses, and which menu a right-click
   * opens. That is the seam, and it is the whole reason a servers window could tile the same terminals
   * without a tab bar or a splitter.
   */
  private ensure(terminalId: TerminalId): View {
    const existing = this.views.get(terminalId);
    if (existing !== undefined) {
      return existing;
    }

    const view: View = {
      ...createTerminalView({
        fontSize: this.fontSize,
        theme: this.theme,
        compat: this.compat,
        onInput: (data) => this.actions.onInput(terminalId, data),
        onCopy: (text) => this.actions.onCopy(text),
        onPasteRequest: () => this.actions.onPasteRequest(),
        onOpenLink: (url) => this.actions.onOpenLink(url),
      }),
      sent: null,
    };
    const { element } = view;
    this.surface.append(element);

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

    this.views.set(terminalId, view);
    return view;
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
      // A pane hidden behind a zoomed one has no box to measure. Skipped rather than left to throw
      // inside the catch below: a hidden element measures zero, and xterm answers a zero box with a
      // one-column geometry that would then be announced to the pty as if it were real.
      if (view === undefined || view.element.hidden) {
        continue;
      }
      try {
        view.fit.fit();
        const { cols, rows } = view.term;
        if (view.sent === null || view.sent.cols !== cols || view.sent.rows !== rows) {
          view.sent = { cols, rows };
          this.actions.onResize(group.active, cols, rows);
        }
        ensureTerminalRenderer(view);
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
    const { groups } = this.layout;

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
        label: this.zoomedIndex() === null ? 'Blow this pane up' : 'Back to the grid',
        hint: 'Alt+Shift+Z. Not Escape: the terminal owns that key.',
        disabled: groups.length <= 1,
        run: () => {
          this.focused = at;
          this.toggleZoom();
        },
      },
      {
        label: 'Merge into a single pane',
        disabled: groups.length <= 1,
        run: () => {
          const tabs = groups.flatMap((group) => group.tabs);
          this.focused = 0;
          this.zoomed = null;
          this.applyLayout([{ tabs, active: terminalId }], this.layout.columns);
          this.render();
        },
      },
    ]);
  }

  /**
   * The menu on a tab: moving it to a pane of its own, renaming, closing.
   *
   * Public since the board draws the same sessions as cards and offers the same gestures on them.
   * One list and not two: a card and a tab are two drawings of one session, and a second menu would
   * drift the first time an entry was added to only one of them.
   */
  openSessionMenu(session: TerminalSession, x: number, y: number): void {
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
        label: 'Move to the servers window',
        // Only while that window exists: moving a tab to a window that is not open would take it off
        // the dashboard and hand it to nobody. The hint says so rather than leaving a dead entry.
        disabled: !this.serversDetached,
        hint: this.serversDetached
          ? 'For a server this app cannot recognise on its own, a `npm run start` typed into a shell'
          : 'Open the servers window first, from the icon next to the settings gear',
        run: () => this.actions.onMoveToServers(session.id),
      },
      {
        label: 'Rename',
        run: () => {
          this.renaming = session.id;
          this.renderStrips();
        },
      },
      {
        /*
         * One menu for a tab and for its card, which is why this entry lives here and acts over
         * there.
         *
         * A rename is a title, one line, and this strip has room for its input. A note is three
         * lines about what a session is FOR, which is the question a board of forty cards makes
         * unanswerable and which no twenty-four pixel strip can host an editor for. So the editor is
         * the board's, and this entry says so in its hint rather than switching surfaces under the
         * reader: a menu that moves you somewhere you did not ask to go is worse than one that tells
         * you where to go.
         */
        label: session.note === null ? 'Add a note' : 'Edit the note',
        disabled: !this.actions.canEditNote(),
        hint: this.actions.canEditNote()
          ? 'What this session is for, shown on its card'
          : 'Switch to the card view first: a note is edited on the card',
        run: () => {
          this.actions.onEditNote(session.id);
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
    this.zoomed = null;
    this.applyLayout(splitGroup(this.layout.groups, from, terminalId), this.afterSplit(direction));
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
    const panes = this.visiblePanes();
    const zoomed = this.zoomedIndex() !== null;
    panes.forEach(({ group, index }, position) => {
      const strip = this.strips[position];
      if (strip === undefined) {
        return;
      }
      clearChildren(strip);
      strip.classList.toggle('terminal__strip--focused', index === this.focused);
      this.paintStripProject(strip, group.active);

      const tabs = createElement('div', { className: 'terminal__tabs' });
      for (const id of group.tabs) {
        const session = this.sessions.find((entry) => entry.id === id);
        if (session !== undefined) {
          tabs.append(this.buildTab(session, group, index));
        }
      }
      tabs.append(this.buildNewTabButton(index));
      strip.append(tabs);

      const actions = createElement('div', { className: 'terminal__strip-actions' });

      /*
       * Widest scope first: the surface controls, then this pane's zoom, then `Clear`, which acts on
       * the active tab alone. Reading a cluster of icons is guesswork unless something orders it, and
       * "how much does this affect" is the only ordering these three share.
       *
       * `prepend` MOVES the element, listeners and all. `clearChildren` above detached it from the
       * strip it was in a moment ago, which is why this runs on every repaint rather than once.
       */
      if (position === 0 && this.surfaceControls !== null) {
        actions.append(this.surfaceControls);
      }

      // Offered only when there is something to hide: with one pane the button would toggle a state
      // nothing on screen distinguishes from the other.
      if (this.layout.groups.length > 1) {
        const zoom = createElement('button', { className: 'icon-button terminal__strip-zoom' });
        zoom.type = 'button';
        zoom.title = zoomed
          ? 'Back to the grid (Alt+Shift+Z)'
          : 'Blow this pane up to the whole surface (Alt+Shift+Z)';
        zoom.setAttribute('aria-label', zoomed ? 'Back to the grid' : 'Blow this pane up');
        zoom.setAttribute('aria-pressed', String(zoomed));
        zoom.append(zoomed ? shrinkIcon() : growIcon());
        zoom.addEventListener('click', (event) => {
          event.stopPropagation();
          this.focused = index;
          this.toggleZoom();
        });
        actions.append(zoom);
      }

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
      actions.append(clear);
      strip.append(actions);
    });

    // No pane took them, which happens for the frame between the last tab closing and the default
    // shell opening. Left detached they would simply vanish, so they go back where they were declared.
    if (panes.length === 0 && this.surfaceControls !== null && this.surfaceControlsHome !== null) {
      this.surfaceControlsHome.append(this.surfaceControls);
    }
  }

  /**
   * Gives a strip the colour and the tags of the project its visible tab belongs to.
   *
   * Two readings of one fact, at two distances. The **border** under the strip is the first tag's
   * colour, and it is what tells one cell from another across the window, where a 7px dot is a
   * smudge. The **dots** beside the tabs are the complete list, named in their tooltip, and they are
   * the same element the pull request, Git and worktree rows draw, so a repository is the same
   * colour everywhere in the app.
   *
   * A free shell belongs to no project and gets neither, which is itself the useful statement.
   */
  private paintStripProject(strip: HTMLElement, activeId: TerminalId): void {
    for (const color of TAG_COLORS) {
      strip.classList.remove(`tag--${color}`);
    }
    const session = this.sessions.find((entry) => entry.id === activeId);
    const projectId = session?.projectId ?? null;
    if (projectId === null) {
      return;
    }
    const color = primaryTagColor(this.palette, projectId);
    if (color !== null) {
      strip.classList.add(`tag--${color}`);
    }
    const dots = buildTagDots(this.palette, projectId);
    if (dots !== null) {
      strip.append(dots);
    }
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
      this.openSessionMenu(session, event.clientX, event.clientY);
    });

    if (this.renaming === session.id) {
      wrapper.append(this.buildRenameInput(session));
    } else {
      /*
       * A note reaches the grid as a tooltip and nothing more.
       *
       * The board draws it; here there is no room, and a second rendering of the same sentence in a
       * strip this dense would push the titles out. The tooltip is free and it is where a reader
       * already looks when a tab title is not enough, which is exactly the case a note answers.
       */
      const label = createElement('button', {
        className: 'terminal__tab-label',
        text: session.title,
        // The working directory is the one thing you always want to know about a shell tab.
        title:
          (session.note === null ? '' : `${session.note.text}\n\n`) +
          `${session.cwd}\n(double-click to rename, drag to reorder or change pane)`,
      });
      if (session.note !== null) {
        label.classList.add('terminal__tab-label--noted');
      }
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
  private attachStripDrop(strip: HTMLElement, position: number): void {
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
      // Resolved at drop time and not at bind time: a strip is reused across renders and, while a
      // pane is zoomed, the strip at position 0 is not group 0.
      this.commitMove(moved, this.stripOwner[position] ?? position, null);
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
    this.actions.onLayout(moveTab(this.layout.groups, moved, toGroup, before), this.layout.columns);
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
   *
   * The caret's list goes through `showContextMenu` and is **not** a menu of its own, which it was
   * until 2026-09-11. As a `position: absolute` element it lived inside the strip, and the strip is a
   * grid cell of `.terminal__surface`, which is `overflow: hidden`. Opening upwards put it outside
   * that box, so it was clipped and read as "hidden behind the projects table". No `z-index` could
   * have fixed that: overflow clipping is not something stacking escapes. Flipping it downwards would
   * have fixed this instance and left the same trap for the next short pane. The shared menu is
   * `position: fixed` on `document.body`, so no ancestor can clip it, it folds back inside the window
   * near an edge, and it brings the dismissal rules this file had already reimplemented once,
   * including the opening-click trap that shipped broken twice.
   */
  /**
   * What a pane offers to start: an agent in one click, a terminal through the chevron.
   *
   * A `+` and a chevron once, then three buttons, now two. The `+` had to go because it said "one
   * more of whatever this is", which stopped being true the moment a tab could be a coding agent
   * that writes to the repository. The plain terminal button went next, on the grounds that opening
   * a shell is the thing you do while choosing which shell anyway: the chevron was already there and
   * the extra click buys a menu that names what it opens.
   *
   * Which leaves one bare icon, the agent, and that asymmetry is deliberate. Starting an agent is
   * the act worth one click; starting a shell is the act worth reading a list first.
   */
  private buildNewTabButton(groupIndex: number): HTMLElement {
    const group = createElement('span', { className: 'terminal__new' });

    const agent = createElement('button', { className: 'terminal__new-button' });
    agent.type = 'button';
    agent.title = 'Start the configured coding agent, in the workspace root';
    agent.setAttribute('aria-label', 'Start the coding agent');
    agent.append(createIcon(AGENT_ICON, { paint: 'stroke' }));
    agent.addEventListener('click', (event) => {
      event.stopPropagation();
      this.focused = groupIndex;
      this.actions.onNewAgent();
    });
    group.append(agent);

    /*
     * The chevron is now the ONLY way to open a terminal, so it is always drawn.
     *
     * It used to appear only with more than one profile, which was right while a plain terminal
     * button sat beside it. Keeping that condition after removing the button would leave a machine
     * with a single shell profile unable to open a shell at all.
     */
    const caret = createElement('button', { className: 'terminal__new-caret' });
    caret.type = 'button';
    caret.append(terminalIcon());
    // A drawn chevron rather than the `⌄` character: as text it renders at whatever size and
    // baseline the font decides, which is why it looked like a stray mark next to the `+`.
    caret.append(chevronDown());
    caret.title = 'New terminal in this pane';
    caret.setAttribute('aria-label', 'New terminal');
    caret.addEventListener('click', (event) => {
      event.stopPropagation();
      const box = caret.getBoundingClientRect();
      const fallback = this.defaultProfile();
      showContextMenu(
        box.left,
        box.bottom + 4,
        this.profiles.map((profile) => ({
          // The default is marked rather than repeated as its own entry: a list holding both
          // "Default" and "Git Bash" for one shell is a list where picking either does the same
          // thing and the reader has to work out that it does.
          label: profile.id === fallback?.id ? `${profile.label} (default)` : profile.label,
          hint: profile.file,
          run: () => {
            this.focused = groupIndex;
            this.actions.onNewShell(profile.id);
          },
        })),
      );
    });
    group.append(caret);

    return group;
  }

  /**
   * The shell the plain terminal button opens.
   *
   * The first profile, which is what the `+` used before and what `resolveDefaultProfile` lands on in
   * the main process when nothing is pinned. Held in one place so the button and the mark in the menu
   * cannot disagree about which one is the default.
   */
  private defaultProfile(): ShellProfile | undefined {
    return this.profiles[0];
  }
}

/* ------------------------------------------------------------------ *
 * Grid arithmetic
 *
 * A pane occupies two cells: its tab strip and its terminal view, the strip directly above.
 *
 * The two axes are **not symmetrical**, and that is the whole reason these are named functions
 * rather than inline sums. A column is one `fr` track with a divider track after it, so the pattern
 * repeats every 2 lines. A row is two tracks, `auto` for the strip and `fr` for the view, plus its
 * divider, so it repeats every 3. Getting one wrong draws a pane on top of another, which on screen
 * looks exactly like a pane that failed to open, with nothing in the console.
 * ------------------------------------------------------------------ */

/** Grid line where the panes of column `column` start. */
export function paneColumnLine(column: number): number {
  return column * 2 + 1;
}

/** Grid line of the divider between column `gap` and the one after it. */
export function columnSplitterLine(gap: number): number {
  return gap * 2 + 2;
}

/** Grid line of the tab strips of row `row`. */
export function stripRowLine(row: number): number {
  return row * 3 + 1;
}

/** Grid line of the terminal views of row `row`, directly under their strips. */
export function viewRowLine(row: number): number {
  return row * 3 + 2;
}

/** Grid line of the divider between row `gap` and the one after it. */
export function rowSplitterLine(gap: number): number {
  return gap * 3 + 3;
}
