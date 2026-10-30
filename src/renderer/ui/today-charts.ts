import type { JiraState } from '@shared/contracts.js';
import type { DigestEvent, TodayChannel } from '@shared/today.js';
import { clearChildren, createElement, createIcon } from './dom.js';

/**
 * The status half of the Today tab: headline numbers, the day on an hour axis, the sprint.
 *
 * Built from divs placed in percentages rather than an SVG scaled to its box: a stretched SVG
 * stretches its text, and a chart this small is mostly labels. Every value a chart draws is also
 * written, either on the chart or in the lists below it, so nothing is readable only by hovering.
 */

/** One headline number. */
export interface StatTile {
  /** The source the number comes from. */
  readonly channel?: TodayChannel;
  readonly label: string;
  /** Already formatted. `…` while it is being read, `?` when it could not be. */
  readonly value: string;
  readonly detail: string;
  /** A value that is good news, in the healthy colour: being clocked in. */
  readonly ok?: boolean;
  /** The colour of the bars the number counts, so the tile and its chart read as one. */
  readonly accent?: string;
  /** Why the value is what it is, when it is not a number. */
  readonly title?: string;
  /** Where a click on the tile leads: the tab or the site the number comes from. */
  readonly open?: { readonly title: string; readonly run: () => void };
}

/** An arrow leaving a box: this goes somewhere else. */
const OPEN_ICON = 'M9.5 2.5h4v4 M13.5 2.5L8 8 M12 9.5v4H2.5V4H6.5';

/** A meeting placed on the day: where it starts and how wide it is, in percent of the range. */
export interface PlacedEvent {
  readonly event: DigestEvent;
  readonly left: number;
  readonly width: number;
  /** Row of the timeline, so two meetings at the same time do not hide each other. */
  readonly lane: number;
}

export interface DayLayout {
  /** First and last whole hour of the axis. */
  readonly fromHour: number;
  readonly toHour: number;
  readonly placed: readonly PlacedEvent[];
  readonly lanes: number;
  readonly allDay: readonly DigestEvent[];
}

/** The working hours always shown, widened to fit an earlier or later meeting. */
const DAY_START = 8;
const DAY_END = 18;

/**
 * The meetings of the day on an hour axis.
 *
 * Cancelled meetings are left off: the list below still names them, struck through. Overlapping
 * meetings take the first free row, which is what a calendar's own day view does.
 */
