import type { ProjectRow, ShellProfile, TerminalId, TerminalSession } from '@shared/contracts.js';
import { showContextMenu } from './context-menu.js';
import { clearChildren, createElement, createIcon } from './dom.js';
import { AGENT_ICON } from './icons.js';
import type { JobKind, JobRun } from '@shared/job-run.js';
import { describeElapsed } from '@shared/job-run.js';
import { NOTE_LIMIT, describeNoteAge } from '@shared/session-note.js';
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

/**
 * What a card is about: a terminal session, or a headless run that has no session.
 *
 * A `TerminalId` for the first, a `JobRun.id` for the second, and both are strings, so the map of
 * dragged positions needs no second home. The two namespaces cannot collide: a job id is minted by
 * `job-run.ts` with a `job:` prefix while a terminal id comes from the manager's own counter.
 */
export type CardId = string;

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
  /**
   * Opens the configured coding agent, without leaving the board.
   *
   * The board could start a shell and not an agent, which on a surface whose whole subject is
   * running agents was the wrong way round. Same callback the tab strip is given, so the two cannot
   * grow different ideas of what starting an agent means.
   */
  onNewAgent: () => void;
  /**
   * Shows the tab that owns a headless run, which is what a click on a job card means.
   *
   * Not `onOpen`: there is no session to show in the grid, and the run's own tab is the only place
   * its result will ever land. The board stays on screen, the strip above it changes.
   */
  onOpenJob: (kind: JobKind) => void;
  /**
   * Writes what a session is for, or clears it when the text is empty.
   *
   * The board is the only surface that edits a note, and that is a scope decision rather than an
   * oversight: a note is three lines, a tab strip is twenty-four pixels tall, and the grid already
   * shows the note as a tab tooltip. One editor, in the one place with room for it.
   */
  onNote: (terminalId: TerminalId, text: string) => void;
}

/** What the board needs to know about the world, handed in on every render. */
export interface TerminalBoardState {
  readonly sessions: readonly TerminalSession[];
  /**
   * The headless agent runs going right now, which have no session to be found under.
   *
   * They arrive already shaped by `job-run.ts` rather than as the two service states, so this
   * surface never learns what a sprint or a pull request review is. It draws a run.
   */
  readonly jobs: readonly JobRun[];
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
  /** Dragged positions, by card. Lost on reload, exactly like the sessions themselves. */
  private readonly points = new Map<CardId, CardPoint>();
  private pan: CardPoint = { x: 0, y: 0 };
  private zoom = 1;
  private state: TerminalBoardState = {
    sessions: [],
    jobs: [],
    rows: [],
    lastOutputAt: new Map(),
    profiles: [],
  };
  private readonly content: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  /** Set while the plane itself is being dragged, so a click on the background opens no card. */
  private panning = false;
  /**
   * The card whose note is being written, or `null`.
   *
   * It is also what holds the repaint off. A note editor destroyed under the caret by the one-second
   * tick is the failure this app has already paid for three times, on the tab rename, the table's
   * inline rename and the commit draft, and a `<textarea>` loses more than a field does: everything
   * typed since the last poll.
   */
  private editing: TerminalId | null = null;

  /** The separator drawn before the surface controls, built once and relocated with them. */
  private readonly controlsRule: HTMLElement;
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
     * The same pair as the tab strip, and deliberately: an agent in one click, a terminal through a
     * menu that names what it opens. A surface whose subject is running agents could start a shell
     * and not an agent until this was added, which was the wrong way round.
     *
     * Reading the profile list at click time rather than at construction is what makes a profile
     * added in the settings appear here without the board being rebuilt.
     */
    toolbar.append(
      this.toolbarButton('Start the configured coding agent', AGENT_ICON, () => {
        this.actions.onNewAgent();
      }),
    );

    const pick = this.toolbarButton(
      'New terminal',
      'M2.5 3.5h11v9h-11zM5 6.6l1.7 1.4L5 9.4M8.6 9.8h3.2',
      (event) => {
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
      },
    );
    /*
     * Two glyphs in one button, so it cannot keep the plain `.icon-button` shape.
     *
     * That class is a 26px grid cell with one column: a second child lands on a second ROW, which is
     * how this came out as a terminal with a chevron underneath it. The modifier makes it a row and
     * lets it be as wide as it needs.
     */
    pick.classList.add('board-canvas__pick');
    pick.append(createIcon('M3.5 6l4.5 4.5L12.5 6', { paint: 'stroke' }));
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

