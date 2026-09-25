import type { ProjectRow, ShellProfile, TerminalId, TerminalSession } from '@shared/contracts.js';
import { showContextMenu } from './context-menu.js';
import { clearChildren, createElement, createIcon } from './dom.js';
import { buildPill } from './project-table.js';
import { presentServer } from './presenters.js';

/**
 * The sessions as cards on a canvas, instead of as terminals in a grid.
 *
 * The other half of the terminal surface, and a different question. The grid answers "what is this
 * session saying"; the board answers "what have I got running, and which one needs me", which the
 * grid answers badly past four panes and not at all for a session whose pane is not on screen.
 *
 * **No terminal is drawn here, and none is moved.** Board mode hides the grid's host wholesale, so
 * every xterm keeps the element it was opened on, untouched and still collecting output. That is the
 * one invariant this surface has, and a board that embedded live terminals would break it on the
 * first drag.
 */

/** How lively a session is, as far as its output can say. */
export type SessionActivity = 'working' | 'quiet' | 'exited';

/**
 * Silence after which a live session is called quiet.
 *
 * Two and a half seconds, and the number is a compromise rather than a measurement. Claude Code goes
 * quiet for a beat between a tool result and its next sentence, so a shorter window makes a working
 * session flicker; much longer and a session that has been waiting for you still claims to be busy.
 */
export const QUIET_AFTER_MS = 2500;

/**
 * What a session's output says it is doing.
 *
 * **Derived from timing and not from reading the output**, which is the decision worth recording.
 * Matching strings would let this say "waiting for your answer" instead of merely "quiet", and it
 * would be wrong the first time Claude Code reworded a prompt or a program printed something that
 * looked like one. Bytes arriving is a fact about any process whatsoever.
 *
 * What it therefore cannot do is tell a session waiting for an answer from one that has finished and
 * is sitting at its prompt. Both are quiet. That distinction needs a signal from the program itself,
 * which on Claude Code means its hooks, and that is a separate piece of plumbing.
 *
 * A session that has never been heard from reads quiet rather than working: at boot the renderer
 * adopts sessions it has not seen a byte of, and "busy" would be a claim made about nothing.
 */
export function activityOf(
  running: boolean,
  lastOutputAt: number | undefined,
  now: number,
): SessionActivity {
  if (!running) {
    return 'exited';
  }
  if (lastOutputAt === undefined) {
    return 'quiet';
  }
  return now - lastOutputAt < QUIET_AFTER_MS ? 'working' : 'quiet';
}

/** The word on the card, and the class that colours its dot. */
export function describeActivity(activity: SessionActivity): string {
  switch (activity) {
    case 'working':
      return 'working';
    case 'quiet':
      return 'quiet';
    case 'exited':
      return 'exited';
  }
}

/** A card's position on the canvas, in canvas units (before pan and zoom). */
export interface CardPoint {
  readonly x: number;
  readonly y: number;
}

export const CARD_WIDTH = 240;
const CARD_GAP = 20;
const CARD_HEIGHT = 112;
const COLUMNS = 3;
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 1.6;

/**
 * Where a card with no remembered position goes.
 *
 * A grid by index rather than a free scatter, so a fresh board is readable before anything has been
 * dragged and two new sessions never land on top of each other. Once dragged, a card keeps what it
 * was given; this only answers the first frame.
 */
export function defaultPoint(index: number): CardPoint {
  return {
    x: CARD_GAP + (index % COLUMNS) * (CARD_WIDTH + CARD_GAP),
    y: CARD_GAP + Math.floor(index / COLUMNS) * (CARD_HEIGHT + CARD_GAP),
  };
}

