import {
  TRIAGE_VERDICTS,
  WORK_BATCH_LIMIT,
  type Sprint,
  type TriagedTicket,
  type TriageProgress,
  type TriageResult,
  type TriageState,
  type TriageVerdict,
} from '@shared/contracts.js';
import { clearChildren, createElement, createIcon, createIconButton } from './dom.js';

/**
 * A play triangle: the gesture is "start this run".
 *
 * A magnifier was tried first and read as "search", which is what the button is not: it launches a
 * job that takes minutes. Play is the one glyph nobody has to be taught, and it cannot be mistaken
 * for a filter or a search box.
 *
 * Stroked and not filled, unlike the marker below, because that is what separates an action from a
 * state everywhere in this app. Sized against the **rendered** 14px icon like the sync arrows: 7 by
 * 8.2 units of a 16-unit box, since a smaller triangle closes up into a blob at a 1.6 stroke.
 *
 * Kept here rather than in `icons.ts` because it has a single consumer, the rule that keeps those
 * sync arrows in `git-panel.ts`.
 */
const ANALYSE_ICON = 'M5.6 3.9L12.6 8L5.6 12.1Z';

/**
 * A filled dot for the sprint being worked right now.
 *
 * A state and not an action, so it is a marker and never a button: it is drawn filled, where every
 * other glyph in the app is stroked, precisely so the two cannot be confused at a glance.
 */
const ACTIVE_ICON = 'M4.6 8A3.4 3.4 0 1 1 11.4 8A3.4 3.4 0 1 1 4.6 8';

export interface TriagePanelHosts {
  readonly sprints: HTMLElement;
  readonly bar: HTMLElement;
  readonly list: HTMLElement;
  readonly overview: HTMLElement;
}

export interface TriagePanelActions {
  /** Runs the analysis on one sprint. Long, so the row says so while it runs. */
  onAnalyse: (sprintId: number) => void;
  onSelect: (sprintId: number) => void;
  /** Opens a ticket in the browser: there is no local equivalent of a ticket. */
  onOpen: (key: string) => void;
  /**
   * Hands one or more tickets to Claude Code, in a terminal tab.
   *
   * The pointer position travels with the call because the repository is asked for in a menu at the
   * cursor, the same second-menu gesture the Jira tab uses for `dev <TICKET>`: which repository a
   * ticket belongs to is knowledge this tab does not have, and a wrong guess would create a worktree
   * in the wrong clone.
   *
   * Only the keys are passed. The verdict, the reason and the question stay on disk, where the
   * session that picks the ticket up reads them itself; pushing that text through a shell argument
   * would be both fragile and a copy that starts going stale the moment it is made.
   */
  onWork: (keys: readonly string[], x: number, y: number) => void;
}

/**
 * What each verdict is called on screen, and in which order the groups appear.
 *
 * Ordered by what the reader can act on: what is buildable now comes first, what needs a word from
 * them second, and what nobody can move today last. A list sorted by ticket key would bury the one
 * group the tab exists to surface.
 */
const VERDICT_LABEL: Record<TriageVerdict, string> = {
  ready: 'Ready to build',
  'needs-decision': 'Waiting on a decision',
  backend: 'Blocked by the API',
  unclear: 'Specification too thin',
  blocked: 'Blocked',
};

/**
 * What each verdict is called on its sub-tab.
 *
 * Short, because five full labels and their counts do not fit a strip's bar, and a row of tabs that
 * scrolls sideways is a row whose last tab nobody finds. The full sentence stays as the tooltip and
 * in the empty message, so nothing is lost, only folded.
 */
const VERDICT_TAB: Record<TriageVerdict, string> = {
  ready: 'Ready',
  'needs-decision': 'Decision',
  backend: 'Backend',
  unclear: 'Unclear',
  blocked: 'Blocked',
};

export class TriagePanel {
  private selected: number | null = null;
  /**
   * Which verdict the list is showing.
   *
   * Session-local and never persisted, unlike `pullScope`: reopening the app on `Blocked`
   * because that is where you left it would answer a question nobody asked this morning. It is
   * also reset when the sprint changes, since a verdict that was worth reading on one sprint
   * says nothing about the next.
   */
  private verdict: TriageVerdict | null = null;
  /** Key of the ticket the overview describes. Session-local, like the verdict. */
  private ticket: string | null = null;
  /** Last state, so the elapsed clock can repaint without the app pushing a new one. */
  private last: TriageState | null = null;
  private clock: number | null = null;

