import type { UsageState } from '@shared/contracts.js';
import type { ModelTokens, UsageDay } from '@shared/usage.js';
import {
  PRICES_AS_OF,
  STATS_STALE_AFTER_DAYS,
  describeStatsAge,
  estimateCost,
  estimateTotal,
  formatTokens,
  priceFor,
  recentDays,
  statsAgeDays,
  totalTokens,
} from '@shared/usage.js';
import { clearChildren, createElement } from './dom.js';

/**
 * What the coding agent on this machine has been doing.
 *
 * The tab is built around one awkward fact and does not hide it: **its two halves are not the same
 * age.** The activity is a log appended on every prompt, so it is live; the token counts come from a
 * cache Claude Code rebuilds when it feels like it, and on the machine this was written for that
 * cache was 47 days behind. Reading it as current would be a month and a half of wrong numbers
 * presented with the confidence of a measurement, so the age is stated above the figures it applies
 * to and painted in the warning colour once it is real.
 */

/** Days of history the chart shows. Two working weeks, which is the span a habit is visible over. */
const CHART_DAYS = 14;

/** Projects listed. Past this the list stops answering "where does my time go" and becomes a dump. */
const TOP_PROJECTS = 8;

export function renderUsagePanel(host: HTMLElement, state: UsageState | null): void {
  clearChildren(host);

  if (state === null) {
    host.append(
      createElement('p', { className: 'usage__empty', text: 'Reading Claude Code usage...' }),
    );
    return;
  }

  const now = new Date();
  host.append(buildActivity(state, now));
  host.append(buildTokens(state, now));
}

/* ------------------------------------------------------------------ *
 * The live half
 * ------------------------------------------------------------------ */

function buildActivity(state: UsageState, now: Date): HTMLElement {
  const column = createElement('div', { className: 'usage__column' });
  column.append(createElement('h3', { className: 'usage__heading', text: 'Activity' }));

  const activity = state.activity;
  if (activity === null) {
    column.append(
      createElement('p', {
        className: 'usage__empty',
        text: 'No history file. Claude Code writes ~/.claude/history.jsonl on every prompt.',
      }),
    );
    return column;
  }

  const figures = createElement('div', { className: 'usage__figures' });
  figures.append(buildFigure('Prompts', String(activity.prompts)));
  figures.append(buildFigure('Sessions', String(activity.sessions)));
  figures.append(buildFigure('Days', String(activity.days.length)));
  figures.append(
    buildFigure(
      'Last prompt',
      activity.lastAt === null ? 'never' : describeWhen(activity.lastAt, now),
    ),
  );
  column.append(figures);

  const days = recentDays(activity.days, CHART_DAYS);
  if (days.length > 0) {
    column.append(
      createElement('h4', {
        className: 'usage__subheading',
        text: `Prompts, last ${String(days.length)} active days`,
      }),
    );
    column.append(buildDayChart(days));
  }

  column.append(createElement('h4', { className: 'usage__subheading', text: 'By hour of day' }));
  column.append(buildHourChart(activity.hours));

  if (activity.projects.length > 0) {
    column.append(createElement('h4', { className: 'usage__subheading', text: 'Top projects' }));
    const list = createElement('div', { className: 'usage__projects' });
    for (const project of activity.projects.slice(0, TOP_PROJECTS)) {
      const row = createElement('div', { className: 'usage__project' });
      /*
       * The real path, and it is worth pointing out that it is real.
       *
       * The obvious other source for this list is the folder names under `~/.claude/projects`, which
       * are a path with its separators mangled into dashes: `claudeProjectKey` already records that
       * the encoding is lossy and is never inverted, so a list built from it would show names that
       * are nearly but not quite the folders they stand for. The history log carries the path
       * untouched.
       */
      row.append(
        createElement('span', {
          className: 'usage__project-path path-clip-start',
          text: project.path,
          title: project.path,
        }),
      );
      row.append(
        createElement('span', {
          className: 'usage__project-count',
          text: `${String(project.prompts)} prompts`,
        }),
      );
      row.append(
        createElement('span', {
          className: 'usage__project-count',
          text: `${String(project.sessions)} sessions`,
        }),
      );
      list.append(row);
    }
    column.append(list);
  }

  return column;
}