/** Keeps a zoom inside the range the buttons offer, wherever it came from. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) {
    return 1;
  }
  return Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX);
}

export interface TerminalBoardActions {
  /** Shows this session in the grid, which is what a click on a card means. */
  onOpen: (terminalId: TerminalId) => void;
  /** Ends the session. Only offered when the tab itself could be closed. */
  onClose: (terminalId: TerminalId) => void;
  /** Right-click, so a card offers what its tab offers. */
  onMenu: (session: TerminalSession, x: number, y: number) => void;
  /**
   * Opens a new shell, without leaving the board.
   *
   * The board was a dead end without it: the `+` that starts a session lives in a pane's tab strip,
   * and board mode hides every strip. Same callback the strip uses, so the two cannot drift on what
   * opening a shell means.
   */
  onNewShell: (profileId: string) => void;
}

/** What the board needs to know about the world, handed in on every render. */
export interface TerminalBoardState {
  readonly sessions: readonly TerminalSession[];
  /** Project rows, for the server phase of a session that runs one. */
  readonly rows: readonly ProjectRow[];
  /** When each session was last heard from, by id. Absent means never. */
  readonly lastOutputAt: ReadonlyMap<TerminalId, number>;
  /** The shells that can be started, for the `+` and its picker. */
  readonly profiles: readonly ShellProfile[];
}

/**
 * The board surface: a pannable, zoomable plane of cards.
 *
 * A class and not a render function, unlike the rest of this folder, for one reason: pan, zoom and
 * the dragged positions are state that must survive a repaint, and a repaint happens on every poll.
 * A function would have to be handed all of it and hand it all back, which is the same object with
 * more steps.
 */
export class TerminalBoard {
  /** Dragged positions, by session. Lost on reload, exactly like the sessions themselves. */
  private readonly points = new Map<TerminalId, CardPoint>();
  private pan: CardPoint = { x: 0, y: 0 };
  private zoom = 1;
  private state: TerminalBoardState = {
    sessions: [],
    rows: [],
    lastOutputAt: new Map(),
    profiles: [],
  };
  private readonly content: HTMLElement;
  private readonly toolbar: HTMLElement;
  /** The separator drawn before the surface controls, built once and relocated with them. */
  private readonly controlsRule: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  /** Set while the canvas itself is being dragged, so a click on the background does not open a card. */
  private panning = false;
  /** The chevron beside `+`. Hidden when there is only one shell to choose from. */
  private pickShell: HTMLElement | null = null;
  /**
   * Set while a card is being carried, and it is what stops the board repainting under the pointer.
   *
   * A repaint rebuilds every card, so the element being dragged is destroyed and the pointer capture
   * dies with it: the card stops following the mouse with the button still down, seconds into the
   * gesture and for no reason the user can see. The poll repaints, and so does the once-a-second
   * tick that ages `working` into `quiet`, which is why this bites here and not on a surface that
   * only redraws when something is clicked. Same invariant as the tab strip's: nothing re-renders
   * during a drag.
   */
  private carrying = false;
  /**
   * What the last paint drew, as a string.
   *
   * The tick asks for a repaint every second and almost always has nothing new to say. Rebuilding
   * the cards anyway throws away any text selection on them and makes a hovered card flicker once a
   * second, for no change at all.
   */
  private painted = '';