  constructor(
    private readonly hosts: TriagePanelHosts,
    private readonly actions: TriagePanelActions,
  ) {}

  select(sprintId: number): void {
    if (sprintId !== this.selected) {
      this.verdict = null;
      this.ticket = null;
    }
    this.selected = sprintId;
  }

  render(state: TriageState): void {
    this.last = state;
    /*
     * The elapsed time ticks on its own.
     *
     * Progress is pushed on events, and those can be twenty seconds apart while a file is being
     * read: without a clock of its own the line would freeze at "0:04" and look exactly like a run
     * that had died. The timer exists only while something runs, so nothing repaints in the
     * background.
     */
    if (state.progress !== null && this.clock === null) {
      this.clock = window.setInterval(() => {
        if (this.last !== null) {
          this.renderBar(this.last);
        }
      }, 1000);
    } else if (state.progress === null && this.clock !== null) {
      window.clearInterval(this.clock);
      this.clock = null;
    }
    // Landing on nothing would ask for a click before the tab says anything: the running sprint if
    // there is one, otherwise the first, which is the active sprint since the list is sorted that way.
    if (this.selected === null || !state.sprints.some((sprint) => sprint.id === this.selected)) {
      this.selected = state.running ?? state.sprints[0]?.id ?? null;
    }

    this.renderSprints(state);
    this.renderBar(state);
    this.renderList(state);
    this.renderOverview(state);
  }

  private renderSprints(state: TriageState): void {
    clearChildren(this.hosts.sprints);

    if (state.sprints.length === 0) {
      this.hosts.sprints.append(
        createElement('p', {
          className: 'pulls__empty',
          text: state.error ?? 'No open sprint',
        }),
      );
      return;
    }

    for (const sprint of state.sprints) {
      this.hosts.sprints.append(this.buildSprintRow(sprint, state));
    }
  }

  private buildSprintRow(sprint: Sprint, state: TriageState): HTMLElement {
    const active = sprint.id === this.selected;
    const row = createElement('div', {
      className: `pulls__repo${active ? ' pulls__repo--active' : ''}`,
    });
    row.addEventListener('click', (event) => {
      // Same guard as the other lists: a click on the button must not also change the selection.
      if ((event.target as HTMLElement).closest('button') !== null) {
        return;
      }
      this.actions.onSelect(sprint.id);
    });

    row.append(createElement('span', { className: 'pulls__repo-name', text: sprint.name }));

    if (sprint.state === 'active') {
      /*
       * The marker carries its own name.
       *
       * `createIcon` marks the drawing `aria-hidden`, which is right for a glyph inside a named
       * button but leaves a bare icon mute. A state nobody can read is a state that does not exist
       * for a screen reader, so the wrapper is the `img` and holds the label.
       */
      const marker = createElement('span', { className: 'triage__state' });
      marker.setAttribute('role', 'img');
      marker.setAttribute('aria-label', 'Active sprint');
      marker.title = 'Active sprint';
      marker.append(createIcon(ACTIVE_ICON));
      row.append(marker);
    }

    const running = state.running === sprint.id;
    const button = createIconButton(ANALYSE_ICON, {
      label: running ? 'Analysing this sprint' : 'Analyse this sprint',
      title: running
        ? 'Claude Code is reading the sprint'
        : 'Classify this sprint with Claude Code',
      className: `triage__analyse${running ? ' triage__analyse--running' : ''}`,
    });
    // Disabled for every sprint while one runs: they share a single process and a single file.
    button.disabled = state.running !== null;
    button.addEventListener('click', () => {
      // Selecting first, so the run you just started is the one you are watching. Without it,
      // pressing Analyse on a sprint you are not looking at leaves the panel on another one.
      this.actions.onSelect(sprint.id);
      this.actions.onAnalyse(sprint.id);
    });
    row.append(button);

    return row;
  }

