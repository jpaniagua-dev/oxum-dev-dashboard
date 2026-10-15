/**
 * Lays a commit list out in lanes, the columns a graph draws its branches in.
 *
 * Pure and DOM-free so it can be tested on its own: the drawing is only the last step, and every bug a
 * graph has (a line that never closes, a merge that lands in the wrong column, two branches sharing a
 * colour) is a bug of this function, not of the SVG.
 *
 * The algorithm is the one `git log --graph` uses, reduced to what a row needs:
 *
 * - **A lane waits for a sha.** Going down the list, each active lane holds the parent its line is
 *   heading for. A commit takes the leftmost lane waiting for it; a commit nobody waits for is a
 *   branch tip and opens a lane, reusing the leftmost free one.
 * - **Several lanes waiting for the same commit converge on it** and the others close: that is two
 *   branches meeting at their common ancestor, drawn as a diagonal in the upper half of the row.
 * - **The first parent continues in the commit's own lane**, even when another lane already waits
 *   for it: the two will converge at that parent, which keeps a branch straight down to where it
 *   forked instead of jumping columns at its last commit.
 * - **Every other parent of a merge** joins the lane already waiting for it, or opens a new one.
 * - **A parent that never shows up** (beyond the read limit) keeps its lane open to the bottom of the
 *   list, which is the honest drawing of "this line continues further than what was read".
 *
 * Lanes are never compacted: a lane keeps its column for as long as it is open, so a line never
 * shifts sideways for a reason that has nothing to do with it. Trailing free lanes are trimmed.
 */

/** How many distinct colours the lanes cycle through; the palette lives in the CSS tokens. */
export const LANE_COLOURS = 8;

/** The minimum a commit has to say about itself to be placed. */
export interface GraphCommit {
  readonly sha: string;
  readonly parents: readonly string[];
}

/** A line segment within one half of a row, from one lane to another. */
export interface GraphEdge {
  /** Lane at the start of the half: the top of the row, or the node for the lower half. */
  readonly from: number;
  /** Lane at the end of the half: the node for the upper half, or the bottom of the row. */
  readonly to: number;
  /** Index into the lane palette, `0` to `LANE_COLOURS - 1`. */
  readonly colour: number;
}

export interface GraphRow {
  /** Lane of the commit's node. */
  readonly lane: number;
  /** Colour of the commit's node, which is its lane's. */
  readonly colour: number;
  /** Segments from the top of the row down to its middle: lines passing through, or converging. */
  readonly top: readonly GraphEdge[];
  /** Segments from the middle down to the bottom: lines passing through, or leaving for a parent. */
  readonly bottom: readonly GraphEdge[];
  /** Number of lanes this row spans, the rightmost one in use plus one. */
  readonly width: number;
}

export interface GraphLayout {
  readonly rows: readonly GraphRow[];
  /** The widest row, which sizes the graph column. */
  readonly width: number;
}

/** One open lane: the sha it is heading for and the colour it was given when it opened. */
interface Lane {
  readonly waitsFor: string;
  readonly colour: number;
}

export function layoutGraph(commits: readonly GraphCommit[]): GraphLayout {
  let lanes: (Lane | null)[] = [];
  let nextColour = 0;
  const rows: GraphRow[] = [];
  let width = 0;

  const open = (at: number, waitsFor: string, colour?: number): Lane => {
    const lane = { waitsFor, colour: colour ?? nextColour++ % LANE_COLOURS };
    while (lanes.length < at) {
      lanes.push(null);
    }
    lanes[at] = lane;
    return lane;
  };
  const firstFree = (): number => {
    const free = lanes.indexOf(null);
    return free === -1 ? lanes.length : free;
  };

  for (const commit of commits) {
    const before = lanes;
    const waiting = before.flatMap((lane, index) => (lane?.waitsFor === commit.sha ? [index] : []));

    let node: number;
    let colour: number;
    lanes = [...before];
    if (waiting.length === 0) {
      node = firstFree();
      colour = open(node, commit.sha).colour;
    } else {
      node = waiting[0] ?? 0;
      colour = before[node]?.colour ?? 0;
    }

    const top: GraphEdge[] = [];
    before.forEach((lane, index) => {
      if (lane === null) {
        return;
      }
      top.push({
        from: index,
        to: lane.waitsFor === commit.sha ? node : index,
        colour: lane.colour,
      });
    });

    // Every lane that was waiting for this commit has arrived: they close, the node's own lane
    // reopens below for the first parent.
    for (const index of waiting) {
      lanes[index] = null;
    }
    if (waiting.length === 0) {
      lanes[node] = null;
    }

    const bottom: GraphEdge[] = [];
    lanes.forEach((lane, index) => {
      if (lane !== null) {
        bottom.push({ from: index, to: index, colour: lane.colour });
      }
    });

    commit.parents.forEach((parent, position) => {
      if (position === 0) {
        open(node, parent, colour);
        bottom.push({ from: node, to: node, colour });
        return;
      }
      const existing = lanes.findIndex((lane) => lane?.waitsFor === parent);
      if (existing !== -1) {
        bottom.push({ from: node, to: existing, colour: lanes[existing]?.colour ?? colour });
        return;
      }
      const at = firstFree();
      const opened = open(at, parent);
      bottom.push({ from: node, to: at, colour: opened.colour });
    });

    lanes = trimFree(lanes);
    const rowWidth = Math.max(before.length, lanes.length, node + 1);
    width = Math.max(width, rowWidth);
    rows.push({ lane: node, colour, top, bottom, width: rowWidth });
  }

  return { rows, width };
}

/** Drops the free lanes at the right end, so a closed branch stops widening every row below it. */
function trimFree(lanes: (Lane | null)[]): (Lane | null)[] {
  let end = lanes.length;
  while (end > 0 && lanes[end - 1] === null) {
    end -= 1;
  }
  return lanes.slice(0, end);
}
