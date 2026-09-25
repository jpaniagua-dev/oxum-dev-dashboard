import type { AgentContext } from '@shared/agent-context.js';
import {
  FEEDBACK_ACTION_ID,
  TRIAGE_WORK_ACTION_ID,
  type ProjectRow,
  type TerminalId,
  type TerminalSession,
} from '@shared/contracts.js';
import { clearChildren, createElement } from './dom.js';
import { activityOf, describeActivity } from './terminal-board.js';

/**
 * The Agents tab: which coding agents are running, and what each one reads.
 *
 * A session's terminal already shows what its agent is **saying**. What no surface showed until now
 * is what it was given: which folder it started in, which model it was pinned to, which instruction
 * files it picks up on the way down the tree, and what memory it has for that folder. Those are the
 * four things that decide what a session is capable of, and all four were invisible.
 *
 * **Agent-agnostic by construction.** Everything in the left column is what this app itself recorded
 * when it spawned the process, so it is as true of Codex as of Claude Code. The right column is read
 * off disk and is allowed to come back half empty, which it says rather than hides.
 */

export interface AgentsPanelActions {
  /** Shows that session's terminal, which is the one thing this panel cannot do itself. */
  onOpen: (terminalId: TerminalId) => void;
}

/** What the panel is looking at. Held by the app, since the panel is rebuilt whole. */
export interface AgentsPanelView {
  readonly selected: TerminalId | null;
}

/**
 * The sessions this tab lists: the ones running a coding agent, newest first.
 *
 * Pure and exported so the rule is pinned by a test rather than read off a screen. Newest first
 * because the one just handed a ticket is the one being watched, and the list is short enough that
 * a stable order matters less than the top entry being the right one.
 */
export function agentSessions(sessions: readonly TerminalSession[]): TerminalSession[] {
  return sessions
    .filter((session) => session.agent !== null)
    .sort((left, right) => (right.agent?.startedAt ?? '').localeCompare(left.agent?.startedAt ?? ''));
}

/**
 * What a session was opened to work on: a ticket, a pull request, or nothing named.
 *
 * Read out of the **action id**, which is the only place it survives. The ticket keys go into
 * `workActionId` when the handoff spawns the tab and the pull request number into
 * `feedbackActionId`, so the id is a record of the intent rather than a name somebody typed. A tab
 * renamed by hand still reports the right ticket, which a title cannot promise.
 *
 * Empty for an agent started from the button: it was opened to work on whatever you are about to
 * tell it, and inventing a subject for it would be a label the app made up.
 */
export function describeAgentTask(actionId: string | null): string {
  if (actionId === null) {
    return '';
  }
  if (actionId.startsWith(`${TRIAGE_WORK_ACTION_ID}:`)) {
    /*
     * Matched, never split.
     *
     * `workActionId` joins the keys with a dash and a key already contains one, so
     * `PROJ-1801-PROJ-1802` has no separator a split can find: it shreds into four pieces and the
     * row reads "PROJ, 1801, PROJ, 1802". Matching the shape of a key instead is unambiguous
     * whatever the join, and it is the same shape `ISSUE_KEY_PATTERN` vets on the way in, minus its
     * anchors because this looks inside a longer string.
     */
    return (actionId.match(/[A-Z][A-Z0-9_]*-\d+/g) ?? []).join(', ');
  }
  if (actionId.startsWith(`${FEEDBACK_ACTION_ID}:`)) {
    const tail = actionId.slice(FEEDBACK_ACTION_ID.length + 1);
    const hash = tail.lastIndexOf('#');
    return hash === -1 ? '' : `PR #${tail.slice(hash + 1)}`;
  }
  return '';
}