  private renderBar(state: TriageState): void {
    clearChildren(this.hosts.bar);

    /*
     * A run in progress takes the whole bar.
     *
     * The counts it would otherwise show describe the *previous* analysis, and putting them beside
     * a live status invites reading them as the one being produced. The verdicts below are still
     * the old ones, which is the point, but this line has to be about now.
     */
    if (state.progress !== null && state.progress.sprintId === this.selected) {
      this.renderProgress(state.progress);
      return;
    }

    const result = this.result(state);

    if (result === undefined) {
      this.hosts.bar.append(
        createElement('span', { className: 'triage__meta', text: 'Never analysed' }),
      );
      return;
    }

    /*
     * One sub-tab per verdict, with its count on the tab.
     *
     * The same grammar as the pull request tab's `Mine` / `All`, and for the same reason: the count
     * has to be readable **without** switching view, otherwise choosing a tab means guessing what is
     * behind it. It is also what makes the split safe, since nothing is hidden silently: sitting on
     * `Blocked` you can still see that four tickets are ready.
     *
     * Every verdict gets a tab, including the empty ones. "Ready to build 0" is an answer, and a tab
     * that appears and disappears between two analyses moves the others under the cursor.
     */
    const counts = countVerdicts(result.tickets);
    const active = this.activeVerdict(result.tickets);

    for (const verdict of TRIAGE_VERDICTS) {
      const selected = verdict === active;
      const button = createElement('button', {
        className: `subtab triage__subtab triage__subtab--${verdict}${selected ? ' subtab--active' : ''}`,
      });
      button.type = 'button';
      button.title = VERDICT_LABEL[verdict];
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(selected));
      // The accessible name is the full sentence: a screen reader gets no tooltip, and "Backend"
      // on its own does not say that those tickets are the ones the API cannot serve.
      button.setAttribute('aria-label', `${VERDICT_LABEL[verdict]}, ${counts[verdict]}`);
      button.append(createElement('span', { text: VERDICT_TAB[verdict] }));
      button.append(
        createElement('span', { className: 'subtab__count', text: String(counts[verdict]) }),
      );
      button.addEventListener('click', () => {
        this.verdict = verdict;
        // The ticket belonged to the list being left; keeping it would describe a row nobody can see.
        this.ticket = null;
        if (this.last !== null) {
          this.render(this.last);
        }
      });
      this.hosts.bar.append(button);
    }

    this.hosts.bar.append(
      createElement('span', {
        className: 'triage__meta',
        text: describeAge(result.analysedAt),
      }),
    );