  constructor(
    private readonly host: HTMLElement,
    private readonly actions: TerminalBoardActions,
  ) {
    this.host.classList.add('board-canvas');
    const toolbar = createElement('div', { className: 'board-canvas__toolbar' });
    this.toolbar = toolbar;
    this.controlsRule = this.rule();
    this.zoomLabel = createElement('span', { className: 'board-canvas__zoom', text: '100%' });

    /*
     * Creating comes first, then the view controls, separated by a rule.
     *
     * `+` opens the first profile straight away and the chevron picks another, which is exactly the
     * pair the tab strip offers. Reading the profile list at click time rather than at construction
     * is what makes a profile added in the settings appear here without the board being rebuilt.
     */
    // A terminal with a prompt in it, and deliberately not a bare plus: the zoom-in button three
    // places along is already a plus, and two identical glyphs in one strip of six icons is a
    // toolbar you have to hover to read. This one also says WHAT gets created, which a plus cannot.
    const add = this.toolbarButton('New terminal', 'M2.5 3.5h11v9h-11zM5 6.6l1.7 1.4L5 9.4M8.6 9.8h3.2', () => {
      const first = this.state.profiles[0];
      if (first !== undefined) {
        this.actions.onNewShell(first.id);
      }
    });
    toolbar.append(add);

    const pick = this.toolbarButton('Choose a shell', 'M3.5 6l4.5 4.5L12.5 6', (event) => {
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
      showContextMenu(
        box.left,
        box.bottom + 4,
        this.state.profiles.map((profile) => ({
          label: profile.label,
          hint: profile.file,
          run: () => this.actions.onNewShell(profile.id),
        })),
      );
    });
    this.pickShell = pick;
    toolbar.append(pick);
    toolbar.append(this.rule());

    toolbar.append(
      this.toolbarButton('Zoom out', 'M3 8h10', () => this.setZoom(this.zoom - 0.1)),
      this.zoomLabel,
      this.toolbarButton('Zoom in', 'M8 3v10M3 8h10', () => this.setZoom(this.zoom + 0.1)),
      this.toolbarButton(
        'Recentre the board',
        'M8 3v10M3 8h10M4.5 4.5l7 7M11.5 4.5l-7 7',
        () => this.resetView(),
      ),
    );
    this.host.append(toolbar);

    this.content = createElement('div', { className: 'board-canvas__content' });
    this.host.append(this.content);

    this.attachPan();
  }

  /**
   * Takes in the surface-wide controls while the board is the surface on screen.
   *
   * The same element the tab strip holds the rest of the time, moved and never copied. It has to
   * follow: the toggle that leaves the board lives in it, and the strips are hidden here, so a board
   * without it is a room with no door. That is exactly what shipped when those controls moved from a
   * bar of their own into the first pane's strip.
   */
  adoptControls(element: HTMLElement): void {
    // The same rule element every time, never a fresh one: `append` MOVES a node that is already in
    // the document, so reusing it survives any number of toggles, while building one per call would
    // stack a separator on the toolbar each time the board is opened.
    this.toolbar.append(this.controlsRule, element);
  }

  /** Repaints from the state it is handed. Cheap enough to call on every poll. */
  render(state: TerminalBoardState): void {
    this.state = state;
    this.paint();
  }

  /** Repaints from the state it already has, which is how a card goes quiet as time passes. */
  refresh(): void {
    this.paint();
  }

  /**
   * What the cards would show right now, as a string.
   *
   * Everything a card draws and nothing else, so a repaint is skipped exactly when it would produce
   * the same pixels. The activity is in it, which is the point: that is the one field that changes
   * with the clock rather than with an event.
   */
  private signature(now: number): string {
    return this.state.sessions
      .map((session) => {
        const activity = activityOf(session.running, this.state.lastOutputAt.get(session.id), now);
        const project = this.state.rows.find((row) => row.project.id === session.projectId);
        const phase = session.role === 'server' ? (project?.server.phase ?? '') : '';
        const point = this.points.get(session.id);
        return [
          session.id,
          session.title,
          activity,
          String(session.closable),
          project?.project.label ?? '',
          phase,
          point === undefined ? '' : `${point.x},${point.y}`,
        ].join('\u0001');
      })
      .join('\u0002');
  }

  private paint(force = false): void {
    // Never under a pointer that is carrying a card: rebuilding it drops the capture mid-gesture.
    if (this.carrying) {
      return;
    }
    const now = Date.now();
    const next = this.signature(now);
    if (!force && next === this.painted) {
      return;
    }
    this.painted = next;

    clearChildren(this.content);
    this.applyTransform();
    // A chevron offering a choice of one is a control that cannot do anything, the same rule the tab
    // strip's own new-tab button follows.
    if (this.pickShell !== null) {
      this.pickShell.hidden = this.state.profiles.length <= 1;
    }

    if (this.state.sessions.length === 0) {
      this.content.append(
        createElement('p', {
          className: 'board-canvas__empty',
          text: 'No session running. Open a terminal and it appears here.',
        }),
      );
      return;
    }


    this.state.sessions.forEach((session, index) => {
      const point = this.points.get(session.id) ?? defaultPoint(index);
      this.content.append(this.buildCard(session, point, now));
    });
  }

