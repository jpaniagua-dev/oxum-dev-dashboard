import type { JiraState, ProjectId, PullRequest, RepoPulls } from '@shared/contracts.js';
import { describeMinutes, type TipeeState } from '@shared/tipee.js';
import {
  localDay,
  TODAY_CHANNELS,
  type DigestMail,
  type DigestSection,
  type TodayChannel,
  type TodayChannels,
  type TodayDigestState,
} from '@shared/today.js';
import { clearChildren, createElement } from './dom.js';
import {
  buildStatRow,
  chartCard,
  layoutAges,
  layoutDay,
  renderAges,
  renderDay,
  renderSprint,
  sprintBreakdown,
  type AgeRow,
  type StatTile,
} from './today-charts.js';

/**
 * The Today tab: three lines, each a chart and the three numbers that go with it.
 *
 * The day with mail, Teams and the clock; the sprint with my tickets by stage; the pull requests
 * by age with what waits on whom. Pull requests and tickets are read from what the other tabs
 * already hold; calendar, mail and Teams come from one Microsoft 365 digest, and the clock from
 * its own poll, both pushed by the main process.
 */

export interface TodayInputs {
  readonly channels: TodayChannels;
  readonly pulls: readonly RepoPulls[];
  /** Jira and local tickets merged, as the Tickets tab draws them; null before the first read. */
  readonly tickets: JiraState | null;
  readonly digest: TodayDigestState;
  readonly tipee: TipeeState;
  readonly tipeeUrl: string;
  readonly now: number;
}

export interface TodayActions {
  readonly onOpenPull: (projectId: ProjectId, number: number) => void;
  readonly onOpenPulls: () => void;
  readonly onOpenTickets: () => void;
  readonly onOpenUrl: (url: string) => void;
  readonly onOpenSettings: () => void;
}

/** What a pull request is waiting for, in the order the chart lists them: what needs me first. */
export type PullNeed = 'review' | 'changes' | 'approved' | 'waiting' | 'draft';

const NEED_ORDER: readonly PullNeed[] = ['review', 'changes', 'approved', 'waiting', 'draft'];

export interface TodayPull {
  readonly projectId: ProjectId;
  readonly repo: string;
  readonly pull: PullRequest;
  readonly need: PullNeed;
}

/**
 * My pull requests and the ones waiting for my review, the ones that need me first, the oldest
 * first within each.
 *
 * A review request wins over authorship: GitHub drops me from the requested reviewers once I have
 * reviewed, so `isReviewer` on somebody else's pull request means my review is still owed.
 */
export function todayPulls(repos: readonly RepoPulls[]): TodayPull[] {
  const out: TodayPull[] = [];
  for (const repo of repos) {
    for (const pull of repo.pulls) {
      if (!pull.isAuthor && !pull.isReviewer) {
        continue;
      }
      out.push({ projectId: repo.projectId, repo: repo.label, pull, need: needOf(pull) });
    }
  }
  return out.sort(
    (left, right) =>
      NEED_ORDER.indexOf(left.need) - NEED_ORDER.indexOf(right.need) ||
      left.pull.createdAt.localeCompare(right.pull.createdAt),
  );
}

export function needOf(pull: PullRequest): PullNeed {
  if (pull.isReviewer && !pull.isAuthor) {
    return 'review';
  }
  if (pull.isDraft) {
    return 'draft';
  }
  switch (pull.review) {
    case 'changes-requested':
      return 'changes';
    case 'approved':
      return 'approved';
    case 'review-required':
    case 'none':
      return 'waiting';
  }
}

