import type { TerminalGroup, TerminalId } from './contracts.js';

/**
 * The arithmetic of the pane groups.
 *
 * Every gesture on the surface is "the same groups, differently": opening a tab, splitting, dragging
 * a tab into another pane, closing a pane. All of it is list surgery on a structure with two
 * invariants that are easy to break in opposite directions and impossible to see once broken:
 *
 * - **a group is never empty** (an empty pane is a blank rectangle with no gesture left to fix it);
 * - **a session appears in exactly one group** (it owns a single xterm element, so showing it twice
 *   would mean detaching that element, which kills it for good).
 *
 * Shared rather than renderer-only: the renderer computes a layout and the main process validates
 * the same shape with the same rules, and two implementations of "is this layout sane" would end up
 * disagreeing. Pure, and therefore tested rather than eyeballed.
 */

/** Index of the group holding a session, or `-1`. */
export function groupIndexOf(groups: readonly TerminalGroup[], id: TerminalId): number {
  return groups.findIndex((group) => group.tabs.includes(id));
}

/**
 * Drops empty groups and repairs any `active` that no longer names one of its group's tabs.
 *
 * The last tab is what an orphaned `active` falls back to, rather than the first: a tab is appended
 * on the right, so the rightmost is the most recently opened and the one the user was heading for.
 */
function tidy(groups: readonly TerminalGroup[]): TerminalGroup[] {
  const next: TerminalGroup[] = [];
  for (const group of groups) {
    const fallback = group.tabs[group.tabs.length - 1];
    if (fallback === undefined) {
      continue;
    }
    next.push({
      tabs: [...group.tabs],
      active: group.tabs.includes(group.active) ? group.active : fallback,
    });
  }
  return next;
}

/**
 * Makes a proposed layout coherent with the sessions that actually exist.
 *
 * This is the one gate every layout passes through, whichever side computed it, and it answers four
 * ways a layout can be wrong:
 *
 * - it names a session that has died (a tab can close between a gesture and its round trip);
 * - it names one twice, across groups or within one (one xterm element, one place);
 * - it leaves a group empty;
 * - it **forgets** a live session. That last one is the dangerous one: a session in no group has no
 *   tab anywhere, so it is unreachable and unkillable while its process keeps running. Orphans are
 *   appended to the last group rather than dropped, which is also what makes a freshly spawned
 *   session visible before the renderer has said where it wants it.
 */
export function normalizeGroups(
  groups: readonly TerminalGroup[],
  live: readonly TerminalId[],
): TerminalGroup[] {
  const liveIds = new Set(live);
  const placed = new Set<TerminalId>();

  const kept = groups.map((group) => ({
    tabs: group.tabs.filter((id) => {
      if (!liveIds.has(id) || placed.has(id)) {
        return false;
      }
      placed.add(id);
      return true;
    }),
    active: group.active,
  }));

  const next = tidy(kept);
  const orphans = live.filter((id) => !placed.has(id));
  if (orphans.length === 0) {
    return next;
  }

  const last = next[next.length - 1];
  const active = orphans[orphans.length - 1];
  if (active === undefined) {
    return next;
  }
  if (last === undefined) {
    return [{ tabs: [...orphans], active }];
  }
  next[next.length - 1] = { tabs: [...last.tabs, ...orphans], active };
  return next;
}

/**
 * Opens a session as a new tab of one pane, and shows it.
 *
 * Appended on the right rather than next to the current tab: that is where every tab of this app has
 * appeared since the first version, and a tab that materialises mid-strip is disorienting when the
 * strip is also the history of what you launched.
 *
 * An out-of-range group index resolves to the last group instead of failing: the caller's idea of
 * which pane is focused can be one round trip behind the truth.
 */
export function addTab(
  groups: readonly TerminalGroup[],
  groupIndex: number,
  id: TerminalId,
): TerminalGroup[] {
  if (groupIndexOf(groups, id) !== -1) {
    return activateTab(groups, id);
  }
  if (groups.length === 0) {
    return [{ tabs: [id], active: id }];
  }
  const at = groupIndex >= 0 && groupIndex < groups.length ? groupIndex : groups.length - 1;
  return groups.map((group, index) =>
    index === at ? { tabs: [...group.tabs, id], active: id } : { ...group, tabs: [...group.tabs] },
  );
}