export function layoutDay(events: readonly DigestEvent[]): DayLayout {
  const timed = events
    .filter((event) => !event.isAllDay && !event.isCancelled)
    .map((event) => ({ event, start: minutesOf(event.start), end: minutesOf(event.end) }))
    .filter((entry) => entry.end > entry.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const fromHour = Math.min(DAY_START, ...timed.map((entry) => Math.floor(entry.start / 60)));
  const toHour = Math.max(DAY_END, ...timed.map((entry) => Math.ceil(entry.end / 60)));
  const span = (toHour - fromHour) * 60;
  const laneEnds: number[] = [];
  const placed = timed.map(({ event, start, end }) => {
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    return {
      event,
      left: ((start - fromHour * 60) / span) * 100,
      width: ((end - start) / span) * 100,
      lane,
    };
  });
  return {
    fromHour,
    toHour,
    placed,
    lanes: Math.max(1, laneEnds.length),
    allDay: events.filter((event) => event.isAllDay && !event.isCancelled),
  };
}

/** Where now falls on the axis, in percent, or null outside it. */
export function nowOffset(layout: DayLayout, now: Date): number | null {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const from = layout.fromHour * 60;
  const to = layout.toHour * 60;
  return minutes < from || minutes > to ? null : ((minutes - from) / (to - from)) * 100;
}

/** Tickets of the sprint by stage, mine and the whole sprint's. */
export interface SprintBreakdown {
  readonly mine: StageCounts;
  readonly team: StageCounts;
}

export interface StageCounts {
  readonly todo: number;
  readonly inProgress: number;
  readonly done: number;
}

/** Counts the sprint view, finished work included, which is what a sprint's progress is made of. */
export function sprintBreakdown(state: JiraState | null): SprintBreakdown | null {
  const sprint = state?.views.find((view) => view.id === 'sprint');
  if (sprint === undefined || sprint.issues.length === 0) {
    return null;
  }
  const count = (mineOnly: boolean): StageCounts => {
    const issues = sprint.issues.filter((issue) => !mineOnly || issue.isMine);
    return {
      todo: issues.filter((issue) => issue.stage === 'todo' || issue.stage === 'unknown').length,
      inProgress: issues.filter((issue) => issue.stage === 'in-progress').length,
      done: issues.filter((issue) => issue.stage === 'done').length,
    };
  };
  return { mine: count(true), team: count(false) };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

export function buildStatRow(tiles: readonly StatTile[]): HTMLElement {
  const row = createElement('div', { className: 'today__stats' });
  for (const tile of tiles) {
    // The whole tile is the button when it leads somewhere: a 20px corner glyph was the only target.
    const element =
      tile.open === undefined
        ? createElement('div', { className: 'today__stat' })
        : createElement('button', { className: 'today__stat today__stat--link' });
    element.classList.toggle('today__stat--ok', tile.ok === true);
    if (tile.open !== undefined && element instanceof HTMLButtonElement) {
      element.type = 'button';
      element.addEventListener('click', tile.open.run);
    }
    const title = [tile.title, tile.open?.title].filter((part) => part !== undefined).join('\n');
    if (title.length > 0) {
      element.title = title;
    }
    const head = createElement('span', { className: 'today__stat-head' });
    head.append(createElement('span', { className: 'today__stat-label', text: tile.label }));
    if (tile.open !== undefined) {
      const glyph = createIcon(OPEN_ICON, { paint: 'stroke' });
      glyph.classList.add('today__stat-glyph');
      head.append(glyph);
    }
    element.append(head);
    const value = createElement('span', { className: 'today__stat-value', text: tile.value });
    if (tile.accent !== undefined) {
      value.style.color = tile.accent;
    }
    element.append(value);
    if (tile.detail.length > 0) {
      element.append(createElement('span', { className: 'today__stat-detail', text: tile.detail }));
    }
    row.append(element);
  }
  return row;
}

/** A chart card: a title, an optional legend, and its plot. */
export function chartCard(
  title: string,
  className = '',
): { element: HTMLElement; body: HTMLElement } {
  const element = createElement('section', { className: `today__chart ${className}`.trim() });
  element.append(createElement('span', { className: 'today__card-title', text: title }));
  const body = createElement('div', { className: 'today__chart-body' });
  element.append(body);
  return { element, body };
}

export function renderDay(host: HTMLElement, layout: DayLayout, now: Date): void {
  clearChildren(host);
  if (layout.allDay.length > 0) {
    const chips = createElement('div', { className: 'today__allday' });
    for (const event of layout.allDay) {
      chips.append(createElement('span', { className: 'today__allday-chip', text: event.subject }));
    }
    host.append(chips);
  }

  const plot = createElement('div', { className: 'today__day' });
  plot.style.setProperty('--lanes', String(layout.lanes));
  const hours = layout.toHour - layout.fromHour;
  // A tick every hour up to ten hours, every two beyond: labels must not touch at this width.
  const step = hours > 10 ? 2 : 1;
  for (let hour = layout.fromHour; hour <= layout.toHour; hour += step) {
    const left = ((hour - layout.fromHour) / hours) * 100;
    const tick = createElement('span', { className: 'today__day-tick' });
    tick.style.left = `${left}%`;
    plot.append(tick);
    const edge =
      hour === layout.fromHour
        ? ' today__day-hour--first'
        : hour + step > layout.toHour
          ? ' today__day-hour--last'
          : '';
    const label = createElement('span', {
      className: `today__day-hour${edge}`,
      text: `${String(hour).padStart(2, '0')}:00`,
    });
    label.style.left = `${left}%`;
    plot.append(label);
  }

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (const { event, left, width, lane } of layout.placed) {
    const past = minutesOf(event.end) <= nowMinutes;
    const current = !past && minutesOf(event.start) <= nowMinutes;
    const block = createElement('span', {
      className: `today__day-event${past ? ' today__day-event--past' : ''}${current ? ' today__day-event--now' : ''}`,
      title: `${event.start.slice(11, 16)}-${event.end.slice(11, 16)}  ${event.subject}`,
    });
    block.style.left = `${left}%`;
    block.style.width = `${width}%`;
    block.style.setProperty('--lane', String(lane));
    // The subject only where it fits: a clipped word reads as a different word.
    if (width >= 8) {
      block.append(createElement('span', { className: 'today__day-label', text: event.subject }));
    }
    plot.append(block);
  }

  const offset = nowOffset(layout, now);
  if (offset !== null) {
    const line = createElement('span', { className: 'today__day-now', title: 'Now' });
    line.style.left = `${offset}%`;
    plot.append(line);
  }
  host.append(plot);
  if (layout.placed.length === 0) {
    host.append(createElement('p', { className: 'pulls__empty', text: 'No meeting today.' }));
  }
}

const STAGES: readonly { key: keyof StageCounts; label: string; slot: number }[] = [
  { key: 'done', label: 'Done', slot: 1 },
  { key: 'inProgress', label: 'In progress', slot: 2 },
  { key: 'todo', label: 'To do', slot: 3 },
];

export function renderSprint(host: HTMLElement, breakdown: SprintBreakdown): void {
  clearChildren(host);
  const legend = createElement('div', { className: 'today__legend' });
  for (const stage of STAGES) {
    const item = createElement('span', { className: 'today__legend-item' });
    const swatch = createElement('span', { className: 'today__swatch' });
    swatch.style.background = `var(--chart-${stage.slot})`;
    item.append(swatch, document.createTextNode(stage.label));
    legend.append(item);
  }
  host.append(legend);
  for (const [label, counts] of [
    ['You', breakdown.mine],
    ['Sprint', breakdown.team],
  ] as const) {
    const total = counts.todo + counts.inProgress + counts.done;
    const row = createElement('div', { className: 'today__stack-row' });
    row.append(createElement('span', { className: 'today__stack-label', text: label }));
    const bar = createElement('div', { className: 'today__stack' });
    for (const stage of STAGES) {
      const value = counts[stage.key];
      if (value === 0) {
        continue;
      }
      const segment = createElement('span', {
        className: 'today__stack-segment',
        title: `${stage.label}: ${value}`,
      });
      segment.style.flexGrow = String(value);
      segment.style.background = `var(--chart-${stage.slot})`;
      // Only where it fits with room around it; the total on the right says the rest.
      if (value / total >= 0.12) {
        segment.append(
          createElement('span', { className: 'today__stack-count', text: String(value) }),
        );
      }
      bar.append(segment);
    }
    row.append(bar);
    row.append(
      createElement('span', { className: 'today__stack-total', text: `${counts.done}/${total}` }),
    );
    host.append(row);
  }
}

function minutesOf(wallClock: string): number {
  const hours = Number(wallClock.slice(11, 13));
  const minutes = Number(wallClock.slice(14, 16));
  return Number.isNaN(hours) || Number.isNaN(minutes) ? 0 : hours * 60 + minutes;
}

/* ------------------------------------------------------------------ *
 * Pull requests by age
 * ------------------------------------------------------------------ */

/** What a pull request waits for, which is also its colour on the chart. */
export type AgeSlot = 'review' | 'changes' | 'approved' | 'waiting' | 'draft';

export interface AgeRow {
  readonly key: string;
  /** `#755 Add the thing`. */
  readonly label: string;
  /** The repository and the branch, for the tooltip. */
  readonly detail: string;
  readonly slot: AgeSlot;
  /** ISO, when it was opened. */
  readonly createdAt: string;
}

export interface AgeBar extends AgeRow {
  readonly left: number;
  readonly width: number;
  /** Whole days open, or null when the opening date is unknown. */
  readonly days: number | null;
}

export interface AgeLayout {
  readonly ticks: readonly { readonly left: number; readonly label: string }[];
  readonly bars: readonly AgeBar[];
  /** Rows past the limit, said under the chart rather than squeezed into it. */
  readonly hidden: number;
}

const DAY_MS = 86_400_000;
/** The axis shows at least a week, so a pull request opened this morning is not the whole width. */
const MIN_DAYS = 7;
/** And at most a month: older ones run off the left edge, their age written on the bar. */
const MAX_DAYS = 30;

/**
 * Open pull requests on a day axis, each a bar from its opening to now.
 *
 * Built to answer "what has been waiting longest", which a list sorted by update time hides: the
 * axis starts at the oldest opening, within one week and one month, at local midnight.
 */
export function layoutAges(rows: readonly AgeRow[], now: number, limit: number): AgeLayout {
  const opened = rows.map((row) => Date.parse(row.createdAt)).filter((at) => !Number.isNaN(at));
  const oldest = opened.length > 0 ? Math.min(...opened) : now;
  const span = Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.ceil((now - oldest) / DAY_MS)));
  const start = new Date(now - span * DAY_MS);
  start.setHours(0, 0, 0, 0);
  const from = start.getTime();
  const width = now - from;

  const bars = rows.slice(0, limit).map((row) => {
    const at = Date.parse(row.createdAt);
    const known = !Number.isNaN(at);
    const begin = known ? Math.max(at, from) : now;
    return {
      ...row,
      left: ((begin - from) / width) * 100,
      width: ((now - begin) / width) * 100,
      days: known ? Math.floor((now - at) / DAY_MS) : null,
    };
  });

  const days = Math.round(width / DAY_MS);
  // Eight labels at most, so a week reads day by day and a month every four days.
  const step = Math.max(1, Math.ceil(days / 8));
  const ticks: { left: number; label: string }[] = [];
  for (let day = 0; day <= days; day += step) {
    const at = new Date(from);
    at.setDate(at.getDate() + day);
    if (at.getTime() > now) {
      break;
    }
    ticks.push({
      left: ((at.getTime() - from) / width) * 100,
      label: at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }),
    });
  }
  return { ticks, bars, hidden: Math.max(0, rows.length - limit) };
}