/* ------------------------------------------------------------------ *
 * The cached half
 * ------------------------------------------------------------------ */

function buildTokens(state: UsageState, now: Date): HTMLElement {
  const column = createElement('div', { className: 'usage__column' });
  column.append(createElement('h3', { className: 'usage__heading', text: 'Tokens and cost' }));

  const stats = state.stats;
  if (stats === null) {
    column.append(
      createElement('p', {
        className: 'usage__empty',
        text: 'No stats cache. Claude Code writes ~/.claude/stats-cache.json on its own schedule, and it is the only place per-model token counts exist.',
      }),
    );
    return column;
  }

  /*
   * The age, first, and before anything it applies to.
   *
   * Not a footnote: every figure under it describes whatever day the cache was last built, and the
   * reader has no other way to know that. The warning colour is earned rather than decorative, the
   * measured lag on the machine this was built for being six and a half weeks.
   */
  const age = statsAgeDays(stats.lastComputedDate, now);
  const stale = age !== null && age > STATS_STALE_AFTER_DAYS;
  column.append(
    createElement('p', {
      className: `usage__age${stale ? ' usage__age--stale' : ''}`,
      text: describeStatsAge(stats.lastComputedDate, now),
    }),
  );
  if (stale) {
    column.append(
      createElement('p', {
        className: 'usage__note',
        text: 'Everything below is as of that day. Claude Code rebuilds this cache itself; nothing here can refresh it.',
      }),
    );
  }

  const estimate = estimateTotal(stats.models);
  const figures = createElement('div', { className: 'usage__figures' });
  figures.append(buildFigure('Estimated cost', `$${estimate.total.toFixed(2)}`));
  figures.append(buildFigure('Messages', String(stats.totalMessages)));
  figures.append(buildFigure('Sessions', String(stats.totalSessions)));
  column.append(figures);

  column.append(
    createElement('p', {
      className: 'usage__note',
      text: `An estimate at list prices as of ${PRICES_AS_OF}, not a bill. On a subscription Claude Code records no cost, so this is computed from the token counts.`,
    }),
  );

  /*
   * What was left out, named rather than counted.
   *
   * The one decision this panel turns on. A model with no entry in the price table contributes
   * nothing to the total, and saying which models those are is the difference between a total that
   * is incomplete and a total that is wrong: the app this was modelled on falls through a substring
   * chain onto a default price, so an unknown model is billed at another model's rate with nothing
   * on screen to say so.
   */
  if (estimate.unpriced > 0) {
    column.append(
      createElement('p', {
        className: 'usage__note usage__note--warn',
        text: `No published price here for ${estimate.unpricedModels.join(', ')}, so their tokens are counted below and excluded from the total.`,
      }),
    );
  }

  const used = stats.models.filter((model) => totalTokens(model) > 0);
  if (used.length === 0) {
    column.append(createElement('p', { className: 'usage__empty', text: 'No tokens recorded.' }));
    return column;
  }

  const peak = Math.max(...used.map(totalTokens));
  const table = createElement('div', { className: 'usage__models' });
  for (const model of used) {
    table.append(buildModelRow(model, peak));
  }
  column.append(table);
  return column;
}

