import type { JiraIssue, JiraState, ProjectId, PullRequest, RepoPulls } from '@shared/contracts.js';
import { describeMinutes, type TipeeState } from '@shared/tipee.js';
import {
  localDay,
  TODAY_CHANNELS,
  type DigestEvent,
  type DigestMail,
  type DigestSection,
  type TodayChannel,
  type TodayChannels,
  type TodayDigestState,
} from '@shared/today.js';
import { clearChildren, createElement } from './dom.js';
import type { Pill } from './presenters.js';
import { buildPill } from './project-table.js';
import {
  buildStatRow,
  chartCard,
  layoutDay,
  renderDay,
  renderSprint,
  sprintBreakdown,
  type StatTile,
} from './today-charts.js';

/**
 * The Today tab: one card per source, each answering "what is waiting for me there".
 *
 * Pull requests and tickets are read from what the other tabs already hold, so the tab costs no
 * request of its own for them. Calendar, mail and Teams come from one Microsoft 365 digest, and the
 * time tracking card from its own poll; both are pushed by the main process.
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
  readonly onOpenIssue: (issue: JiraIssue) => void;
  readonly onOpenUrl: (url: string) => void;
  readonly onOpenSettings: () => void;
}

/** What a pull request is waiting for, in the order the card lists them: what needs me first. */
export type PullNeed = 'review' | 'changes' | 'approved' | 'waiting' | 'draft';

const NEED_ORDER: readonly PullNeed[] = ['review', 'changes', 'approved', 'waiting', 'draft'];

export interface TodayPull {
  readonly projectId: ProjectId;
  readonly repo: string;
  readonly pull: PullRequest;
  readonly need: PullNeed;
}

/**
 * My pull requests and the ones waiting for my review, the ones that need me first.
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
      right.pull.updatedAt.localeCompare(left.pull.updatedAt),
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

export function presentNeed(need: PullNeed): Pill {
  switch (need) {
    case 'review':
      return { label: 'your review', tone: 'busy', title: 'Your review is requested' };
    case 'changes':
      return { label: 'changes requested', tone: 'error', title: 'A reviewer requested changes' };
    case 'approved':
      return { label: 'approved', tone: 'ok', title: 'Approved: ready to merge once green' };
    case 'waiting':
      return { label: 'waiting', tone: 'neutral', title: 'Waiting for a review' };
    case 'draft':
      return { label: 'draft', tone: 'neutral', title: 'Still a draft' };
  }
}

/** My open tickets, once each, what is moving before what is waiting. */
export function todayTickets(state: JiraState | null): JiraIssue[] {
  if (state === null) {
    return [];
  }
  const byKey = new Map<string, JiraIssue>();
  for (const view of state.views) {
    for (const issue of view.issues) {
      if (issue.isMine && issue.stage !== 'done' && !byKey.has(issue.key)) {
        byKey.set(issue.key, issue);
      }
    }
  }
  const order = ['in-progress', 'todo', 'unknown'];
  return [...byKey.values()].sort(
    (left, right) =>
      order.indexOf(left.stage) - order.indexOf(right.stage) ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
}

/** Where a meeting stands against the clock: over, under way, or still to come. */
export type EventMoment = 'past' | 'now' | 'later';

export function eventMoment(event: DigestEvent, now: number): EventMoment {
  if (event.isAllDay) {
    return 'now';
  }
  // A wall-clock string without a zone parses as local time, which is the zone the search used.
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 'later';
  }
  return now >= end ? 'past' : now >= start ? 'now' : 'later';
}

