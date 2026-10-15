import { describe, expect, it } from 'vitest';
import { LANE_COLOURS, layoutGraph, type GraphCommit } from '../src/shared/git-graph.js';

/** A commit list from a compact spec: `['M:A,B', 'A:X', 'B:X', 'X:']`, newest first. */
function graph(spec: readonly string[]): GraphCommit[] {
  return spec.map((entry) => {
    const [sha = '', parents = ''] = entry.split(':');
    return { sha, parents: parents.split(',').filter((parent) => parent.length > 0) };
  });
}

/** `from>to` for each edge, which is what a failing test should print. */
function edges(list: readonly { from: number; to: number }[]): string[] {
  return list.map((edge) => `${edge.from}>${edge.to}`);
}

describe('layoutGraph', () => {
  it('keeps a linear history in one lane, with no line above the tip or below the root', () => {
    const { rows, width } = layoutGraph(graph(['C:B', 'B:A', 'A:']));

    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(edges(rows[0]?.top ?? [])).toEqual([]);
    expect(edges(rows[0]?.bottom ?? [])).toEqual(['0>0']);
    expect(edges(rows[1]?.top ?? [])).toEqual(['0>0']);
    expect(edges(rows[2]?.bottom ?? [])).toEqual([]);
    expect(width).toBe(1);
  });

  it('opens a lane for the second parent of a merge and converges both at the fork', () => {
    const { rows } = layoutGraph(graph(['M:A,B', 'B:X', 'A:X', 'X:']));
    const [merge, side, main, fork] = rows;

    expect(edges(merge?.bottom ?? [])).toEqual(['0>0', '0>1']);
    expect(side?.lane).toBe(1);
    expect(edges(side?.top ?? [])).toEqual(['0>0', '1>1']);
    expect(main?.lane).toBe(0);
    // Two lanes now wait for X: the first parent stays in its column instead of jumping.
    expect(edges(main?.bottom ?? [])).toEqual(['1>1', '0>0']);
    expect(fork?.lane).toBe(0);
    expect(edges(fork?.top ?? [])).toEqual(['0>0', '1>0']);
    expect(fork?.width).toBe(2);
  });

  it('gives the merged branch its own colour, and keeps it down to the fork', () => {
    const { rows } = layoutGraph(graph(['M:A,B', 'B:X', 'A:X', 'X:']));

    expect(rows[1]?.colour).not.toBe(rows[0]?.colour);
    expect(rows[3]?.top.find((edge) => edge.from === 1)?.colour).toBe(rows[1]?.colour);
  });

  it('draws an octopus merge with one lane per parent', () => {
    const { rows } = layoutGraph(graph(['M:A,B,C', 'C:X', 'B:X', 'A:X', 'X:']));

    expect(edges(rows[0]?.bottom ?? [])).toEqual(['0>0', '0>1', '0>2']);
    expect(edges(rows[4]?.top ?? [])).toEqual(['0>0', '1>0', '2>0']);
  });

  it('joins a parent another lane already waits for instead of opening a duplicate', () => {
    // Criss-cross: both merges have A and B as parents.
    const { rows } = layoutGraph(graph(['M1:A,B', 'M2:B,A', 'A:X', 'B:X', 'X:']));
    const second = rows[1];

    expect(second?.lane).toBe(2);
    // M2's first parent continues in its own lane like any first parent, and its second, A, is
    // already awaited by lane 0: it joins that lane rather than opening a fourth.
    expect(edges(second?.bottom ?? []).sort()).toEqual(['0>0', '1>1', '2>0', '2>2'].sort());
  });

  it('reuses a lane once its branch has closed', () => {
    // B's lane closes at X; the next tip, D, takes the freed column rather than a new one.
    const { rows } = layoutGraph(graph(['M:A,B', 'B:X', 'A:X', 'X:', 'D:Y', 'Y:']));

    expect(rows[4]?.lane).toBe(0);
    expect(rows[4]?.width).toBe(1);
  });

  it('places two unrelated tips side by side', () => {
    const { rows } = layoutGraph(graph(['A:X', 'B:Y', 'X:', 'Y:']));

    expect(rows.map((row) => row.lane)).toEqual([0, 1, 0, 1]);
  });

  it('keeps the line of a parent beyond the read limit open to the bottom', () => {
    const { rows } = layoutGraph(graph(['B:A', 'A:OUT']));

    expect(edges(rows[1]?.bottom ?? [])).toEqual(['0>0']);
  });

  it('cycles through the palette and never goes beyond it', () => {
    const tips = Array.from({ length: LANE_COLOURS + 3 }, (_, index) => `T${index}:`);
    const { rows } = layoutGraph(graph(tips));

    expect(rows.every((row) => row.colour >= 0 && row.colour < LANE_COLOURS)).toBe(true);
    expect(new Set(rows.slice(0, LANE_COLOURS).map((row) => row.colour)).size).toBe(LANE_COLOURS);
  });

  it('draws a working-tree row as a tip whose parent is HEAD', () => {
    // How the panel puts its WIP row on the graph: one more commit, nobody's parent.
    const { rows } = layoutGraph(graph(['WIP:B', 'C:A', 'B:A', 'A:']));

    expect(rows[0]?.lane).toBe(0);
    expect(rows[2]?.lane).toBe(0);
    expect(rows[1]?.lane).toBe(1);
  });

  it('lays an empty list out as nothing at all', () => {
    expect(layoutGraph([])).toEqual({ rows: [], width: 0 });
  });
});
