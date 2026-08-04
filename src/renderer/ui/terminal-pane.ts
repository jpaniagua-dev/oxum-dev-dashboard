import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  TERMINAL_FONT_SIZE,
  type PaneDirection,
  type ResolvedTheme,
  type ShellProfile,
  type TerminalId,
  type TerminalLayout,
  type TerminalSession,
} from '@shared/contracts.js';
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
 * Layout arithmetic
 *
 * Pure and exported: every gesture on the panes is "the same list, differently", so the interesting
 * part is list surgery and it deserves tests rather than trust. The one rule they all share is that the
 * result is never empty, because an empty layout is a blank surface with no way back.
 * ------------------------------------------------------------------ */

/** Inserts a pane right after another, or at the end when that other one is not there. */
export function insertPane(
  panes: readonly TerminalId[],
  added: TerminalId,
  after: TerminalId | null,
): TerminalId[] {
  if (panes.includes(added)) {
    return [...panes];
  }
  const index = after === null ? -1 : panes.indexOf(after);
  if (index === -1) {
    return [...panes, added];
  }
  return [...panes.slice(0, index + 1), added, ...panes.slice(index + 1)];
}

/** Removes a pane from the view. Refuses to empty the layout. */
export function removePane(panes: readonly TerminalId[], id: TerminalId): TerminalId[] {
  const next = panes.filter((pane) => pane !== id);
  return next.length > 0 ? next : [...panes];
}

/**
 * Shows a session in the place of another.
 *
 * What clicking a tab does when that session is not on screen: the focused pane becomes it. Replacing
 * rather than collapsing to a single pane is what lets a split survive browsing through the tabs.
 */
export function replacePane(
  panes: readonly TerminalId[],
  replaced: TerminalId | null,
  id: TerminalId,
): TerminalId[] {
  if (panes.includes(id)) {
    return [...panes];
  }
  const index = replaced === null ? -1 : panes.indexOf(replaced);
  if (index === -1) {
    return panes.length === 0 ? [id] : [...panes.slice(0, -1), id];
  }
  return panes.map((pane, at) => (at === index ? id : pane));
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
  /** Open a new shell tab from a profile. */
  onNewShell: (profileId: string) => void;
  /** New tab order after a drag, in display order. */
  onReorder: (orderedIds: TerminalId[]) => void;
  /** New set of visible panes and their direction. */
  onLayout: (panes: TerminalId[], direction: PaneDirection) => void;
  /**
   * Open a new shell in a directory, for a split.
   *
   * The pane resolves nothing itself: it hands over the working directory of the pane being split and
   * the caller decides which profile that means.
   */
  onSplitShell: (cwd: string, direction: PaneDirection) => void;
}

/** Which side of a tab a drop lands on. */
type DropSide = 'before' | 'after';

/**
 * The order a drop produces.
 *
 * Pure and exported so the arithmetic is tested rather than eyeballed: the moved id has to be removed
 * *before* the target index is read, otherwise dragging a tab to the right lands one position short.
 */
export function reorderIds(
  order: readonly TerminalId[],
  moved: TerminalId,
  target: TerminalId,
  side: DropSide,
): TerminalId[] {
  if (moved === target) {
    return [...order];
  }
  const without = order.filter((id) => id !== moved);
  const index = without.indexOf(target);
  if (index === -1) {
    return [...order];
  }
  const at = side === 'before' ? index : index + 1;
  return [...without.slice(0, at), moved, ...without.slice(at)];
}

interface View {
  readonly term: Terminal;
  readonly fit: FitAddon;
  readonly element: HTMLElement;
}

/**
 * The terminal pane: project output and free-form shells in one tab strip.
 *
 * **Each terminal gets its own permanent container and is opened exactly once.** xterm's `open()`
 * early-returns when the terminal already has an element, so detaching that element and re-opening
 * leaves the terminal alive in memory but invisible forever: it believes it is attached while the
 * pane stays blank. Switching tabs therefore toggles visibility and never touches the DOM tree.
 */