export function describeEventTime(event: DigestEvent): string {
  return event.isAllDay ? 'All day' : `${event.start.slice(11, 16)}-${event.end.slice(11, 16)}`;
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

/**
 * One screen, no page scroll: the day, the numbers, then panels that share the height left.
 *
 * Laid out for a strip a few hundred pixels tall above the terminal. Each fact appears once:
 * the tiles say how many and lead to the source, the panels say which. A panel that is longer
 * than its share scrolls on its own, so the others stay in view.
 */
export function renderTodayPanel(
  host: HTMLElement,
  inputs: TodayInputs,
  actions: TodayActions,
): void {
  clearChildren(host);
  const channels = shownChannels(inputs.channels);
  if (channels.length === 0) {
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

  // The day and the numbers share one line: the day takes what the tiles leave.
  const top = createElement('div', { className: 'today__top' });
  const digest = inputs.digest.digest;
  if (inputs.channels.calendar && digest !== null && digest.errors.calendar === undefined) {
    const card = chartCard('Your day');
    renderDay(card.body, layoutDay(digest.events), new Date(inputs.now));
    top.append(card.element);
  }
  const tiles = statTiles(inputs);
  if (tiles.length > 0) {
    top.append(
      buildStatRow(
        tiles.map((tile) => {
          const target =
            tile.channel === undefined ? null : tileTarget(tile.channel, inputs, actions);
          return target === null ? tile : { ...tile, open: target };
        }),
      ),
    );
  }
  if (top.childElementCount > 0) {
    host.append(top);
  }

  const panels = createElement('div', { className: 'today__panels' });
  if (inputs.channels.pulls) {
    panels.append(pullsPanel(inputs, actions));
  }
  if (inputs.channels.tickets) {
    panels.append(ticketsPanel(inputs, actions));
  }
  if (inputs.channels.mail) {
    panels.append(mailPanel(inputs, actions));
  }
  if (inputs.channels.teams) {
    panels.append(teamsPanel(inputs, actions));
  }
  if (panels.childElementCount > 0) {
    panels.style.setProperty('--panels', String(panels.childElementCount));
    host.append(panels);
  }
}

/** What a click on a tile opens: the tab or the site the number comes from. */
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
    // No tile for these three: their panel below already says how many, and which.
    case 'calendar':
    case 'mail':
    case 'teams':
      return null;
    case 'tipee':
      return inputs.tipeeUrl.length === 0
        ? null
        : { title: 'Open Tipee', run: () => actions.onOpenUrl(inputs.tipeeUrl) };
  }
}

/**
 * The headline numbers: pull requests, tickets and time tracking, the first one leading.
 *
 * Calendar, mail and Teams have none, on request: their panels already say how many and which,
 * and three tiles fewer is what lets the rest share the line of the day. A value that is being read
 * says so, and one that could not be read says `?` rather than 0.
 */
