import { describe, expect, it } from 'vitest';
import type { TerminalGroup } from '../src/shared/contracts.js';
import {
  activateTab,
  addTab,
  closeGroup,
  groupIndexOf,
  moveTab,
  normalizeGroups,
  splitGroup,
} from '../src/shared/terminal-groups.js';

const group = (tabs: string[], active: string): TerminalGroup => ({ tabs, active });

/** Every tab of a layout, in display order. Used to assert that nothing is lost or duplicated. */
function allTabs(groups: readonly TerminalGroup[]): string[] {
  return groups.flatMap((entry) => entry.tabs);
}

/** The two invariants, checked as a pair because breaking one usually breaks the other. */
function expectSane(groups: readonly TerminalGroup[]): void {
  const tabs = allTabs(groups);
  expect(new Set(tabs).size).toBe(tabs.length);
  for (const entry of groups) {
    expect(entry.tabs.length).toBeGreaterThan(0);
    expect(entry.tabs).toContain(entry.active);
  }
}

describe('normalizeGroups', () => {
  it('keeps a sane layout untouched', () => {
    const groups = [group(['a', 'b'], 'b'), group(['c'], 'c')];
    expect(normalizeGroups(groups, ['a', 'b', 'c'])).toEqual(groups);
  });

  it('drops a session that has died', () => {
    const result = normalizeGroups([group(['a', 'b'], 'b')], ['a']);
    expect(result).toEqual([group(['a'], 'a')]);
  });

  it('drops a pane left with no tab at all', () => {
    const result = normalizeGroups([group(['a'], 'a'), group(['b'], 'b')], ['b']);
    expect(result).toEqual([group(['b'], 'b')]);
  });

  it('never shows one session in two panes', () => {
    // A session owns a single xterm element: two panes would mean detaching it, which kills it.
    const result = normalizeGroups([group(['a', 'b'], 'a'), group(['a'], 'a')], ['a', 'b']);
    expectSane(result);
    expect(allTabs(result)).toEqual(['a', 'b']);
  });

  it('adopts a session that belongs to no pane rather than losing it', () => {
    // The dangerous case: a session in no group has no tab anywhere, so its process runs on with
    // nothing able to show or stop it. This is also how a freshly spawned tab becomes visible.
    const result = normalizeGroups([group(['a'], 'a')], ['a', 'new']);
    expect(result).toEqual([group(['a', 'new'], 'new')]);
  });

  it('builds a first pane out of nothing', () => {
    expect(normalizeGroups([], ['a'])).toEqual([group(['a'], 'a')]);
  });

  it('is empty only when there is no session at all', () => {
    expect(normalizeGroups([group(['a'], 'a')], [])).toEqual([]);
  });

  it('repairs an active that names a tab the pane no longer has', () => {
    expect(normalizeGroups([group(['a', 'b'], 'gone')], ['a', 'b'])).toEqual([
      group(['a', 'b'], 'b'),
    ]);
  });
});

describe('addTab', () => {
  it('appends to the named pane and shows the new tab', () => {
    const result = addTab([group(['a'], 'a'), group(['b'], 'b')], 0, 'c');
    expect(result).toEqual([group(['a', 'c'], 'c'), group(['b'], 'b')]);
  });

  it('falls back to the last pane when the index is stale', () => {
    // The caller's idea of which pane is focused can be one round trip behind the truth.
    expect(addTab([group(['a'], 'a')], 7, 'b')).toEqual([group(['a', 'b'], 'b')]);
  });

  it('only shows a tab that is already open, never duplicates it', () => {
    const result = addTab([group(['a', 'b'], 'a'), group(['c'], 'c')], 1, 'b');
    expect(result).toEqual([group(['a', 'b'], 'b'), group(['c'], 'c')]);
  });

  it('starts a layout from nothing', () => {
    expect(addTab([], 0, 'a')).toEqual([group(['a'], 'a')]);
  });
});

describe('splitGroup', () => {
  it('opens a new pane right after the one being split', () => {
    const result = splitGroup([group(['a'], 'a'), group(['b'], 'b')], 0, 'c');
    expect(result).toEqual([group(['a'], 'a'), group(['c'], 'c'), group(['b'], 'b')]);
  });

  it('takes the tab out of its old pane when it already had one', () => {
    // What "move this tab to a pane of its own" is: the same session cannot be in two panes.
    const result = splitGroup([group(['a', 'b'], 'a')], 0, 'b');
    expect(result).toEqual([group(['a'], 'a'), group(['b'], 'b')]);
    expectSane(result);
  });

  it('drops the pane it emptied instead of leaving a blank rectangle', () => {
    const result = splitGroup([group(['a'], 'a'), group(['b'], 'b')], 1, 'a');
    expect(result).toEqual([group(['b'], 'b'), group(['a'], 'a')]);
  });

  it('starts a layout from nothing', () => {
    expect(splitGroup([], 0, 'a')).toEqual([group(['a'], 'a')]);
  });
});