  private buildCard(session: TerminalSession, point: CardPoint, now: number): HTMLElement {
    const activity = activityOf(session.running, this.state.lastOutputAt.get(session.id), now);
    const card = createElement('div', {
      className: `board-card board-card--${activity}`,
    });
    card.style.left = `${point.x}px`;
    card.style.top = `${point.y}px`;
    card.title = `${session.title}\n${session.cwd}\n(drag to move it, click to show it, right click to act)`;

    const head = createElement('div', { className: 'board-card__head' });
    head.append(createElement('span', { className: 'board-card__dot' }));
    head.append(createElement('span', { className: 'board-card__title', text: session.title }));
    card.append(head);

    card.append(
      createElement('span', {
        className: 'board-card__activity',
        text: describeActivity(activity),
      }),
    );

    const project = this.state.rows.find((row) => row.project.id === session.projectId);
    if (project !== undefined) {
      card.append(
        createElement('span', { className: 'board-card__project', text: project.project.label }),
      );
    }

    /*
     * The server phase, and it is the one real status this app already holds.
     *
     * Only for a session whose action is a server: a `task` or a shell shares its project's row but
     * has nothing to do with whatever `ng serve` is up to, and painting that row's phase on it would
     * be a card claiming something about a process it does not own.
     */
    if (session.role === 'server' && project !== undefined) {
      const phase = createElement('span', { className: 'board-card__phase' });
      phase.append(buildPill(presentServer(project.server)));
      card.append(phase);
    }

    const actions = createElement('div', { className: 'board-card__actions' });
    const open = createElement('button', { className: 'button button--quiet', text: 'Show' });
    open.type = 'button';
    open.title = 'Show this session in the terminal grid';
    open.addEventListener('click', (event) => {
      event.stopPropagation();
      this.actions.onOpen(session.id);
    });
    actions.append(open);

    if (session.closable) {
      const close = createElement('button', { className: 'button button--quiet', text: 'Close' });
      close.type = 'button';
      close.title = 'End this session';
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        this.actions.onClose(session.id);
      });
      actions.append(close);
    }
    card.append(actions);

    card.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.actions.onMenu(session, event.clientX, event.clientY);
    });
    this.attachCardDrag(card, session.id, point);
    return card;
  }

  /**
   * Dragging one card.
   *
   * Pointer events and not HTML5 drag and drop, unlike the tab strip and the Jira board: those two
   * move a thing **into** another thing, which is what a drop target is for, while this one is free
   * positioning and needs a delta on every frame. Pointer capture is what makes a fast drag survive
   * leaving the card.
   *
   * The threshold is why a card is still clickable: below it the gesture stays a click, so a card
   * nudged by two pixels opens instead of drifting.
   */
  private attachCardDrag(card: HTMLElement, id: TerminalId, from: CardPoint): void {
    const THRESHOLD = 4;
    let origin: CardPoint | null = null;
    let moved = false;

    card.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('button') !== null) {
        return;
      }
      origin = { x: event.clientX, y: event.clientY };
      moved = false;
      card.setPointerCapture(event.pointerId);
      // Stops the canvas underneath from panning at the same time.
      event.stopPropagation();
    });

    card.addEventListener('pointermove', (event) => {
      if (origin === null) {
        return;
      }
      const dx = event.clientX - origin.x;
      const dy = event.clientY - origin.y;
      if (!moved && Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) {
        return;
      }
      if (!moved) {
        moved = true;
        // Held from the first real movement rather than from the press, so a click never freezes the
        // board for the time it takes to release the button.
        this.carrying = true;
        card.classList.add('board-card--dragging');
      }
      // Divided by the zoom: a card has to follow the pointer on screen, and the canvas it lives on
      // is scaled, so screen pixels and canvas units are not the same length.
      this.points.set(id, { x: from.x + dx / this.zoom, y: from.y + dy / this.zoom });
      card.style.left = `${from.x + dx / this.zoom}px`;
      card.style.top = `${from.y + dy / this.zoom}px`;
    });

    const end = (event: PointerEvent): void => {
      if (origin === null) {
        return;
      }
      origin = null;
      this.carrying = false;
      card.classList.remove('board-card--dragging');
      if (card.hasPointerCapture(event.pointerId)) {
        card.releasePointerCapture(event.pointerId);
      }
      if (!moved) {
        this.actions.onOpen(id);
        return;
      }
      // Forced: the card was moved by writing to its style, so the signature of what is on screen
      // and the signature of what should be on screen have drifted. Also catches every change the
      // poll wanted to draw while the pointer was down.
      this.paint(true);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  /** Dragging the background moves the whole plane. */
  private attachPan(): void {
    let origin: CardPoint | null = null;
    let from: CardPoint = { x: 0, y: 0 };

    this.host.addEventListener('pointerdown', (event) => {
      /*
       * Never pan from a press that landed on a card or on the toolbar, and the card half of that is
       * not merely tidy: it is what makes the buttons on a card work at all.
       *
       * Capturing the pointer here **retargets the `pointerup` to this element**, so the browser
       * fires the `click` on the nearest common ancestor of the two, which is the plane and not the
       * button that was pressed. The button's listener then never runs, and "Show" looks inert while
       * everything about it is correctly wired. The card's own handler ignores presses on buttons, so
       * it cannot stop the propagation on their behalf either.
       */
      const target = event.target as HTMLElement;
      if (target.closest('.board-canvas__toolbar') !== null || target.closest('.board-card') !== null) {
        return;
      }
      origin = { x: event.clientX, y: event.clientY };
      from = this.pan;
      this.panning = false;
      this.host.setPointerCapture(event.pointerId);
    });

    this.host.addEventListener('pointermove', (event) => {
      if (origin === null) {
        return;
      }
      this.panning = true;
      this.pan = { x: from.x + (event.clientX - origin.x), y: from.y + (event.clientY - origin.y) };
      this.applyTransform();
    });

    const end = (event: PointerEvent): void => {
      origin = null;
      this.panning = false;
      if (this.host.hasPointerCapture(event.pointerId)) {
        this.host.releasePointerCapture(event.pointerId);
      }
    };
    this.host.addEventListener('pointerup', end);
    this.host.addEventListener('pointercancel', end);

    // Ctrl and the wheel, the gesture every canvas in every application already answers. A bare
    // wheel is left alone: it is how a trackpad scrolls, and hijacking it would make the board
    // impossible to leave alone.
    this.host.addEventListener(
      'wheel',
      (event) => {
        if (!event.ctrlKey) {
          return;
        }
        event.preventDefault();
        this.setZoom(this.zoom - Math.sign(event.deltaY) * 0.1);
      },
      { passive: false },
    );
  }

  private setZoom(next: number): void {
    this.zoom = clampZoom(Math.round(next * 100) / 100);
    this.applyTransform();
  }

  /**
   * Puts the plane back where it started.
   *
   * Pan and zoom only: the cards keep where they were put. A "recentre" that also tidied the cards
   * would be two gestures on one button, and the one nobody asked for is the destructive one.
   */
  private resetView(): void {
    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
    this.applyTransform();
  }

  private applyTransform(): void {
    this.content.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.host.classList.toggle('board-canvas--panning', this.panning);
  }

  /** The hairline between two groups of the toolbar. */
  private rule(): HTMLElement {
    return createElement('span', { className: 'board-canvas__rule' });
  }

  private toolbarButton(
    label: string,
    path: string,
    run: (event: MouseEvent) => void,
  ): HTMLElement {
    const button = createElement('button', { className: 'icon-button' });
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.append(createIcon(path, { paint: 'stroke' }));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      run(event);
    });
    return button;
  }
}