export function statTiles(inputs: TodayInputs): StatTile[] {
  const tiles: StatTile[] = [];
  const { channels, now } = inputs;
  if (channels.pulls) {
    const items = todayPulls(inputs.pulls);
    const owed = items.filter((item) => item.need === 'review' || item.need === 'changes').length;
    const approved = items.filter((item) => item.need === 'approved').length;
    tiles.push({
      channel: 'pulls',
      label: 'PRs need you',
      value: String(owed),
      detail: `${approved} approved · ${items.length} open`,
    });
  }
  if (channels.tickets) {
    const items = todayTickets(inputs.tickets);
    tiles.push({
      channel: 'tickets',
      label: 'In progress',
      value:
        inputs.tickets === null
          ? '…'
          : String(items.filter((issue) => issue.stage === 'in-progress').length),
      detail: `${items.filter((issue) => issue.stage !== 'in-progress').length} to do`,
    });
  }
  if (channels.tipee) {
    const status = inputs.tipee.status;
    tiles.push({
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
  const first = tiles[0];
  if (first !== undefined) {
    tiles[0] = { ...first, hero: true };
  }
  return tiles;
}

/** The unread mail of the digest, newest first. The search cannot filter on it, so this does. */
export function unreadMail(inputs: TodayInputs): DigestMail[] {
  return [...(inputs.digest.digest?.mail ?? [])]
    .filter((entry) => !entry.isRead)
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
}

/** A panel: a title with its count, and a body that scrolls on its own. */
function panelShell(title: string, count: string): { element: HTMLElement; body: HTMLElement } {
  const element = createElement('section', { className: 'today__panel' });
  const head = createElement('div', { className: 'today__panel-head' });
  head.append(createElement('span', { className: 'today__card-title', text: title }));
  if (count.length > 0) {
    head.append(createElement('span', { className: 'today__card-count', text: count }));
  }
  const body = createElement('div', { className: 'today__panel-body' });
  element.append(head, body);
  return { element, body };
}

/**
 * The two queues of pull requests: the ones waiting for my review, and mine waiting for others.
 *
 * Mine counts only while it waits on somebody else: a draft is not asking anyone yet, and one
 * with changes requested or approved is back in my hands.
 */
function pullsPanel(inputs: TodayInputs, actions: TodayActions): HTMLElement {
  const items = todayPulls(inputs.pulls);
  const panel = panelShell('Pull requests', '');
  if (inputs.pulls.length > 0 && inputs.pulls.every((repo) => repo.checkedAt === null)) {
    panel.body.append(note('Reading…'));
  }
  for (const [title, need, empty] of [
    ['To review', 'review', 'Nothing waiting for your review.'],
    ['Mine, waiting', 'waiting', 'None of yours is waiting for a review.'],
  ] as const) {
    const queue = items.filter((item) => item.need === need);
    panel.body.append(
      createElement('span', { className: 'today__group-title', text: `${title} ${queue.length}` }),
    );
    if (queue.length === 0) {
      panel.body.append(note(empty));
    }
    for (const item of queue) {
      const row = rowButton(item.pull.title, `${item.repo} · #${item.pull.number}`, []);
      row.title = `${item.pull.title}\n${item.pull.branch}`;
      row.addEventListener('click', () => actions.onOpenPull(item.projectId, item.pull.number));
      panel.body.append(row);
    }
  }
  const failed = inputs.pulls.filter((repo) => repo.error !== null).length;
  if (failed > 0) {
    panel.body.append(
      problem(`${failed} ${failed === 1 ? 'repository' : 'repositories'} could not be read`),
    );
  }
  return panel.element;
}

/** My open tickets, under the sprint they belong to. */
function ticketsPanel(inputs: TodayInputs, actions: TodayActions): HTMLElement {
  const items = todayTickets(inputs.tickets);
  const panel = panelShell('Tickets', inputs.tickets === null ? '' : String(items.length));
  if (inputs.tickets === null) {
    panel.body.append(note('Reading…'));
    return panel.element;
  }
  const sprint = sprintBreakdown(inputs.tickets);
  if (sprint !== null) {
    const chart = createElement('div', { className: 'today__panel-chart' });
    renderSprint(chart, sprint);
    panel.body.append(chart);
  }
  if (items.length === 0) {
    panel.body.append(note('No open ticket assigned to you.'));
  }
  for (const issue of items) {
    const row = rowButton(
      `${issue.key}  ${issue.summary}`,
      [issue.status, issue.type].filter(Boolean).join(' · '),
      [],
    );
    row.classList.toggle('today__row--active', issue.stage === 'in-progress');
    row.addEventListener('click', () => actions.onOpenIssue(issue));
    panel.body.append(row);
  }
  const errors = inputs.tickets.views
    .map((view) => view.error)
    .filter((error): error is string => error !== null);
  if (errors[0] !== undefined) {
    panel.body.append(problem(errors[0]));
  }
  return panel.element;
}

function mailPanel(inputs: TodayInputs, actions: TodayActions): HTMLElement {
  const digest = inputs.digest.digest;
  const unread = unreadMail(inputs);
  const panel = panelShell('Unread mail', digest === null ? '' : String(unread.length));
  if (digestPreamble(panel.body, inputs, 'mail')) {
    return panel.element;
  }
  if (unread.length === 0) {
    panel.body.append(note('No unread mail among the newest.'));
  }
  for (const entry of unread) {
    const message = messageButton(
      entry.subject,
      `${entry.sender} · ${describeWhen(entry.receivedAt, inputs.now)}`,
      entry.preview,
    );
    if (entry.important) {
      message
        .querySelector('.today__message-head')
        ?.prepend(
          createElement('span', { className: 'today__flag', text: '!', title: 'High importance' }),
        );
    }
    linkRow(message, entry.url, actions);
    panel.body.append(message);
  }
  // Read among the newest only: the search returns the newest, with no filter on the read state.
  if (digest !== null && digest.mailTotal !== null && digest.mailTotal > digest.mail.length) {
    panel.body.append(
      note(`Among the ${digest.mail.length} newest of ${digest.mailTotal} since yesterday.`),
    );
  }
  return panel.element;
}

/**
 * The conversations where somebody else wrote last, with what they wrote.
 *
 * Titled "waiting for your reply" and never "unread": Teams gives the connector no read state.
 */
function teamsPanel(inputs: TodayInputs, actions: TodayActions): HTMLElement {
  const digest = inputs.digest.digest;
  const chats = digest?.chats ?? [];
  const panel = panelShell(
    'Teams, waiting for your reply',
    digest === null ? '' : String(chats.length),
  );
  if (digestPreamble(panel.body, inputs, 'teams')) {
    return panel.element;
  }
  if (chats.length === 0) {
    panel.body.append(note('Every conversation since yesterday ends with your message.'));
  }
  for (const chat of chats) {
    const thread = createElement('button', { className: 'today__message' });
    thread.type = 'button';
    const head = createElement('span', { className: 'today__message-head' });
    head.append(createElement('span', { className: 'today__message-title', text: chat.title }));
    head.append(
      createElement('span', {
        className: 'today__row-when',
        text: describeWhen(chat.lastAt, inputs.now),
      }),
    );
    thread.append(head);
    for (const line of chat.lines) {
      const text = createElement('span', { className: 'today__message-line' });
      text.append(createElement('span', { className: 'today__message-from', text: line.from }));
      text.append(document.createTextNode(` ${line.text}`));
      thread.append(text);
    }
    if (chat.count > chat.lines.length) {
      thread.append(
        createElement('span', {
          className: 'today__message-more',
          text: `${chat.count - chat.lines.length} earlier`,
        }),
      );
    }
    linkRow(thread, chat.url, actions);
    panel.body.append(thread);
  }
  return panel.element;
}

/** A message row: who and when, the subject, and the start of the text under it. */
function messageButton(title: string, facts: string, preview: string): HTMLButtonElement {
  const button = createElement('button', { className: 'today__message' });
  button.type = 'button';
  const head = createElement('span', { className: 'today__message-head' });
  head.append(createElement('span', { className: 'today__message-title', text: title }));
  button.append(head);
  button.append(createElement('span', { className: 'today__row-facts', text: facts }));
  if (preview.length > 0) {
    button.append(createElement('span', { className: 'today__message-preview', text: preview }));
  }
  return button;
}

/**
 * What the two digest panels say before their own content, and whether that is all they say.
 *
 * A run under way shows its clock; a digest from another day says which day; a failed run says
 * why, naming the command, and keeps the older answer underneath when there is one.
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

function rowButton(title: string, facts: string, pills: readonly Pill[]): HTMLButtonElement {
  const row = createElement('button', { className: 'today__row' });
  row.type = 'button';
  const line = createElement('span', { className: 'today__row-head' });
  line.append(createElement('span', { className: 'today__row-title', text: title }));
  for (const pill of pills) {
    line.append(buildPill(pill));
  }
  row.append(line);
  if (facts.length > 0) {
    row.append(createElement('span', { className: 'today__row-facts', text: facts }));
  }
  return row;
}

/** A row that opens its link, or stays inert and says why when the source gave none. */
function linkRow(row: HTMLButtonElement, url: string, actions: TodayActions): void {
  if (url.length === 0) {
    row.disabled = true;
    row.title = 'No link to open';
    return;
  }
  row.addEventListener('click', () => actions.onOpenUrl(url));
}

function note(text: string): HTMLElement {
  return createElement('p', { className: 'pulls__empty', text });
}

function problem(text: string): HTMLElement {
  return createElement('p', { className: 'pulls__error', text });
}