/** How long ago a session started, in the coarsest unit that is still true. */
export function describeAge(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) {
    return '';
  }
  const minutes = Math.max(0, Math.round((now - started) / 60_000));
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/** Renders the list of agent sessions and the context of the selected one. */
export function renderAgentsPanel(
  hosts: { list: HTMLElement; detail: HTMLElement },
  sessions: readonly TerminalSession[],
  context: AgentContext | null,
  current: AgentsPanelView,
  actions: AgentsPanelActions,
  extra: {
    /** Project rows, for the repository a session is tied to. */
    readonly rows: readonly ProjectRow[];
    /** When each session was last heard from, for the activity. */
    readonly lastOutputAt: ReadonlyMap<TerminalId, number>;
  } = { rows: [], lastOutputAt: new Map() },
): void {
  clearChildren(hosts.list);
  clearChildren(hosts.detail);

  const agents = agentSessions(sessions);
  if (agents.length === 0) {
    hosts.detail.append(
      createElement('p', {
        className: 'pulls__empty',
        text: 'No agent running. Hand a ticket over from the Triage tab and it appears here.',
      }),
    );
    return;
  }

  const active = agents.find((session) => session.id === current.selected) ?? agents[0];
  const now = Date.now();

  for (const session of agents) {
    const activity = activityOf(session.running, extra.lastOutputAt.get(session.id), now);
    const row = createElement('button', {
      className:
        `agents__row agents__row--${activity}` +
        (session.id === active?.id ? ' agents__row--active' : ''),
    });
    row.type = 'button';

    /*
     * Two lines, and what is on each is the whole design of this list.
     *
     * The top line is identity: a dot for what the session is doing right now, its name, and how
     * long it has been going. The bottom line is what it is doing it ON: the ticket or the pull
     * request, the repository, the model. The first answers "which one is this", the second answers
     * "and should I be looking at it", and putting them on one line made both unreadable.
     */
    const head = createElement('div', { className: 'agents__row-head' });
    head.append(createElement('span', { className: 'agents__row-dot' }));
    head.append(createElement('span', { className: 'agents__row-name', text: session.title }));
    head.append(
      createElement('span', {
        className: 'agents__row-age',
        text: session.agent === null ? '' : describeAge(session.agent.startedAt, now),
      }),
    );
    row.append(head);

    const project = extra.rows.find((entry) => entry.project.id === session.projectId);
    const facts = [
      describeAgentTask(session.actionId),
      project?.project.label ?? '',
      session.agent?.model ?? '',
      // Only when it is not the obvious one: every live session says "working" or "quiet" on its dot
      // already, and a row repeating it in words is the same fact twice on a line with four things
      // competing for the width.
      activity === 'exited' ? describeExit(session) : '',
    ].filter((fact) => fact.length > 0);
    if (facts.length > 0) {
      row.append(
        createElement('span', { className: 'agents__row-facts', text: facts.join(' · ') }),
      );
    }

    row.title = `${session.title}\n${describeActivity(activity)}\n${session.cwd}`;
    row.addEventListener('click', () => actions.onOpen(session.id));
    hosts.list.append(row);
  }

  if (active === undefined || active.agent === null) {
    return;
  }

  /*
   * A block of facts rather than a row of them, and it carries what the app recorded at the spawn.
   *
   * Recorded and not re-read: the model and the profile can both be changed in the settings while a
   * session runs, and showing the current setting would describe the next session rather than this
   * one. The working directory spans both columns because it is a path, and a path wrapped into a
   * narrow cell is a path nobody can read.
   */
  const activeActivity = activityOf(active.running, extra.lastOutputAt.get(active.id), now);
  const head = createElement('div', { className: 'agents__head' });
  appendFact(head, 'Agent', active.agent.label);
  appendFact(head, 'Model', active.agent.model.length > 0 ? active.agent.model : 'default');
  appendFact(
    head,
    'State',
    active.running ? describeActivity(activeActivity) : describeExit(active),
  );
  appendFact(head, 'Since', describeAge(active.agent.startedAt, now));
  const task = describeAgentTask(active.actionId);
  if (task.length > 0) {
    appendFact(head, 'Working on', task);
  }
  appendFact(head, 'Folder', active.cwd, true);
  hosts.detail.append(head);

  if (context === null) {
    hosts.detail.append(createElement('p', { className: 'pulls__empty', text: 'Reading...' }));
    return;
  }

  const instructions = context.instructions.map((entry) => buildPathRow(entry.path));
  hosts.detail.append(
    buildSection(
      `Instructions (${context.instructions.length})`,
      instructions.length > 0
        ? instructions
        : [
            createElement('p', {
              className: 'agents__note',
              // Worth stating plainly: an agent with no instruction file anywhere above it starts
              // with nothing but its own defaults, which is rarely what anyone intended.
              text: 'None found above this folder. The session starts with no project instructions.',
            }),
          ],
    ),
  );

  /*
   * One card per line, name and summary side by side.
   *
   * Columns of bare names were tried and dropped: they fit more on screen and answered a narrower
   * question. What this list is read for is what the agent knows, and the one-line summary is that
   * answer; the name alone is a filename. It makes for a long list, which is what the panel scrolls
   * for.
   */
  const memoryChildren: HTMLElement[] =
    context.memoryNote.length > 0
      ? [createElement('p', { className: 'agents__note', text: context.memoryNote })]
      : context.memory.map((card) => {
          const row = createElement('div', { className: 'agents__card' });
          row.append(createElement('span', { className: 'agents__card-name', text: card.name }));
          if (card.description.length > 0) {
            row.append(
              createElement('span', { className: 'agents__card-desc', text: card.description }),
            );
          }
          return row;
        });
  hosts.detail.append(buildSection(`Memory (${context.memory.length})`, memoryChildren));
}

/**
 * How a finished session finished, in three words at most.
 *
 * Only shown once it has finished, which is when it becomes the most important thing on the row: a
 * session that failed looks exactly like one that succeeded on every other field.
 */
export function describeExit(
  session: Pick<TerminalSession, 'exitCode' | 'stoppedOnPurpose'>,
): string {
  if (session.stoppedOnPurpose) {
    return 'stopped';
  }
  if (session.exitCode === null || session.exitCode === 0) {
    return 'finished';
  }
  return `failed (${session.exitCode})`;
}

/** One labelled fact of the header block. `wide` spans both columns, for a path. */
function appendFact(host: HTMLElement, label: string, value: string, wide = false): void {
  host.append(
    createElement('span', {
      className: `agents__fact-label${wide ? ' agents__fact-label--wide' : ''}`,
      text: label,
    }),
  );
  host.append(
    createElement('span', {
      className: `agents__fact-value${wide ? ' agents__fact-value--wide' : ''}`,
      text: value,
    }),
  );
}

function buildSection(title: string, children: readonly HTMLElement[]): HTMLElement {
  const section = createElement('div', { className: 'agents__section' });
  section.append(createElement('span', { className: 'agents__section-title', text: title }));
  for (const child of children) {
    section.append(child);
  }
  return section;
}

/**
 * A path, shown and not opened.
 *
 * Read-only on purpose. Opening one would mean an IPC that hands an arbitrary path to the shell,
 * which is a capability this app does not have and does not need for a panel whose job is to say
 * what an agent reads. Monospace, per this app's rule: a path is a value something else reads back
 * exactly, not a word somebody chose.
 */
function buildPathRow(path: string): HTMLElement {
  return createElement('span', { className: 'agents__path', text: path });
}