    /*
     * One button for the whole `ready` group, next to the counts rather than inside the list.
     *
     * It is the answer to the question the tab raises once the analysis lands, "so what can I start
     * now", and that question is about the sprint, not about whichever row happens to be selected.
     * It shows on every sub-tab for the same reason the counts do: sitting on `Backend` you should
     * still be able to start the four that are not blocked.
     *
     * Only `ready` gets one. A ticket the analysis parked on a question is one whose answer decides
     * what gets built, so handing a batch of those to an agent would be asking it to pick for you.
     */
    const ready = readyKeys(result.tickets);
    if (ready.length > 0) {
      const work = createElement('button', {
        className: 'button button--primary triage__work',
        text: `Work ${ready.length} ready`,
        title:
          ready.length < countVerdicts(result.tickets).ready
            ? `Hands the first ${ready.length} of them to Claude Code, one after another`
            : 'Hands them to Claude Code, one after another',
      });
      work.type = 'button';
      this.bindWork(work, ready);
      this.hosts.bar.append(work);
    }
  }

  /**
   * The verdict the list is showing.
   *
   * With nothing chosen it lands on the first one that holds tickets, in the order the labels are
   * declared: what can be built comes before what is waiting on you, which comes before what nobody
   * can move today. Landing on an empty tab would make a finished analysis look like it found
   * nothing.
   */
  private activeVerdict(tickets: readonly TriagedTicket[]): TriageVerdict {
    return this.verdict ?? firstFilledVerdict(tickets);
  }

  /**
   * The live status of a running analysis.
   *
   * The bar is **indeterminate**, and that is a decision rather than a shortcut: nothing here knows
   * how long a run takes, so a bar that filled at an invented pace would be a promise the tab
   * cannot keep, and the first slow sprint would make every later one untrustworthy. What is shown
   * instead is real: the file being opened, the number of steps taken, and the time spent. Those
   * three are what tell a slow run from a stuck one, which is the actual question being asked.
   */
  private renderProgress(progress: TriageProgress): void {
    const track = createElement('div', { className: 'triage__progress' });
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', 'Analysis in progress');
    // No `aria-valuenow`: an indeterminate bar has none, and inventing one would tell a screen
    // reader a percentage the sighted view is careful not to claim.
    track.append(createElement('div', { className: 'triage__progress-bar' }));
    this.hosts.bar.append(track);

    this.hosts.bar.append(
      createElement('span', { className: 'triage__phase', text: progress.detail }),
    );
    this.hosts.bar.append(
      createElement('span', {
        className: 'triage__meta',
        text: describeRun(progress, new Date()),
      }),
    );
  }

  private renderList(state: TriageState): void {
    clearChildren(this.hosts.list);
    const result = this.result(state);

    if (result === undefined) {
      this.hosts.list.append(
        createElement('p', {
          className: 'pulls__empty',
          text: 'Press Analyse to classify this sprint.',
        }),
      );
      return;
    }

    /*
     * The error sits above the tickets rather than replacing them.
     *
     * A failed run keeps the previous verdicts, which are still the best answer available: wiping
     * them would punish the reader for a network blip. The line says the list is the old one.
     */
    if (result.error !== null) {
      this.hosts.list.append(createElement('p', { className: 'pulls__error', text: result.error }));
    }

    if (result.tickets.length === 0) {
      this.hosts.list.append(
        createElement('p', { className: 'pulls__empty', text: 'No ticket in this sprint.' }),
      );
      return;
    }

    /*
     * One verdict at a time, chosen on the sub-tabs above.
     *
     * The list used to stack all five behind their headings, which meant scrolling past what you
     * cannot act on to reach what you can. No heading here any more: the selected tab already names
     * what is below it, and repeating it would be a title for a list of one kind.
     */
    const verdict = this.activeVerdict(result.tickets);
    const tickets = result.tickets.filter((ticket) => ticket.verdict === verdict);

    if (tickets.length === 0) {
      this.hosts.list.append(
        createElement('p', {
          className: 'pulls__empty',
          text: `Nothing under ${VERDICT_LABEL[verdict].toLowerCase()}.`,
        }),
      );
      return;
    }

    for (const ticket of tickets) {
      this.hosts.list.append(this.buildTicketRow(ticket));
    }
  }

  /**
   * Everything the analysis has to say about one ticket.
   *
   * The column exists because the row cannot hold it: a verdict is only worth as much as the reason
   * behind it, and checking that reason used to mean opening Jira in a browser, which is the trip
   * this tab is meant to save. Blocks in a fixed order, so the eye learns where the question is.
   */
  private renderOverview(state: TriageState): void {
    clearChildren(this.hosts.overview);
    const ticket = this.overviewTicket(state);

    if (ticket === undefined) {
      this.hosts.overview.append(
        createElement('p', {
          className: 'triage__overview-empty',
          text: 'Pick a ticket to see why it landed there.',
        }),
      );
      return;
    }

    const head = createElement('div', { className: 'triage__overview-head' });
    head.append(createElement('span', { className: 'triage__overview-key', text: ticket.key }));
    head.append(
      createElement('span', {
        className: `triage__verdict triage__verdict--${ticket.verdict}`,
        text: VERDICT_LABEL[ticket.verdict],
      }),
    );
    head.append(
      createElement('span', { className: 'triage__overview-summary', text: ticket.summary }),
    );
    this.hosts.overview.append(head);

    const facts = [ticket.status, ticket.assignee.length > 0 ? ticket.assignee : 'unassigned']
      .filter((fact) => fact.length > 0)
      .join(' · ');
    if (facts.length > 0) {
      this.hosts.overview.append(createElement('span', { className: 'triage__meta', text: facts }));
    }

    this.appendBlock('Why', ticket.reason);
    // The question first among the two, because it is the only block that asks something of the
    // reader; what it triggers is what makes answering it worth doing now.
    this.appendBlock('Question', ticket.question, 'question');
    this.appendBlock('What it triggers', ticket.next);

    if (ticket.description.length > 0) {
      const block = createElement('div', { className: 'triage__block' });
      block.append(createElement('span', { className: 'triage__block-label', text: 'Ticket' }));
      block.append(createElement('div', { className: 'triage__description', text: ticket.description }));
      this.hosts.overview.append(block);
    }

    const actions = createElement('div', { className: 'triage__overview-actions' });

    /*
     * Every verdict gets the button, not only `ready`.
     *
     * Refusing to start a ticket the analysis parked would be the tab overruling its reader on the
     * strength of its own guess, and that guess is a language model reading a Jira description: it
     * has no idea that the missing decision was taken in a corridor this morning. The verdict is
     * shown right above the button, which is the honest version of the same warning, and the batch
     * button beside the counts is where the automatic choice is made and stays limited to `ready`.
     */
    const work = createElement('button', {
      className: 'button button--primary',
      text: 'Work on this',
      title: `Runs the ticket skill on ${ticket.key} in a terminal tab`,
    });
    work.type = 'button';
    this.bindWork(work, [ticket.key]);
    actions.append(work);

    const open = createElement('button', { className: 'button', text: `Open ${ticket.key}` });
    open.type = 'button';
    open.addEventListener('click', () => this.actions.onOpen(ticket.key));
    actions.append(open);

    this.hosts.overview.append(actions);
  }

  /**
   * Wires a "work on these tickets" button, and swallows the click that opened it.
   *
   * `stopPropagation` is what makes both of these buttons work at all, and it is the whole reason
   * this method exists rather than two inline handlers. `onWork` opens a repository menu through
   * `showContextMenu`, which dismisses on any `click` reaching `document`: that is correct for every
   * caller opening from `contextmenu`, since a right click fires no `click` at all, but a menu opened
   * by a **left** click is shut in the same tick by the very click that opened it. The buttons then
   * look completely dead: the menu is created and removed before a frame is painted, so there is
   * nothing on screen and nothing in the logs either.
   *
   * The Git tab's `⋯` button records the same trap, which is precisely why the two triage buttons
   * share one binder: the rule has to be remembered once per menu opener, and the third one would
   * have forgotten it too.
   */
  private bindWork(button: HTMLButtonElement, keys: readonly string[]): void {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this.actions.onWork(keys, event.clientX, event.clientY);
    });
  }

  /** Skips a block the analysis left empty rather than printing a heading over nothing. */
  private appendBlock(label: string, text: string, modifier?: string): void {
    if (text.length === 0) {
      return;
    }
    const block = createElement('div', {
      className: `triage__block${modifier === undefined ? '' : ` triage__block--${modifier}`}`,
    });
    block.append(createElement('span', { className: 'triage__block-label', text: label }));
    block.append(createElement('p', { className: 'triage__block-text', text }));
    this.hosts.overview.append(block);
  }

  /**
   * The ticket the overview describes.
   *
   * Falls back to the first of the visible verdict, so switching sub-tab lands on something rather
   * than on an empty column, and a selection that no longer belongs to the visible list is dropped.
   */
  private overviewTicket(state: TriageState): TriagedTicket | undefined {
    const result = this.result(state);
    if (result === undefined) {
      return undefined;
    }
    const visible = result.tickets.filter(
      (ticket) => ticket.verdict === this.activeVerdict(result.tickets),
    );
    return visible.find((ticket) => ticket.key === this.ticket) ?? visible[0];
  }

  private buildTicketRow(ticket: TriagedTicket): HTMLElement {
    const selected = ticket.key === this.ticket;
    const row = createElement('div', {
      className: `triage__ticket${selected ? ' triage__ticket--active' : ''}`,
    });
    /*
     * Clicking a row SELECTS it, where a pull request row opens the browser.
     *
     * The opposite of that tab on purpose: faced with a list of pull requests the reflex is to go
     * read the PR, because nothing local can show it. Here the reason for the verdict is already on
     * this machine, so reading it is the everyday gesture and Jira is the deliberate one, behind a
     * button in the overview.
     */
    row.addEventListener('click', () => {
      this.ticket = ticket.key;
      if (this.last !== null) {
        this.render(this.last);
      }
    });

    const head = createElement('div', { className: 'triage__ticket-head' });
    head.append(createElement('span', { className: 'triage__key', text: ticket.key }));
    head.append(createElement('span', { className: 'triage__summary', text: ticket.summary }));
    if (ticket.assignee.length > 0) {
      head.append(createElement('span', { className: 'triage__assignee', text: ticket.assignee }));
    }
    row.append(head);

    // The question earns the accent, the reason does not: one is something to answer, the other is
    // something to know.
    if (ticket.question.length > 0) {
      row.append(createElement('p', { className: 'triage__question', text: ticket.question }));
    } else if (ticket.reason.length > 0) {
      row.append(createElement('p', { className: 'triage__reason', text: ticket.reason }));
    }

    return row;
  }

  private result(state: TriageState): TriageResult | undefined {
    return this.selected === null ? undefined : state.results[String(this.selected)];
  }
}