/** `3 d`, `today`, or nothing when the date is unknown. */
export function describeAge(days: number | null): string {
  if (days === null) {
    return '';
  }
  return days === 0 ? 'today' : `${days} d`;
}

const AGE_SLOTS: readonly { slot: AgeSlot; label: string; colour: string }[] = [
  { slot: 'review', label: 'Your review', colour: 'var(--chart-1)' },
  { slot: 'changes', label: 'Changes requested', colour: 'var(--danger)' },
  { slot: 'waiting', label: 'Waiting', colour: 'var(--chart-4)' },
  { slot: 'approved', label: 'Approved', colour: 'var(--chart-3)' },
  { slot: 'draft', label: 'Draft', colour: 'var(--border-strong)' },
];

export function renderAges(
  host: HTMLElement,
  layout: AgeLayout,
  onOpen: (key: string) => void,
): void {
  clearChildren(host);
  // The legend names only what is on the chart: five swatches for two kinds of bar is noise.
  const present = new Set(layout.bars.map((bar) => bar.slot));
  const legend = createElement('div', { className: 'today__legend' });
  for (const entry of AGE_SLOTS.filter((item) => present.has(item.slot))) {
    const item = createElement('span', { className: 'today__legend-item' });
    const swatch = createElement('span', { className: 'today__swatch' });
    swatch.style.background = entry.colour;
    item.append(swatch, document.createTextNode(entry.label));
    legend.append(item);
  }
  host.append(legend);

  const grid = createElement('div', { className: 'today__ages' });
  for (const bar of layout.bars) {
    const label = createElement('button', {
      className: 'today__age-label',
      text: bar.label,
      title: `${bar.label}\n${bar.detail}`,
    });
    label.type = 'button';
    label.addEventListener('click', () => onOpen(bar.key));
    const track = createElement('div', { className: 'today__age-track' });
    const mark = createElement('button', {
      className: 'today__age-bar',
      title: `${bar.label}\n${bar.detail}\nOpen ${describeAge(bar.days) || 'for an unknown time'}`,
    });
    mark.type = 'button';
    mark.style.left = `${bar.left}%`;
    mark.style.width = `${bar.width}%`;
    mark.style.background = AGE_SLOTS.find((item) => item.slot === bar.slot)?.colour ?? '';
    mark.addEventListener('click', () => onOpen(bar.key));
    track.append(mark);
    // Every bar ends at now, so there is no room after it: a wide bar holds its age, a short one
    // has it just before its start, in the text colour, where it can still be read.
    const inside = bar.width >= 10;
    const age = createElement('span', {
      className: inside ? 'today__age-days today__age-days--inside' : 'today__age-days',
      text: describeAge(bar.days),
    });
    age.style.left = `${bar.left}%`;
    track.append(age);
    grid.append(label, track);
  }
  const axis = createElement('div', { className: 'today__age-axis' });
  for (const tick of layout.ticks) {
    const label = createElement('span', { className: 'today__age-tick', text: tick.label });
    label.style.left = `${tick.left}%`;
    axis.append(label);
  }
  grid.append(createElement('span'), axis);
  host.append(grid);
}