/** `14:05` today, `Yesterday 14:05`, or `Mon 14:05` further back. */
export function describeWhen(iso: string, now: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return '';
  }
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = localDay(new Date(now));
  const day = localDay(at);
  if (day === today) {
    return time;
  }
  const yesterday = localDay(new Date(new Date(now).setDate(new Date(now).getDate() - 1)));
  if (day === yesterday) {
    return `Yesterday ${time}`;
  }
  return `${at.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
}

/** `0:07`, the clock of a run under way. */
export function describeElapsed(startedAt: string | null, now: number): string {
  const started = startedAt === null ? Number.NaN : Date.parse(startedAt);
  if (Number.isNaN(started)) {
    return '';
  }
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The channels the tab draws, in display order. */
export function shownChannels(channels: TodayChannels): TodayChannel[] {
  return TODAY_CHANNELS.filter((channel) => channels[channel]);
}

/** The unread mail of the digest, newest first. The search cannot filter on it, so this does. */
export function unreadMail(inputs: TodayInputs): DigestMail[] {
  return [...(inputs.digest.digest?.mail ?? [])]
    .filter((entry) => !entry.isRead)
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
}

/** The numbers of each line. Pure, so what each one counts is pinned by a test. */
export interface TodayTiles {
  readonly day: StatTile[];
  readonly tickets: StatTile[];
  readonly pulls: StatTile[];
}

/**
 * The three numbers of each line.
 *
 * A digest value that is being read says so, and one that could not be read says `?` rather than
 * 0: a zero would claim an empty inbox nobody checked. The tickets are mine in the current sprint,
 * read off the sprint view, so a ticket outside the sprint does not inflate them.
 */
export function todayTiles(inputs: TodayInputs): TodayTiles {
  const { channels, now } = inputs;
  const digest = inputs.digest.digest;
  const unknown = (section: DigestSection): string | null => {
    if (digest === null) {
      return inputs.digest.running ? '…' : '?';
    }
    return digest.errors[section] === undefined ? null : '?';
  };

  const day: StatTile[] = [];
  if (channels.mail) {
    day.push({
      channel: 'mail',
      label: 'Unread mail',
      value: unknown('mail') ?? String(unreadMail(inputs).length),
      detail: digest === null ? '' : `among the ${digest.mail.length} newest`,
    });
  }
  if (channels.teams) {
    const chats = digest?.chats ?? [];
    const messages = chats.reduce((sum, chat) => sum + chat.count, 0);
    day.push({
      channel: 'teams',
      label: 'Teams to answer',
      value: unknown('teams') ?? String(chats.length),
      detail: digest === null ? '' : `${messages} message${messages === 1 ? '' : 's'} waiting`,
    });
  }
  if (channels.tipee) {
    const status = inputs.tipee.status;
    day.push({
      channel: 'tipee',
      label: 'Clocked since',
      ok: status?.clockedIn === true,
      value:
        status === null
          ? inputs.tipee.configured && inputs.tipee.error === null
            ? '…'
            : '?'
          : status.clockedIn && status.since !== null
            ? describeWhen(status.since, now)
            : 'Out',
      detail:
        status === null
          ? inputs.tipee.configured
            ? ''
            : 'not configured'
          : `worked today ${describeMinutes(status.doneMinutes)}`,
      ...(inputs.tipee.error !== null
        ? { title: inputs.tipee.error }
        : status === null
          ? {}
          : {
              title: `Due ${describeMinutes(status.dueMinutes)}, balance ${describeMinutes(status.balanceMinutes)}${status.pending > 0 ? `, ${status.pending} correction(s) waiting` : ''}`,
            }),
    });
  }

  const tickets: StatTile[] = [];
  if (channels.tickets) {
    const mine = sprintBreakdown(inputs.tickets)?.mine ?? null;
    const value = (count: number | undefined): string =>
      inputs.tickets === null ? '…' : String(count ?? 0);
    const detail =
      mine === null && inputs.tickets !== null ? 'no sprint found' : 'yours, this sprint';
    tickets.push(
      // Each number in the colour of its stage on the sprint chart beside it.
      {
        channel: 'tickets',
        label: 'In progress',
        value: value(mine?.inProgress),
        detail,
        accent: 'var(--chart-2)',
      },
      {
        channel: 'tickets',
        label: 'To do',
        value: value(mine?.todo),
        detail,
        accent: 'var(--chart-3)',
      },
      {
        channel: 'tickets',
        label: 'Done',
        value: value(mine?.done),
        detail,
        accent: 'var(--chart-1)',
      },
    );
  }

  const pulls: StatTile[] = [];
  if (channels.pulls) {
    const items = todayPulls(inputs.pulls);
    const count = (need: PullNeed): number => items.filter((item) => item.need === need).length;
    pulls.push(
      {
        channel: 'pulls',
        label: 'PRs need you',
        value: String(count('review') + count('changes')),
        detail: `${count('review')} to review, ${count('changes')} to change`,
      },
      {
        channel: 'pulls',
        label: 'Mine, waiting',
        accent: 'var(--chart-4)',
        value: String(count('waiting')),
        detail: 'open, waiting for approval',
      },
      {
        channel: 'pulls',
        label: 'Mine, approved',
        accent: 'var(--chart-3)',
        value: String(count('approved')),
        detail: 'open, ready to merge',
      },
    );
  }
  return { day, tickets, pulls };
}

/** Where a click on a tile leads: the tab or the site the number comes from. */
const OUTLOOK_MAIL_URL = 'https://outlook.office.com/mail/';
const TEAMS_URL = 'https://teams.microsoft.com/';

/** How many pull requests the age chart draws before saying how many more there are. */
const AGE_ROWS = 6;

export function renderTodayPanel(
  host: HTMLElement,
  inputs: TodayInputs,
  actions: TodayActions,
): void {
  clearChildren(host);
  if (shownChannels(inputs.channels).length === 0) {
    const empty = createElement('div', { className: 'today__none' });
    empty.append(
      createElement('p', {
        className: 'pulls__empty',
        text: 'No card is switched on. Choose what this machine shows in Settings, Today.',
      }),
    );
    const open = createElement('button', { className: 'button', text: 'Open settings' });
    open.type = 'button';
    open.addEventListener('click', () => actions.onOpenSettings());
    empty.append(open);
    host.append(empty);
    return;
  }

  const tiles = todayTiles(inputs);
  appendLine(host, inputs.channels.calendar ? dayCard(inputs) : null, tiles.day, inputs, actions);
  appendLine(
    host,
    inputs.channels.tickets ? sprintCard(inputs) : null,
    tiles.tickets,
    inputs,
    actions,
  );
  appendLine(
    host,
    inputs.channels.pulls ? pullsCard(inputs, actions) : null,
    tiles.pulls,
    inputs,
    actions,
  );
}

/** One line: the chart takes what the tiles leave, and drops under them only when too narrow. */
function appendLine(
  host: HTMLElement,
  chart: HTMLElement | null,
  tiles: readonly StatTile[],
  inputs: TodayInputs,
  actions: TodayActions,
): void {
  if (chart === null && tiles.length === 0) {
    return;
  }
  const line = createElement('div', { className: 'today__line' });
  if (chart !== null) {
    line.append(chart);
  }
  if (tiles.length > 0) {
    line.append(
      buildStatRow(
        tiles.map((tile) => {
          const target =
            tile.channel === undefined ? null : tileTarget(tile.channel, inputs, actions);
          return target === null ? tile : { ...tile, open: target };
        }),
      ),
    );
  }
  host.append(line);
}

function tileTarget(
  channel: TodayChannel,
  inputs: TodayInputs,
  actions: TodayActions,
): { title: string; run: () => void } | null {
  switch (channel) {
    case 'pulls':
      return { title: 'Open the Pull requests tab', run: actions.onOpenPulls };
    case 'tickets':
      return { title: 'Open the Tickets tab', run: actions.onOpenTickets };
    case 'mail':
      return { title: 'Open Outlook', run: () => actions.onOpenUrl(OUTLOOK_MAIL_URL) };
    case 'teams':
      return { title: 'Open Teams', run: () => actions.onOpenUrl(TEAMS_URL) };
    case 'tipee':
      return inputs.tipeeUrl.length === 0
        ? null
        : { title: 'Open Tipee', run: () => actions.onOpenUrl(inputs.tipeeUrl) };
    case 'calendar':
      return null;
  }
}

/**
 * The day's meetings, or what stands in their place: a run under way, a run that failed, or an
 * answer from another day, which is said and not drawn on today's axis.
 */
function dayCard(inputs: TodayInputs): HTMLElement {
  const card = chartCard('Your day');
  const digest = inputs.digest.digest;
  if (digestPreamble(card.body, inputs, 'calendar') || digest === null) {
    return card.element;
  }
  if (digest.day === localDay(new Date(inputs.now))) {
    renderDay(card.body, layoutDay(digest.events), new Date(inputs.now));
  }
  return card.element;
}

function sprintCard(inputs: TodayInputs): HTMLElement {
  const card = chartCard('Sprint');
  if (inputs.tickets === null) {
    card.body.append(note('Reading…'));
    return card.element;
  }
  const sprint = sprintBreakdown(inputs.tickets);
  if (sprint === null) {
    card.body.append(note('No sprint found in the Tickets tab.'));
  } else {
    renderSprint(card.body, sprint);
  }
  const error = inputs.tickets.views.map((view) => view.error).find((entry) => entry !== null);
  if (error !== undefined && error !== null) {
    card.body.append(problem(error));
  }
  return card.element;
}

function pullsCard(inputs: TodayInputs, actions: TodayActions): HTMLElement {
  const card = chartCard('Pull requests by age');
  if (inputs.pulls.length > 0 && inputs.pulls.every((repo) => repo.checkedAt === null)) {
    card.body.append(note('Reading…'));
    return card.element;
  }
  const items = todayPulls(inputs.pulls);
  if (items.length === 0) {
    card.body.append(note('No open pull request of yours, and none waiting for your review.'));
  } else {
    const rows: AgeRow[] = items.map((item) => ({
      key: `${item.projectId}#${item.pull.number}`,
      label: `#${item.pull.number} ${item.pull.title}`,
      detail: `${item.repo} · ${item.pull.branch}`,
      slot: item.need,
      createdAt: item.pull.createdAt,
    }));
    const layout = layoutAges(rows, inputs.now, AGE_ROWS);
    renderAges(card.body, layout, (key) => {
      const item = items.find((entry) => `${entry.projectId}#${entry.pull.number}` === key);
      if (item !== undefined) {
        actions.onOpenPull(item.projectId, item.pull.number);
      }
    });
    if (layout.hidden > 0) {
      card.body.append(note(`${layout.hidden} more in the Pull requests tab.`));
    }
  }
  const failed = inputs.pulls.filter((repo) => repo.error !== null).length;
  if (failed > 0) {
    card.body.append(
      problem(`${failed} ${failed === 1 ? 'repository' : 'repositories'} could not be read`),
    );
  }
  return card.element;
}

/**
 * What a digest card says before its own content, and whether that is all it says.
 *
 * A run under way shows its clock; a digest from another day says which day; a failed run says
 * why, naming the command.
 */
function digestPreamble(body: HTMLElement, inputs: TodayInputs, section: DigestSection): boolean {
  const { digest, running, startedAt, error } = inputs.digest;
  if (running) {
    body.append(note(`Reading Microsoft 365… ${describeElapsed(startedAt, inputs.now)}`));
  }
  if (error !== null) {
    body.append(problem(error));
  }
  if (digest === null) {
    if (!running && error === null) {
      body.append(note('Not read yet. Refresh to read it.'));
    }
    return true;
  }
  if (digest.day !== localDay(new Date(inputs.now))) {
    body.append(note(`From ${describeWhen(digest.fetchedAt, inputs.now)}. Refresh to read today.`));
  }
  const sectionError = digest.errors[section];
  if (sectionError !== undefined) {
    body.append(problem(sectionError));
    return true;
  }
  return false;
}

function note(text: string): HTMLElement {
  return createElement('p', { className: 'pulls__empty', text });
}

function problem(text: string): HTMLElement {
  return createElement('p', { className: 'pulls__error', text });
}