export class TerminalPane {
  private readonly views = new Map<TerminalId, View>();
  private sessions: readonly TerminalSession[] = [];
  private profiles: readonly ShellProfile[] = [];
  private active: TerminalId | null = null;
  private theme: ResolvedTheme = 'light';
  /** Overwritten from the settings as soon as the bootstrap lands; this is only the pre-bootstrap value. */
  private fontSize: number = TERMINAL_FONT_SIZE.default;
  private menuOpen = false;
  /** Id of the tab currently being renamed in place, if any. */
  private renaming: TerminalId | null = null;
  /** Tab being dragged, if any. Held so a drop knows what to move. */
  private dragging: TerminalId | null = null;
  /** Visible panes, mirroring what the main process holds. */
  private layout: TerminalLayout = { direction: 'columns', panes: [] };
  /**
   * Relative size of each pane, one entry per pane.
   *
   * Renderer-only, unlike the layout itself: it is a pixel preference rather than user intent, and
   * resetting it when the number of panes changes is what keeps the arithmetic simple.
   */
  private sizes: number[] = [];
  /** Splitters between panes, reused across renders rather than rebuilt. */
  private readonly splitters: HTMLElement[] = [];
  private contextMenu: HTMLElement | null = null;

  constructor(
    private readonly tabsHost: HTMLElement,
    private readonly surface: HTMLElement,
    private readonly actions: TerminalPaneActions,
  ) {
    window.addEventListener('resize', () => this.fitVisible());
    // Any click outside closes the profile menu, which is what every menu in every app does.
    document.addEventListener('click', () => {
      this.closeContextMenu();
      if (this.menuOpen) {
        this.menuOpen = false;
        this.renderTabs();
      }
    });
    // A context menu that survived a scroll or a resize would point at the wrong pane.
    window.addEventListener('blur', () => this.closeContextMenu());
  }

  /** Adopts the layout the main process reports. */
  setLayout(layout: TerminalLayout): void {
    const panes = layout.panes.filter((id) => this.sessions.some((session) => session.id === id));
    const changedCount = panes.length !== this.layout.panes.length;
    this.layout = { direction: layout.direction, panes };
    if (changedCount || this.sizes.length !== panes.length) {
      // Equal shares on every change of count: keeping old fractions would make a new pane inherit a
      // width that meant something for a different number of panes.
      this.sizes = panes.map(() => 1);
    }
    for (const id of panes) {
      this.ensure(id);
    }
    if (this.active === null || !panes.includes(this.active)) {
      this.active = panes[panes.length - 1] ?? null;
    }
    this.renderSurface();
    this.renderTabs();
  }

  setTheme(theme: ResolvedTheme): void {
    this.theme = theme;
    for (const view of this.views.values()) {
      view.term.options.theme = THEMES[theme];
    }
  }

  setProfiles(profiles: readonly ShellProfile[]): void {
    this.profiles = profiles;
    this.renderTabs();
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
    this.fitActive();
  }

  get activeId(): TerminalId | null {
    return this.active;
  }

  /**
   * Reconciles the tab strip with the sessions the main process reports.
   *
   * Views for sessions that disappeared are disposed here: a closed tab must free its xterm, or the
   * pane leaks a renderer per closed terminal.
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

    // A dead session cannot hold a pane. The main process says the same thing a moment later, but
    // waiting for it would leave a hole on the surface in the meantime.
    const panes = this.layout.panes.filter((id) => live.has(id));
    if (panes.length !== this.layout.panes.length) {
      this.layout = { ...this.layout, panes };
      this.sizes = panes.map(() => 1);
    }
    if (this.active !== null && !live.has(this.active)) {
      this.active = null;
    }
    if (this.active === null) {
      this.active = panes[panes.length - 1] ?? null;
    }
    this.renderSurface();
    this.renderTabs();
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

  clearActive(): void {
    if (this.active !== null) {
      this.views.get(this.active)?.term.clear();
    }
  }

  /**
   * Brings a session to the foreground.
   *
   * When it is already on screen this only moves the keyboard focus. When it is not, it takes the place
   * of the focused pane rather than collapsing the split: browsing the tabs must not undo a layout the
   * user built. One rule, and it holds for a click on a tab as much as for a freshly launched action.
   */
  select(terminalId: TerminalId): void {
    this.ensure(terminalId);
    if (!this.layout.panes.includes(terminalId)) {
      this.applyLayout(replacePane(this.layout.panes, this.active, terminalId), this.layout.direction);
    }
    this.active = terminalId;
    this.renderSurface();
    this.views.get(terminalId)?.term.focus();
    this.renderTabs();
  }