/**
 * The one line that says a run is alive: how many steps, on how many tickets, for how long.
 *
 * Elapsed is minutes and seconds rather than a friendly phrase, because here the reader is watching
 * a clock and "a moment ago" answers nothing. Exported for testing.
 */
export function describeRun(progress: TriageProgress, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(progress.startedAt).getTime()) / 1000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const tickets = progress.tickets > 0 ? `${progress.tickets} tickets, ` : '';
  const steps = progress.steps > 0 ? `${progress.steps} steps, ` : '';
  return `${tickets}${steps}${elapsed}`;
}

/**
 * The verdict a fresh analysis opens on: the first one that holds tickets.
 *
 * The order is `TRIAGE_VERDICTS`, which is the order of what the reader can act on, so this lands on
 * what can be built before what is waiting on them and before what nobody can move today. Landing on
 * an empty tab would make a finished analysis look like it found nothing. Pure and exported, because
 * a default that quietly picks the wrong tab is invisible until someone counts.
 */
export function firstFilledVerdict(tickets: readonly TriagedTicket[]): TriageVerdict {
  const counts = countVerdicts(tickets);
  return TRIAGE_VERDICTS.find((verdict) => counts[verdict] > 0) ?? 'ready';
}

/**
 * The keys the batch button hands over, in list order, capped.
 *
 * The cap is not a display detail: the main process applies the same one, so a button offering more
 * than it can start would silently drop the tail. Capping here instead makes the label say the true
 * number, and the tooltip says it is a first slice. Order is the list's own, so what runs first is
 * what the reader saw first.
 *
 * Pure and exported, because a batch that quietly skips a ticket is the kind of bug nobody notices
 * until a sprint is over.
 */
