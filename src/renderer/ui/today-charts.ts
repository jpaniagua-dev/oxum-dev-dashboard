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
  /** The tile the row leads with, drawn larger. */
  readonly hero?: boolean;
  /** A value that is good news, in the healthy colour: being clocked in. */
  readonly ok?: boolean;
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
    element.classList.toggle('today__stat--hero', tile.hero === true);
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
    element.append(createElement('span', { className: 'today__stat-value', text: tile.value }));
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