  /**
   * Repaints from the state it already has, which is how a card goes quiet as time passes.
   *
   * It is also what makes a job card's clock tick, the only thing on this board that changes with
   * time rather than with an event.
   */
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
          project?.project.label ?? '',
          phase,
          // The panel groups on these two, so a session that failed while the card looked the same
          // still has to repaint.
          String(session.exitCode),
          String(session.stoppedOnPurpose),
          String(session.agent !== null),
          // The text AND the age AS RENDERED, never the raw stamp. The stamp never changes, so a
          // signature carrying it would hold `12 min ago` on the card for the rest of the session:
          // the same trap the job cards' elapsed clock records, reached from the other direction.
          session.note === null
            ? ''
            : `${session.note.text}@${describeNoteAge(session.note.writtenAt, new Date(now))}`,
          point === undefined ? '' : `${point.x},${point.y}`,
        ].join('\u0001');
      })
      .join('\u0002');
  }

  /**
   * What the job cards would show right now, as a string.
   *
   * The elapsed clock is in it as SECONDS and not as a timestamp, which is the whole reason this is
   * written out rather than folded into the one above: a job card is the one thing on this board
   * that has to repaint on the tick with nothing having happened, and a signature carrying
   * `Date.now()` would defeat the guard entirely by never matching itself.
   */
  private jobSignature(now: number): string {
    const at = new Date(now);
    return this.state.jobs
      .map((job) => {
        const point = this.points.get(job.id);
        return [
          job.id,
          job.subject,
          job.detail,
          job.progress ?? '',
          String(job.steps),
          describeElapsed(job.startedAt, at),
          point === undefined ? '' : `${point.x},${point.y}`,
        ].join('\u0001');
      })
      .join('\u0002');
  }

  private paint(force = false): void {
    // Never under a pointer that is carrying a card, and never under an open note editor: the first
    // drops the pointer capture mid-gesture, the second throws away what is being typed.
    if (this.carrying || this.editing !== null) {
      return;
    }
    const now = Date.now();
    const next = `${this.signature(now)}\u0003${this.jobSignature(now)}`;
    if (!force && next === this.painted) {
      return;
    }
    this.painted = next;

    clearChildren(this.content);
    this.applyTransform();
    // Never hidden any more: it is the only way to open a terminal from here, so a machine with a
    // single shell profile would otherwise have none. Same correction the tab strip needed.


    if (this.state.sessions.length === 0 && this.state.jobs.length === 0) {
      this.content.append(
        createElement('p', {
          className: 'board-canvas__empty',
          text: 'Nothing running. Open a terminal and it appears here.',
        }),
      );
      return;
    }

    this.state.sessions.forEach((session, index) => {
      const point = this.points.get(session.id) ?? defaultPoint(index);
      this.content.append(this.buildCard(session, point, now));
    });

    // After the sessions in the default layout, so a run starting while four terminals are open
    // lands in the next free slot rather than on top of one of them.
    this.state.jobs.forEach((job, index) => {
      const point = this.points.get(job.id) ?? defaultPoint(this.state.sessions.length + index);
      this.content.append(this.buildJobCard(job, point, now));
    });
  }

  /**
   * One headless run, as a card.
   *
   * Deliberately NOT a session card with fields left out, and every difference is the same fact
   * restated: this is a process with no pty behind it.
   *
   * - **It cannot unfold.** There is no scrollback to tail, so the detail line the run reports IS
   *   the preview, and it is already on the folded card. A card that opened to show nothing would
   *   be worse than one that does not open.
   * - **It has no context menu.** Everything a session's menu offers acts on a tab, and there is no
   *   tab. Clicking it brings up the tab that owns the run instead.
   * - **It is always `working`, and it LEAVES when the run ends.** `activityOf` reads the time since
   *   the last byte of output and there are no bytes here; what there is is a run that exists while
   *   it runs. So there is no `exited` job card and no dismissal gesture: the result lands in the
   *   run's own tab, which is where a reader goes for it, and a finished card would need a way to
   *   clear it that nothing else on this board has.
   */
  private buildJobCard(job: JobRun, point: CardPoint, now: number): HTMLElement {
    const card = createElement('div', {
      className: 'board-card board-card--working board-card--agent board-card--job',
    });
    card.style.left = `${point.x}px`;
    card.style.top = `${point.y}px`;
    card.title = `${job.title}: ${job.subject}\n(drag to move it, click to show the tab that owns it)`;

    const avatar = createElement('span', { className: 'board-card__avatar' });
    avatar.setAttribute('role', 'img');
    avatar.setAttribute('aria-label', `${job.title}, a headless agent run`);
    avatar.append(createIcon(AGENT_ICON, { paint: 'stroke' }));
    card.append(avatar);

    const body = createElement('div', { className: 'board-card__body' });
    const head = createElement('div', { className: 'board-card__head' });
    head.append(createElement('span', { className: 'board-card__dot' }));
    head.append(createElement('span', { className: 'board-card__title', text: job.title }));
    body.append(head);

    body.append(createElement('span', { className: 'board-card__activity', text: job.subject }));

    /*
     * The line the run is on, and it is why this card exists at all.
     *
     * Clamped to two lines by the stylesheet rather than cut here: a detail reads
     * `web-app#588: reading list.component.ts`, and truncating it at the width of a card would take
     * the file name, which is the half that changes and therefore the half that proves it is alive.
     */
    if (job.detail.length > 0) {
      body.append(createElement('span', { className: 'board-card__detail', text: job.detail }));
    }

    const counts = [
      job.progress,
      job.steps > 0 ? `${job.steps} steps` : null,
      describeElapsed(job.startedAt, new Date(now)),
    ].filter((part): part is string => part !== null);
    body.append(
      createElement('span', { className: 'board-card__counts', text: counts.join(' · ') }),
    );
    card.append(body);

    this.attachCardDrag(card, job.id, point, () => {
      this.actions.onOpenJob(job.kind);
    });
    return card;
  }

  /**
   * One session, as a card.
   *
   * It says who it is and what it is doing, and it carries no buttons at all: clicking it shows the
   * session in the grid, right-clicking opens the tab's own menu.
   *
   * It does not unfold, and it did for one version. The unfolded card tailed the last fifteen lines
   * of the pty through `readTerminalBuffer`, which is text a terminal emulator was going to render:
   * a coding agent redraws a framed box in place with carriage returns and cursor moves, so what a
   * `<pre>` showed was every frame of that redraw stacked on top of each other. Honouring those is
   * implementing a terminal, which is what the grid one click away already is.
   */
  private buildCard(session: TerminalSession, point: CardPoint, now: number): HTMLElement {
    const activity = activityOf(session.running, this.state.lastOutputAt.get(session.id), now);
    const isAgent = session.agent !== null;
    const card = createElement('div', {
      className: `board-card board-card--${activity}${isAgent ? ' board-card--agent' : ''}`,
    });
    card.dataset['card'] = session.id;
    card.style.left = `${point.x}px`;
    card.style.top = `${point.y}px`;
    card.title = `${session.title}\n${session.cwd}\n(drag to move it, click to show it, right click to act)`;

    /*
     * A coding agent wears its badge, a shell does not.
     *
     * The one distinction on this board that changes how you read everything else on the card: a
     * shell going quiet means nothing, an agent going quiet means it is waiting or it is finished.
     * Drawn large and to the left rather than as another small mark in the header, because the header
     * already carries a status dot and a name and a third thing there is a row nobody parses.
     */
    const body = createElement('div', { className: 'board-card__body' });
    if (isAgent) {
      const avatar = createElement('span', { className: 'board-card__avatar' });
      avatar.setAttribute('role', 'img');
      avatar.setAttribute('aria-label', `${session.agent?.label ?? 'Agent'} session`);
      avatar.append(createIcon(AGENT_ICON, { paint: 'stroke' }));
      card.append(avatar);
    }

    const head = createElement('div', { className: 'board-card__head' });
    head.append(createElement('span', { className: 'board-card__dot' }));
    head.append(createElement('span', { className: 'board-card__title', text: session.title }));
    body.append(head);

    body.append(
      createElement('span', {
        className: 'board-card__activity',
        text: describeActivity(activity),
      }),
    );

    const project = this.state.rows.find((row) => row.project.id === session.projectId);
    if (project !== undefined) {
      body.append(
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
      body.append(phase);
    }

    /*
     * The note, and its age, which is the only pairing on this card that is not decoration.
     *
     * Everything else here is a fact the app observed a second ago. This is a sentence a human typed
     * once and did not come back to, so it is the one thing that can be confidently wrong, and the
     * age is what lets the reader discount it. Drawn last, under the derived fields, so a card is
     * still read the same way whether it carries one or not.
     */
    if (session.note !== null) {
      const note = createElement('div', { className: 'board-card__note' });
      note.append(createElement('p', { className: 'board-card__note-text', text: session.note.text }));
      note.append(
        createElement('span', {
          className: 'board-card__note-age',
          text: describeNoteAge(session.note.writtenAt, new Date(now)),
        }),
      );
      body.append(note);
    }
    card.append(body);

    card.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.actions.onMenu(session, event.clientX, event.clientY);
    });
    this.attachCardDrag(card, session.id, point, () => {
      this.actions.onOpen(session.id);
    });
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
   *
   * `onClick` is handed in rather than decided here, because a click means two different things on
   * this board: unfold a session, or show the tab that owns a headless run. Branching inside on
   * which kind of card it is would put the two cards' behaviour in a third place.
   */
  private attachCardDrag(
    card: HTMLElement,
    id: CardId,
    from: CardPoint,
    onClick: () => void,
  ): void {
    const THRESHOLD = 4;
    let origin: CardPoint | null = null;
    let moved = false;

    card.addEventListener('pointerdown', (event) => {
      /*
       * Insurance, and deliberately kept though a card carries no button today.
       *
       * Capturing the pointer here retargets the `pointerup`, so a button added to a card without
       * this would fire its `click` on the card instead of on itself and look inert. That exact
       * failure was paid for three times on this surface already, twice on the plane behind and once
       * on the panel beside it, so the guard stays where the next button will land.
       */
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
        onClick();
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

  /**
   * Opens the note editor on a card, replacing whatever that card was showing.
   *
   * Public, because the menu that offers it is the pane's: a card and a tab are two drawings of one
   * session, and the app already refuses to keep two menus for them. The board is the only surface
   * that can host the editor, so the pane's menu entry reaches in here.
   *
   * Returns quietly when the session has no card, which is every session while the grid is the
   * surface on screen. A menu entry that silently does nothing would be the failure this app names
   * outright, so the caller is what decides whether to offer it.
   */
  editNote(id: TerminalId): void {
    if (!this.state.sessions.some((session) => session.id === id)) {
      return;
    }
    // Repaint BEFORE the guard goes up, and forced: an editor may be open on another card, and
    // `paint` refuses once `editing` is set, so the order here is the whole correctness of it.
    this.editing = null;
    this.paint(true);
    this.editing = id;
    this.openEditor(id);
  }

  /**
   * Puts a textarea over the card's note and hands it the caret.
   *
   * A textarea and not a prompt dialog, for the reason this app has no modals at all: under this CSP
   * a page dialog is not worth the name, and a modal of our own is the pattern that got the settings
   * modal removed. It commits on blur and on `Enter`, and abandons on `Escape`, which is the rename
   * input's own grammar, except that `Shift+Enter` breaks a line here because a note has more than
   * one.
   */
  private openEditor(id: TerminalId): void {
    const card = this.content.querySelector<HTMLElement>(`[data-card="${id}"]`);
    if (card === null) {
      this.editing = null;
      return;
    }
    const session = this.state.sessions.find((entry) => entry.id === id);
    const field = document.createElement('textarea');
    field.className = 'board-card__editor';
    field.value = session?.note?.text ?? '';
    field.maxLength = NOTE_LIMIT;
    field.rows = 3;
    field.placeholder = 'What is this session for?';
    field.setAttribute('aria-label', 'Note about this session');
    // Stops the card's own drag from starting on a press inside the field, which would otherwise
    // capture the pointer and make selecting text move the card.
    field.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) {
        return;
      }
      done = true;
      const text = field.value;
      this.editing = null;
      if (commit) {
        this.actions.onNote(id, text);
      }
      // Forced, because the session list may come back identical: clearing a note that was already
      // empty changes nothing in the main process, so nothing is broadcast, and without this the
      // card would keep the textarea on it.
      this.paint(true);
    };

    field.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        finish(true);
      }
    });
    field.addEventListener('blur', () => {
      finish(true);
    });

    card.querySelector('.board-card__note')?.remove();
    card.querySelector('.board-card__body')?.append(field);
    // A microtask and not an animation frame, the correction the tab rename already carries: a frame
    // is throttled in an occluded window and loses the race against the next broadcast.
    void Promise.resolve().then(() => {
      field.focus();
      field.select();
    });
  }

  /** Dragging the background moves the whole plane. */
  private attachPan(): void {
    let origin: CardPoint | null = null;
    let from: CardPoint = { x: 0, y: 0 };

    this.host.addEventListener('pointerdown', (event) => {
      /*
       * Pan only from a press that landed on the PLANE ITSELF, and never from one that landed on
       * something drawn over it.
       *
       * A whitelist, after a blacklist of selectors failed twice for the same reason. Capturing the
       * pointer here **retargets the `pointerup` to this element**, so the browser fires the `click`
       * on the nearest common ancestor of the two, which is the plane and not the button that was
       * pressed: every control floating above the plane silently stops working. It was the cards'
       * buttons first, then the activity panel's fold, and naming one more selector each time is a
       * fix that is always one control behind.
       *
       * The host and the content div are the only two elements that ARE the plane. Cards live inside
       * the content and answer for their own drag; the toolbar and the panel are siblings. Anything
       * added later is a control until it says otherwise, which is the right default.
       */
      const target = event.target;
      if (target !== this.host && target !== this.content) {
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
