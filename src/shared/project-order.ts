import type { ProjectConfig, ProjectId } from './contracts.js';
import { tagKey } from './project-tags.js';

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

/**
 * The tag a project is grouped under: its **first** one, folded, or empty when it has none.
 *
 * The first and not "all of them", because a project with `backend` and `dotnet` has to land in one
 * place and only one. The chips are in insertion order and the user controls it, so the group key is
 * something they can change rather than something derived behind their back.
 */
function groupKeyOf(config: Pick<ProjectConfig, 'tags'>): string {
  return tagKey(config.tags[0] ?? '');
}

/**
 * Groups the list by tag, as a permutation of the configuration.
 *
 * **This is a reorder, not a sort key**, and that distinction is the whole design. The stored
 * `projects` array *is* the display order: the table, the settings window, the new-tab menu and the
 * servers window all read it as it stands. A sort applied in the view would make the table disagree
 * with the other three, and a drag would then be arithmetic on a list nobody displays. So grouping is
 * a save, exactly like `moveProject`, and it composes with a drag afterwards instead of overruling it.
 * That is also why it is a one-shot command and not a mode: there is nothing to turn off.
 *
 * The Jira tab does have a real column sort, and the difference is not inconsistency: that list is
 * **fetched**, so it has no stored order to contradict, and a sort there is the only order it has.
 *
 * Two rules carry the result. Untagged projects go **last**, being the residue rather than a group;
 * putting them first would push every grouped project below the fold. And the order *inside* a group
 * is the order it already had, which is `Array.prototype.sort` being stable since ES2019 and the
 * property this function actually depends on: a group reshuffled on every click would throw away the
 * drags that arranged it.
 */
export function sortProjectsByTag<T extends Pick<ProjectConfig, 'tags'>>(
  // Generic, and typed on the one field it reads: the settings form holds mutable drafts of a
  // configuration, and a signature fixed on `ProjectConfig` would hand them back as readonly and force
  // a cast at the only call site.
  configs: readonly T[],
): T[] {
  return [...configs].sort((left, right) => {
    const a = groupKeyOf(left);
    const b = groupKeyOf(right);
    if (a === b) {
      return 0;
    }
    if (a.length === 0) {
      return 1;
    }
    if (b.length === 0) {
      return -1;
    }
    return a.localeCompare(b);
  });
}

/** Whether grouping could change anything, which is what decides if the command is offered. */
export function hasAnyTag(configs: readonly { readonly tags: readonly string[] }[]): boolean {
  return configs.some((config) => config.tags.length > 0);
}
