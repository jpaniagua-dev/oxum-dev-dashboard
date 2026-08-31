import type { ProjectConfig, ProjectId } from './contracts.js';

/**
 * The order of the project table, as a value.
 *
 * The stored `projects` array **is** the display order: `resolveProjects` maps it as it stands, the
 * monitor maps that, and the table renders the rows it gets. So reordering is not a view concern with
 * a sort key behind it, it is a permutation of the configuration, and the same permutation shows up in
 * the settings window, in the new-tab menu and in the servers window without any of them being told.
 *
 * Pure and in `shared/` for the reason `terminal-groups.ts` is: a reorder is easy to get subtly wrong
 * (an index computed after the removal instead of before, a drop on the moved item itself, a drop past
 * the last row), and each of those is invisible in a screenshot. The gesture is verified by eye, the
 * arithmetic by test.
 */

/**
 * Moves a project so it sits **in front of** `before`, or last when `before` is `null`.
 *
 * Same contract as `moveTab`, deliberately: the drop target names the neighbour rather than an index,
 * because an index means two different positions depending on whether the moved item has already been
 * taken out of the list. Naming the neighbour makes that question disappear.
 *
 * A move that cannot mean anything returns the list unchanged rather than throwing: an unknown id, or a
 * project dropped on itself. The caller is a drag gesture, and the honest answer to a meaningless drag
 * is that nothing happened.
 */
export function moveProject(
  configs: readonly ProjectConfig[],
  moved: ProjectId,
  before: ProjectId | null,
): ProjectConfig[] {
  const source = configs.find((config) => config.id === moved);
  if (source === undefined || moved === before) {
    return [...configs];
  }

  const without = configs.filter((config) => config.id !== moved);
  const found = before === null ? -1 : without.findIndex((config) => config.id === before);
  const at = found === -1 ? without.length : found;
  return [...without.slice(0, at), source, ...without.slice(at)];
}

/**
 * Whether two project lists hold the same projects, order aside.
 *
 * This is what tells a **reorder** from a real change to the set, and it decides whether the monitors
 * can keep their state. Compared as sets of ids and never by length alone: swapping one project for
 * another keeps the count identical while invalidating everything keyed on the one that left.
 */
export function sameProjectSet(
  a: readonly { readonly id: ProjectId }[],
  b: readonly { readonly id: ProjectId }[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const ids = new Set(a.map((entry) => entry.id));
  return b.every((entry) => ids.has(entry.id));
}