  /** Adds a session as a new pane beside the focused one, which is what a split does. */
  addPane(terminalId: TerminalId, direction: PaneDirection): void {
    this.ensure(terminalId);
    this.applyLayout(insertPane(this.layout.panes, terminalId, this.active), direction);
    this.active = terminalId;
    this.renderSurface();
    this.views.get(terminalId)?.term.focus();
    this.renderTabs();
  }

  /** Re-fits every visible terminal, needed after the pane is shown or resized. */
  refit(): void {
    this.fitVisible();
  }

  /**
   * Applies a layout locally and reports it.
   *
   * Applied at once rather than waiting for the round trip, because these all follow a click and a
   * click has to feel immediate. The main process is still the authority: its push arrives moments
   * later with the same value, or with a corrected one if a session died in between.
   */
  private applyLayout(panes: TerminalId[], direction: PaneDirection): void {
    if (this.sizes.length !== panes.length) {
      this.sizes = panes.map(() => 1);
    }
    this.layout = { direction, panes };
    this.actions.onLayout(panes, direction);
  }

  private ensure(terminalId: TerminalId): View {
    const existing = this.views.get(terminalId);
    if (existing !== undefined) {
      return existing;
    }

    // A dedicated, permanent container: `open()` is called on it once and never again.
    const element = createElement('div', { className: 'terminal__view' });
    element.hidden = terminalId !== this.active;
    this.surface.append(element);

    const term = new Terminal({
      fontFamily: "'Cascadia Code', Consolas, monospace",
      fontSize: this.fontSize,
      scrollback: 5000,
      cursorBlink: true,
      convertEol: true,
      theme: THEMES[this.theme],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.onData((data) => this.actions.onInput(terminalId, data));
    term.open(element);

    // Clicking a pane focuses it. Capture phase, because xterm swallows the event on its own surface.
    element.addEventListener(
      'mousedown',
      () => {
        if (this.active !== terminalId) {
          this.active = terminalId;
          this.renderSurface();
          this.renderTabs();
        }
      },
      true,
    );
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.openPaneMenu(terminalId, event.clientX, event.clientY);
    });

    const view = { term, fit, element };
    this.views.set(terminalId, view);
    return view;
  }