/**
 * Splits: a brand new pane, holding one session, beside the one being split.
 *
 * The session is removed from wherever it was first. In practice a split always carries a freshly
 * spawned shell so there is nothing to remove, but "the same session in two panes" is the one state
 * that cannot be allowed to exist, and a rule that only holds for the expected caller is not a rule.
 */
export function splitGroup(
  groups: readonly TerminalGroup[],
  afterIndex: number,
  id: TerminalId,
): TerminalGroup[] {
  const without = tidy(
    groups.map((group) => ({ ...group, tabs: group.tabs.filter((tab) => tab !== id) })),
  );
  const fresh: TerminalGroup = { tabs: [id], active: id };
  if (without.length === 0) {
    return [fresh];
  }
  const at = Math.min(Math.max(afterIndex, 0), without.length - 1);
  return [...without.slice(0, at + 1), fresh, ...without.slice(at + 1)];
}

/** Shows a tab in whichever pane already holds it. Clicking a tab never moves it. */
export function activateTab(groups: readonly TerminalGroup[], id: TerminalId): TerminalGroup[] {
  return groups.map((group) => ({
    tabs: [...group.tabs],
    active: group.tabs.includes(id) ? id : group.active,
  }));
}

/**
 * Moves a tab, inside its pane or into another one. This is what a drag lands on.
 *
 * `before` is the tab to land in front of, `null` to land last, and it must be read from the target
 * group's tabs **with `moved` already taken out**. Naming the neighbour rather than passing an index
 * is what removes the off-by-one that a rightwards move otherwise has: an index computed on a list
 * that still contains the dragged tab points one slot short once it leaves.
 *
 * The pane the tab came from disappears when it was its last tab, which is what makes "drag the only
 * tab of a pane elsewhere" close that pane instead of leaving a blank rectangle.
 */
export function moveTab(
  groups: readonly TerminalGroup[],
  moved: TerminalId,
  toGroup: number,
  before: TerminalId | null,
): TerminalGroup[] {
  const copy = groups.map((group) => ({ tabs: [...group.tabs], active: group.active }));
  if (groupIndexOf(groups, moved) === -1 || toGroup < 0 || toGroup >= groups.length) {
    return tidy(copy);
  }

  // Emptied groups are kept until the insertion is done, so `toGroup` still indexes the group the
  // caller aimed at even when the drag emptied one to its left.
  const stripped = copy.map((group) => ({
    tabs: group.tabs.filter((tab) => tab !== moved),
    active: group.active,
  }));
  const target = stripped[toGroup];
  if (target === undefined) {
    return tidy(copy);
  }

  const found = before === null ? -1 : target.tabs.indexOf(before);
  const at = found === -1 ? target.tabs.length : found;
  stripped[toGroup] = {
    tabs: [...target.tabs.slice(0, at), moved, ...target.tabs.slice(at)],
    active: moved,
  };
  return tidy(stripped);
}

/**
 * Closes a pane without killing anything.
 *
 * Its tabs move to a neighbour instead of being dropped: a pane is a view, a terminal is a process,
 * and taking a rectangle off the screen must never be able to stop a dev server. The neighbour is
 * the one to the left, or the one to the right for the first pane, and it adopts the closed pane's
 * active tab since that is what the user was looking at.
 *
 * The last remaining pane is not closable: there would be nowhere for its tabs to go and nothing on
 * screen afterwards.
 */
export function closeGroup(groups: readonly TerminalGroup[], index: number): TerminalGroup[] {
  const closed = groups[index];
  if (closed === undefined || groups.length <= 1) {
    return tidy(groups.map((group) => ({ tabs: [...group.tabs], active: group.active })));
  }
  const into = index === 0 ? 1 : index - 1;
  return tidy(
    groups
      .map((group, at) =>
        at === into
          ? { tabs: [...group.tabs, ...closed.tabs], active: closed.active }
          : { tabs: [...group.tabs], active: group.active },
      )
      .filter((_group, at) => at !== index),
  );
}