describe('activateTab', () => {
  it('shows a tab in the pane that already holds it', () => {
    const result = activateTab([group(['a', 'b'], 'a'), group(['c'], 'c')], 'b');
    expect(result).toEqual([group(['a', 'b'], 'b'), group(['c'], 'c')]);
  });

  it('never moves a tab between panes', () => {
    const groups = [group(['a'], 'a'), group(['b'], 'b')];
    expect(allTabs(activateTab(groups, 'b'))).toEqual(['a', 'b']);
  });

  it('ignores a tab that vanished', () => {
    const groups = [group(['a'], 'a')];
    expect(activateTab(groups, 'gone')).toEqual(groups);
  });
});

describe('moveTab', () => {
  const TWO = [group(['a', 'b', 'c'], 'a'), group(['x', 'y'], 'x')];

  it('reorders inside a pane', () => {
    expect(moveTab(TWO, 'a', 0, 'c')).toEqual([group(['b', 'a', 'c'], 'a'), group(['x', 'y'], 'x')]);
  });

  it('moves a tab to the end of a pane when nothing follows it', () => {
    expect(moveTab(TWO, 'a', 0, null)).toEqual([group(['b', 'c', 'a'], 'a'), group(['x', 'y'], 'x')]);
  });

  it('moves a tab into another pane and shows it there', () => {
    expect(moveTab(TWO, 'b', 1, 'y')).toEqual([
      group(['a', 'c'], 'a'),
      group(['x', 'b', 'y'], 'b'),
    ]);
  });

  it('repairs the pane it left when its active tab is the one that moved', () => {
    expect(moveTab([group(['a', 'b'], 'b'), group(['x'], 'x')], 'b', 1, null)).toEqual([
      group(['a'], 'a'),
      group(['x', 'b'], 'b'),
    ]);
  });

  it('closes the pane a tab was the last of', () => {
    // Dragging the only tab of a pane elsewhere must not leave a blank rectangle behind.
    const result = moveTab([group(['a'], 'a'), group(['x'], 'x')], 'a', 1, 'x');
    expect(result).toEqual([group(['a', 'x'], 'a')]);
  });

  it('appends when the target neighbour vanished mid-drag', () => {
    // The pane it left falls back to its last tab, not the dragged tab's neighbour: `tidy` repairs a
    // layout without knowing what happened to it, and "last" is the convention everywhere else.
    expect(moveTab(TWO, 'a', 1, 'gone')).toEqual([
      group(['b', 'c'], 'c'),
      group(['x', 'y', 'a'], 'a'),
    ]);
  });

  it('changes nothing when the dragged tab or the target pane is gone', () => {
    expect(moveTab(TWO, 'gone', 0, null)).toEqual(TWO);
    expect(moveTab(TWO, 'a', 9, null)).toEqual(TWO);
  });

  it('never loses or duplicates a tab, wherever it lands', () => {
    const before = allTabs(TWO).sort();
    for (const moved of allTabs(TWO)) {
      for (let toGroup = 0; toGroup < TWO.length; toGroup += 1) {
        for (const target of [...allTabs(TWO), null]) {
          const result = moveTab(TWO, moved, toGroup, target);
          expectSane(result);
          expect(allTabs(result).sort()).toEqual(before);
        }
      }
    }
  });
});

describe('closeGroup', () => {
  it('hands the tabs to the pane on the left rather than killing them', () => {
    // A pane is a view, a terminal is a process: closing a rectangle must never stop a dev server.
    const result = closeGroup([group(['a'], 'a'), group(['b', 'c'], 'c')], 1);
    expect(result).toEqual([group(['a', 'b', 'c'], 'c')]);
  });

  it('hands them to the right when the first pane is closed', () => {
    const result = closeGroup([group(['a'], 'a'), group(['b'], 'b')], 0);
    expect(result).toEqual([group(['b', 'a'], 'a')]);
  });

  it('refuses to close the last pane, which would leave nothing on screen', () => {
    const groups = [group(['a'], 'a')];
    expect(closeGroup(groups, 0)).toEqual(groups);
  });

  it('ignores an index that is not a pane', () => {
    const groups = [group(['a'], 'a'), group(['b'], 'b')];
    expect(closeGroup(groups, 5)).toEqual(groups);
  });
});

describe('groupIndexOf', () => {
  it('finds the pane holding a session', () => {
    expect(groupIndexOf([group(['a'], 'a'), group(['b', 'c'], 'b')], 'c')).toBe(1);
  });

  it('reports -1 for a session in no pane', () => {
    expect(groupIndexOf([group(['a'], 'a')], 'zzz')).toBe(-1);
  });
});