  /**
   * Lays the visible panes out on the surface.
   *
   * **No terminal is ever moved in the DOM.** Each keeps the permanent container it was opened on, and
   * ordering is done with the CSS `order` property: a grid honours it, and detaching an xterm element
   * to reorder it would leave the terminal alive but blank forever. Splitters are interleaved on the
   * odd orders.
   */
  private renderSurface(): void {
    const { panes, direction } = this.layout;

    for (const [id, view] of this.views) {
      const index = panes.indexOf(id);
      view.element.hidden = index === -1;
      view.element.style.order = String(index * 2);
      view.element.classList.toggle('terminal__view--focused', panes.length > 1 && id === this.active);
    }

    const tracks: string[] = [];
    panes.forEach((_id, index) => {
      if (index > 0) {
        tracks.push('var(--pane-splitter)');
      }
      tracks.push(`${this.sizes[index] ?? 1}fr`);
    });

    const template = tracks.join(' ');
    this.surface.classList.toggle('terminal__surface--split', panes.length > 1);
    if (direction === 'columns') {
      this.surface.style.gridTemplateColumns = template;
      this.surface.style.gridTemplateRows = '1fr';
    } else {
      this.surface.style.gridTemplateRows = template;
      this.surface.style.gridTemplateColumns = '1fr';
    }

    this.syncSplitters(panes.length, direction);
    this.fitVisible();
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
      // Sits between pane `index` and pane `index + 1`.
      splitter.style.order = String(index * 2 + 1);
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

  /**
   * Refits every visible pane.
   *
   * All of them, not just the focused one: with a split, each pane has its own geometry and each pty
   * needs to be told about it, or the ones in the background wrap their output at the wrong width.
   */
  private fitVisible(): void {
    for (const id of this.layout.panes) {
      const view = this.views.get(id);
      if (view === undefined) {
        continue;
      }
      try {
        view.fit.fit();
        this.actions.onResize(id, view.term.cols, view.term.rows);
      } catch {
        // Fitting fails while the pane is hidden and has no size; harmless.
      }
    }
  }

  /* --------------------------------------------------------- context menus */

  /**
   * The menu on a pane: splitting, and unsplitting.
   *
   * A split opens a **new shell in that pane's own directory**, the way Windows Terminal duplicates the
   * profile you split from: splitting a repository shell to get a second one in the same repository is
   * the whole point, and re-running the pane's command instead would be surprising for a dev server.
   *
   * Closing a pane only takes it off the surface: its process keeps running and its tab stays. Killing
   * a terminal remains the cross on its tab, so one stray click in a menu cannot take down a build.
   */
  private openPaneMenu(terminalId: TerminalId, x: number, y: number): void {
    const session = this.sessions.find((entry) => entry.id === terminalId);
    if (session === undefined) {
      return;
    }
    const { panes, direction } = this.layout;

    this.showMenu(x, y, [
      {
        label: 'Diviser à droite',
        run: () => this.actions.onSplitShell(session.cwd, 'columns'),
      },
      {
        label: 'Diviser en bas',
        run: () => this.actions.onSplitShell(session.cwd, 'rows'),
      },
      {
        label: 'Fermer ce panneau',
        // Nothing to close when it is the only one, and the terminal itself must not die here.
        disabled: panes.length <= 1,
        hint: 'Le terminal continue de tourner, son onglet reste',
        run: () => {
          const next = removePane(panes, terminalId);
          this.applyLayout(next, direction);
          if (this.active === terminalId) {
            this.active = next[next.length - 1] ?? null;
          }
          this.renderSurface();
          this.renderTabs();
        },
      },
      {
        label: 'Réunir en un seul panneau',
        disabled: panes.length <= 1,
        run: () => {
          this.applyLayout([terminalId], direction);
          this.active = terminalId;
          this.renderSurface();
          this.renderTabs();
        },
      },
    ]);
  }

  /** The menu on a tab: putting that session on screen beside the others, renaming, closing. */
  private openTabMenu(session: TerminalSession, x: number, y: number): void {
    const visible = this.layout.panes.includes(session.id);

    this.showMenu(x, y, [
      {
        label: 'Afficher à droite',
        disabled: visible,
        run: () => this.showBeside(session.id, 'columns'),
      },
      {
        label: 'Afficher en bas',
        disabled: visible,
        run: () => this.showBeside(session.id, 'rows'),
      },
      {
        label: 'Renommer',
        run: () => {
          this.renaming = session.id;
          this.renderTabs();
        },
      },
      {
        label: 'Fermer l’onglet',
        disabled: !session.closable,
        run: () => this.actions.onClose(session.id),
      },
    ]);
  }

  /** Puts an existing session on screen next to the focused pane. */
  private showBeside(terminalId: TerminalId, direction: PaneDirection): void {
    this.ensure(terminalId);
    this.applyLayout(insertPane(this.layout.panes, terminalId, this.active), direction);
    this.active = terminalId;
    this.renderSurface();
    this.views.get(terminalId)?.term.focus();
    this.renderTabs();
  }

  private showMenu(
    x: number,
    y: number,
    items: readonly { label: string; run: () => void; disabled?: boolean; hint?: string }[],
  ): void {
    this.closeContextMenu();
    const menu = createElement('div', { className: 'context-menu' });

    for (const item of items) {
      const button = createElement('button', { className: 'context-menu__item', text: item.label });
      button.type = 'button';
      button.disabled = item.disabled === true;
      if (item.hint !== undefined) {
        button.title = item.hint;
      }
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.closeContextMenu();
        item.run();
      });
      menu.append(button);
    }