function buildModelRow(model: ModelTokens, peak: number): HTMLElement {
  const row = createElement('div', { className: 'usage__model' });

  const head = createElement('div', { className: 'usage__model-head' });
  head.append(createElement('span', { className: 'usage__model-name', text: model.model }));
  const cost = model.costUsd > 0 ? model.costUsd : estimateCost(model);
  head.append(
    createElement('span', {
      className: `usage__model-cost${cost === null ? ' usage__model-cost--none' : ''}`,
      text: cost === null ? 'no price' : `$${cost.toFixed(2)}`,
      title:
        priceFor(model.model) === null
          ? 'This model is not in the price table, so its tokens are excluded from the total above'
          : `At list prices as of ${PRICES_AS_OF}`,
    }),
  );
  row.append(head);

  const bar = createElement('div', { className: 'usage__bar' });
  const fill = createElement('div', { className: 'usage__bar-fill' });
  // Against the busiest model rather than against the total: the question a row answers is "which
  // of these did the work", and a share of a total is unreadable once one model dominates.
  fill.style.width = `${String(Math.max(1, Math.round((totalTokens(model) / peak) * 100)))}%`;
  bar.append(fill);
  row.append(bar);

  const parts = createElement('div', { className: 'usage__model-parts' });
  parts.append(buildPart('in', model.input));
  parts.append(buildPart('out', model.output));
  parts.append(buildPart('cache read', model.cacheRead));
  parts.append(buildPart('cache write', model.cacheWrite));
  row.append(parts);
  return row;
}

function buildPart(label: string, count: number): HTMLElement {
  const part = createElement('span', { className: 'usage__part' });
  part.append(createElement('span', { className: 'usage__part-value', text: formatTokens(count) }));
  part.append(createElement('span', { className: 'usage__part-label', text: label }));
  return part;
}

/* ------------------------------------------------------------------ *
 * Charts, which are divs and not a library
 * ------------------------------------------------------------------ */

function buildDayChart(days: readonly UsageDay[]): HTMLElement {
  const peak = Math.max(...days.map((day) => day.prompts), 1);
  const chart = createElement('div', { className: 'usage__chart' });
  for (const day of days) {
    const column = createElement('div', { className: 'usage__chart-column' });
    column.title = `${day.date}: ${String(day.prompts)} prompts over ${String(day.sessions)} sessions`;
    const bar = createElement('div', { className: 'usage__chart-bar' });
    bar.style.height = `${String(Math.max(2, Math.round((day.prompts / peak) * 100)))}%`;
    column.append(bar);
    // The day of the month alone: a full date under fourteen bars is a row of unreadable text, and
    // the tooltip carries the whole thing.
    column.append(
      createElement('span', { className: 'usage__chart-label', text: day.date.slice(8) }),
    );
    chart.append(column);
  }
  return chart;
}

function buildHourChart(hours: readonly number[]): HTMLElement {
  const peak = Math.max(...hours, 1);
  const chart = createElement('div', { className: 'usage__chart usage__chart--hours' });
  hours.forEach((count, hour) => {
    const column = createElement('div', { className: 'usage__chart-column' });
    column.title = `${String(hour).padStart(2, '0')}:00 to ${String(hour).padStart(2, '0')}:59, ${String(count)} prompts`;
    const bar = createElement('div', { className: 'usage__chart-bar' });
    bar.style.height = `${String(Math.max(2, Math.round((count / peak) * 100)))}%`;
    column.append(bar);
    // Every third hour, or twenty-four labels collide into a grey smear.
    column.append(
      createElement('span', {
        className: 'usage__chart-label',
        text: hour % 3 === 0 ? String(hour) : '',
      }),
    );
    chart.append(column);
  });
  return chart;
}

function buildFigure(label: string, value: string): HTMLElement {
  const figure = createElement('div', { className: 'usage__figure' });
  figure.append(createElement('span', { className: 'usage__figure-value', text: value }));
  figure.append(createElement('span', { className: 'usage__figure-label', text: label }));
  return figure;
}

/** Coarse, like a note's age and for the same reason: the question is "is this still going on". */
function describeWhen(timestamp: number, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - timestamp) / 60_000));
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${String(minutes)} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h ago`;
  }
  return `${String(Math.floor(hours / 24))}d ago`;
}