export function readyKeys(tickets: readonly TriagedTicket[]): string[] {
  return tickets
    .filter((ticket) => ticket.verdict === 'ready')
    .slice(0, WORK_BATCH_LIMIT)
    .map((ticket) => ticket.key);
}

/** Counts per verdict, for the sub-tab badges. Exported for testing. */
export function countVerdicts(tickets: readonly TriagedTicket[]): Record<TriageVerdict, number> {
  const counts: Record<TriageVerdict, number> = {
    ready: 0,
    'needs-decision': 0,
    backend: 0,
    unclear: 0,
    blocked: 0,
  };
  for (const ticket of tickets) {
    counts[ticket.verdict] += 1;
  }
  return counts;
}

/**
 * How old an analysis is, in words.
 *
 * Relative and not a timestamp, because the question this line answers is "can I still trust this",
 * and "3 hours ago" answers it where "14:12" asks the reader to do the subtraction.
 */
export function describeAge(iso: string, now: Date = new Date()): string {
  if (iso.length === 0) {
    return 'Never analysed';
  }
  const analysed = new Date(iso);
  if (Number.isNaN(analysed.getTime())) {
    return 'Never analysed';
  }
  const minutes = Math.max(0, Math.round((now.getTime() - analysed.getTime()) / 60_000));
  if (minutes < 1) {
    return 'Analysed just now';
  }
  if (minutes < 60) {
    return `Analysed ${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `Analysed ${hours} h ago`;
  }
  return `Analysed ${Math.round(hours / 24)} d ago`;
}