    // Positioned after being measured, so a menu opened near an edge folds back inside the window
    // instead of being cut off.
    menu.style.left = '0px';
    menu.style.top = '0px';
    document.body.append(menu);
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - box.width - 4)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - box.height - 4)}px`;
    this.contextMenu = menu;
  }

  private closeContextMenu(): void {
    this.contextMenu?.remove();
    this.contextMenu = null;
  }

  /* ------------------------------------------------------------------ tabs */

  private renderTabs(): void {
    clearChildren(this.tabsHost);

    for (const session of this.sessions) {
      this.tabsHost.append(this.buildTab(session));
    }
    this.tabsHost.append(this.buildNewTabButton());
  }

  private buildTab(session: TerminalSession): HTMLElement {
    const wrapper = createElement('span', {
      className: `terminal__tab${session.id === this.active ? ' terminal__tab--active' : ''}`,
    });
    wrapper.dataset.terminalId = session.id;

    if (this.renaming === session.id) {
      wrapper.append(this.buildRenameInput(session));
    } else {
      const label = createElement('button', {
        className: 'terminal__tab-label',
        text: session.title,
        // The working directory is the one thing you always want to know about a shell tab.
        title: `${session.cwd}\n(double-clic pour renommer, glisser pour réordonner)`,
      });
      label.type = 'button';
      label.setAttribute('aria-selected', String(session.id === this.active));
      label.addEventListener('click', () => this.select(session.id));
      // Double-click to rename in place, the convention every tabbed app already trained the user on.
      label.addEventListener('dblclick', (event) => {
        event.preventDefault();
        this.renaming = session.id;
        this.renderTabs();
      });
      wrapper.append(label);

      // Draggable only outside a rename: while the input is up, a drag would fight text selection in
      // the field. Both the wrapper and the label carry the flag, because the grab almost always starts
      // on the label and a `<button>` is not draggable on its own.
      wrapper.draggable = true;
      label.draggable = true;
      this.attachDragHandlers(wrapper, session.id);
    }

    // A dot marks a live process, so a finished tab is visibly inert rather than looking active.
    if (session.running) {
      wrapper.append(createElement('span', { className: 'terminal__tab-dot' }));
    }

    if (session.closable) {
      const close = createElement('button', { className: 'terminal__tab-close', text: '×' });
      close.type = 'button';
      close.title = 'Fermer cet onglet';
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        this.actions.onClose(session.id);
      });
      wrapper.append(close);
    }

    return wrapper;
  }

  /**
   * Drag and drop for one tab.
   *
   * **Nothing re-renders during a drag.** Replacing the dragged element mid-gesture cancels the drag in
   * Chromium, so the drop marker is toggled as a class on the live nodes and the strip is only rebuilt
   * once the main process reports the new order. That is also what makes the result authoritative
   * rather than optimistic: the order shown is always the order the main process holds.
   */
  private attachDragHandlers(wrapper: HTMLElement, id: TerminalId): void {
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
      const side = this.sideOf(wrapper, event.clientX);
      this.endDrag();
      this.actions.onReorder(
        reorderIds(
          this.sessions.map((session) => session.id),
          moved,
          id,
          side,
        ),
      );
    });

    // Covers a drag released outside the strip or cancelled with Escape: the markers must not survive.
    wrapper.addEventListener('dragend', () => this.endDrag());
  }

  /** Left half means "insert before", right half "insert after". */
  private sideOf(wrapper: HTMLElement, clientX: number): DropSide {
    const box = wrapper.getBoundingClientRect();
    return clientX < box.left + box.width / 2 ? 'before' : 'after';
  }

  private markDropTarget(wrapper: HTMLElement, side: DropSide): void {
    for (const child of this.tabsHost.children) {
      child.classList.remove('terminal__tab--drop-before', 'terminal__tab--drop-after');
    }
    wrapper.classList.add(`terminal__tab--drop-${side}`);
  }

  private endDrag(): void {
    this.dragging = null;
    for (const child of this.tabsHost.children) {
      child.classList.remove(
        'terminal__tab--dragging',
        'terminal__tab--drop-before',
        'terminal__tab--drop-after',
      );
    }
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
    input.setAttribute('aria-label', 'Renommer cet onglet');

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
      this.renderTabs();
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

    // Focus after the element is in the DOM, and preselect so typing replaces the old name.
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    return input;
  }

  /**
   * The new-tab control: a click opens the default profile, the caret lists the others.
   *
   * Same split as Windows Terminal, because that is the gesture already in the user's hands.
   */
  private buildNewTabButton(): HTMLElement {
    const group = createElement('span', { className: 'terminal__new' });

    const add = createElement('button', { className: 'terminal__new-button', text: '+' });
    add.type = 'button';
    add.title = 'Nouvel onglet';
    add.addEventListener('click', (event) => {
      event.stopPropagation();
      const first = this.profiles[0];
      if (first !== undefined) {
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
      caret.title = 'Choisir un shell';
      caret.setAttribute('aria-label', 'Choisir un shell');
      caret.addEventListener('click', (event) => {
        event.stopPropagation();
        this.menuOpen = !this.menuOpen;
        this.renderTabs();
      });
      group.append(caret);
    }

    if (this.menuOpen) {
      group.append(this.buildProfileMenu());
    }

    return group;
  }

  private buildProfileMenu(): HTMLElement {
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
        this.menuOpen = false;
        this.actions.onNewShell(profile.id);
      });
      menu.append(item);
    }
    return menu;
  }
}
