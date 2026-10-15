import { GIT_GRAPH_LIMIT, type GitCommit, type GitRepoState } from '@shared/contracts.js';
import { hasWorktreeChange, isStaged } from '@shared/git-changes.js';
import { layoutGraph, type GraphRow } from '@shared/git-graph.js';
import { clearChildren, createElement } from './dom.js';
import {
  describeDay,
  makeMergeDropZone,
  makeRefDraggable,
  type GitPanelActions,
  type GitPanelState,
} from './git-panel-model.js';
import { initialsOf, refChipsBySha, type RefChip } from './presenters.js';
import { visibleWindow } from './virtual-window.js';

/** Height of one graph row, in pixels. Fixed, which is what makes the list cheap to window. */
export const GRAPH_ROW_HEIGHT = 22;
/** Width of one lane. */
const LANE_WIDTH = 14;
/**
 * Lanes drawn before the graph column stops growing.
 *
 * Eight lanes is 112 px, already a fifth of a narrow centre column. A repository with more branches
 * open at once than that is rare, and the rows still say everything in their chips and subjects: the
 * extra lanes are clipped rather than allowed to push the subjects out of sight.
 */
const MAX_LANES = 8;
/** Rows built above and below the visible ones, so a scroll never shows blank space for a frame. */
const OVERSCAN = 8;
/** Stands for the working tree in the lane layout: no real sha can collide with it. */
const WIP_SHA = 'WIP';
/**
 * How many diff lines are painted.
 *
 * A generated lockfile or a bulk rename runs to tens of thousands of lines, and one element per line
 * is what makes the strip freeze. The cap is announced in the view rather than applied quietly: a
 * diff silently cut in half is worse than one that says it was cut.
 */
const MAX_DIFF_LINES = 4000;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One row of the graph: the working tree on top when it has changes, then the commits. */
type GraphEntry =
  { readonly kind: 'wip' } | { readonly kind: 'commit'; readonly commit: GitCommit };

/**
 * The centre column: the graph, or the diff that replaced it.
 *
 * The diff takes the graph's place rather than a column of its own (decided on 2026-10-15): in a
 * 460 px strip shared by four areas, a permanent diff column leaves both the graph and the diff too
 * narrow to read. `← Graph` and Escape bring the graph back, scrolled where it was.
 */
export function renderCenter(
  host: HTMLElement,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  clearChildren(host);
  if (state.target !== null) {
    renderDiffView(host, state, actions);
    return;
  }
  renderGraph(host, repo, state, actions);
}

/** The rows of the graph, the working tree first when there is something in it. */
export function graphEntries(repo: GitRepoState): GraphEntry[] {
  const commits = repo.commits.map((commit): GraphEntry => ({ kind: 'commit', commit }));
  return repo.changes.length > 0 ? [{ kind: 'wip' }, ...commits] : commits;
}

/**
 * The graph, windowed.
 *
 * Up to four hundred commits, of which about seventeen are on screen: only the visible rows (and a
 * margin) are built, absolutely positioned in a canvas as tall as the whole list so the scrollbar
 * tells the truth. A scroll repaints the rows of this column only, not the whole panel, and hands the
 * position to the app so the next rebuild (every poll) lands where the reader left it.
 */
function renderGraph(
  host: HTMLElement,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): void {
  const entries = graphEntries(repo);
  if (entries.length === 0) {
    host.append(createElement('p', { className: 'pulls__empty', text: 'No commit yet.' }));
    return;
  }

  const layout = layoutGraph(
    entries.map((entry) =>
      entry.kind === 'wip'
        ? { sha: WIP_SHA, parents: repo.headSha === null ? [] : [repo.headSha] }
        : entry.commit,
    ),
  );
  const lanes = Math.max(1, Math.min(layout.width, MAX_LANES));
  const chips = refChipsBySha(repo.refs, repo.headSha);
  const truncated = repo.commits.length >= GIT_GRAPH_LIMIT;

  const scroller = createElement('div', { className: 'git__graph' });
  scroller.style.setProperty('--git-graph-lanes-width', `${lanes * LANE_WIDTH + 6}px`);
  const canvas = createElement('div', { className: 'git__graph-canvas' });
  canvas.style.height = `${(entries.length + (truncated ? 1 : 0)) * GRAPH_ROW_HEIGHT}px`;
  scroller.append(canvas);

  const paint = (): void => {
    // A hidden tab measures zero: the overscan then still builds a screenful, which is what the first
    // paint after the tab is shown needs.
    const viewport = scroller.clientHeight > 0 ? scroller.clientHeight : 600;
    const { start, end } = visibleWindow(
      scroller.scrollTop,
      viewport,
      GRAPH_ROW_HEIGHT,
      entries.length,
      OVERSCAN,
    );
    const rows: HTMLElement[] = [];
    for (let index = start; index < end; index += 1) {
      const entry = entries[index];
      const row = layout.rows[index];
      if (entry === undefined || row === undefined) {
        continue;
      }
      const element =
        entry.kind === 'wip'
          ? buildWipRow(row, lanes, repo, state, actions)
          : buildCommitRow(
              entry.commit,
              row,
              lanes,
              chips.get(entry.commit.sha) ?? [],
              repo,
              state,
              actions,
            );
      element.style.top = `${index * GRAPH_ROW_HEIGHT}px`;
      rows.push(element);
    }
    if (truncated && end === entries.length) {
      const note = createElement('div', {
        className: 'git__graph-note',
        text: `The last ${GIT_GRAPH_LIMIT} commits. Older ones: git log, in a terminal.`,
      });
      note.style.top = `${entries.length * GRAPH_ROW_HEIGHT}px`;
      rows.push(note);
    }
    canvas.replaceChildren(...rows);
  };

  let frame: number | null = null;
  scroller.addEventListener('scroll', () => {
    actions.onScroll(scroller.scrollTop);
    if (frame === null) {
      frame = requestAnimationFrame(() => {
        frame = null;
        paint();
      });
    }
  });

  host.append(scroller);
  scroller.scrollTop = state.scrollTop;
  paint();
}

/**
 * The working tree as the first row of the graph, the way a graph client shows uncommitted work.
 *
 * Its node is hollow and dashed (nothing is committed), linked to HEAD below. A click selects it, and
 * the panel on the right becomes the staging area and the commit form. It is also a drop zone of the
 * merge gesture: it stands on top of the current branch.
 */
function buildWipRow(
  row: GraphRow,
  lanes: number,
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const selected = state.selection.kind === 'wip';
  const element = createElement('div', {
    className: `git__graph-row git__graph-row--wip${selected ? ' git__graph-row--selected' : ''}`,
  });
  const staged = repo.changes.filter(isStaged).length;
  const unstaged = repo.changes.filter(
    (change) => !isStaged(change) || hasWorktreeChange(change),
  ).length;
  element.title = `Uncommitted changes on ${repo.branch}: ${unstaged} unstaged, ${staged} staged.\nClick: stage and commit them.`;

  element.append(createElement('span', { className: 'git__graph-chips' }));
  element.append(drawLanes(row, lanes, 'wip'));
  const subject = createElement('span', {
    className: 'git__graph-subject git__graph-subject--wip',
  });
  subject.append(
    createElement('span', { text: '// WIP' }),
    createElement('span', {
      className: 'git__graph-counts',
      text: `${repo.changes.length} file(s)`,
    }),
  );
  element.append(subject);
  element.append(createElement('span', { className: 'git__graph-author' }));
  element.append(createElement('span', { className: 'git__graph-date' }));

  element.addEventListener('click', () => actions.onSelect({ kind: 'wip' }));
  makeMergeDropZone(element, state, actions);
  return element;
}

function buildCommitRow(
  commit: GitCommit,
  row: GraphRow,
  lanes: number,
  chips: readonly RefChip[],
  repo: GitRepoState,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const selected = state.selection.kind === 'commit' && state.selection.sha === commit.sha;
  const head = commit.sha === repo.headSha;
  const element = createElement('div', {
    className: `git__graph-row${selected ? ' git__graph-row--selected' : ''}${head ? ' git__graph-row--head' : ''}`,
  });
  const refs = chips.map((chip) => chip.label).join(', ');
  element.title = `${commit.subject}\n${commit.author}, ${commit.date}\n${commit.sha.slice(0, 7)}${
    refs.length > 0 ? `\n${refs}` : ''
  }\nClick: details. Right click: cherry-pick, copy, undo.`;

  element.append(buildChips(chips, row.colour, state, actions));
  element.append(
    drawLanes(row, lanes, commit.parents.length > 1 ? 'merge' : head ? 'head' : 'commit'),
  );
  element.append(
    createElement('span', { className: 'git__graph-subject', text: commit.subject }),
    createElement('span', {
      className: 'git__graph-author',
      text: initialsOf(commit.author),
      title: commit.author,
    }),
    createElement('span', { className: 'git__graph-date', text: describeDay(commit.date) }),
  );

  element.addEventListener('click', () => actions.onSelect({ kind: 'commit', sha: commit.sha }));
  element.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    actions.onCommitMenu(commit, event.clientX, event.clientY);
  });
  if (chips.some((chip) => chip.current)) {
    makeMergeDropZone(element, state, actions);
  }
  return element;
}

/**
 * The labels of a commit, in the column left of the graph.
 *
 * The first chip in full, then `+n` for the rest with the whole list in its tooltip: a column of
 * chips wider than its content would push the subjects out, and the subject is what the row is for.
 * A branch chip is a drag source for the merge, and checks out on a double-click, like its row in the
 * refs panel.
 */
function buildChips(
  chips: readonly RefChip[],
  colour: number,
  state: GitPanelState,
  actions: GitPanelActions,
): HTMLElement {
  const cell = createElement('span', { className: 'git__graph-chips' });
  const [first, ...rest] = chips;
  if (first === undefined) {
    return cell;
  }
  const chip = createElement('span', {
    className: `git__chip git__chip--${first.kind} git__lane-border--${colour}${first.current ? ' git__chip--current' : ''}`,
    text: first.label,
  });
  if (first.remotes.length > 0 && first.local !== null) {
    chip.append(createElement('span', { className: 'git__chip-remote', text: '⇅' }));
  }
  chip.title = describeChip(first);
  const branch = first.local ?? first.remotes[0] ?? null;
  if (first.kind === 'branch' && branch !== null) {
    makeRefDraggable(chip, branch, actions);
    if (!first.current) {
      chip.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        if (!state.busy) {
          actions.onCheckout(branch);
        }
      });
    }
  }
  cell.append(chip);

  if (rest.length > 0) {
    cell.append(
      createElement('span', {
        className: 'git__chip-more',
        text: `+${rest.length}`,
        title: rest.map(describeChip).join('\n\n'),
      }),
    );
  }
  return cell;
}

function describeChip(chip: RefChip): string {
  if (chip.kind === 'head') {
    return 'HEAD, detached: no branch is checked out.';
  }
  if (chip.kind === 'tag') {
    return `Tag ${chip.label}`;
  }
  const remotes = chip.remotes.map((remote) => remote.name).join(', ');
  if (chip.local === null) {
    return `${chip.label}, a remote branch.\nDouble-click: check it out as a local branch. Drag onto the current branch: merge.`;
  }
  const synced = remotes.length > 0 ? `\nSame commit as ${remotes}.` : '';
  return chip.current
    ? `${chip.label}, checked out.${synced}\nDrop another branch here to merge it.`
    : `${chip.label}${synced}\nDouble-click: check out. Drag onto the current branch: merge.`;
}

/**
 * Draws one row's slice of the graph.
 *
 * Two halves, as the layout computes them: segments from the top of the row to the node's height,
 * then from there to the bottom. A straight segment stays in its lane; a segment changing lanes is a
 * curve, so a branch leaving or joining reads as a bend rather than a zig-zag. The colour comes from
 * a class, the palette living in the tokens with a value per theme.
 */
function drawLanes(
  row: GraphRow,
  lanes: number,
  node: 'commit' | 'head' | 'merge' | 'wip',
): SVGSVGElement {
  const width = lanes * LANE_WIDTH + 6;
  const height = GRAPH_ROW_HEIGHT;
  const middle = height / 2;
  const x = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2 + 3;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'git__graph-lanes');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-hidden', 'true');

  const segment = (from: number, to: number, y1: number, y2: number, colour: number): void => {
    if (from >= MAX_LANES && to >= MAX_LANES) {
      return;
    }
    const path = document.createElementNS(SVG_NS, 'path');
    const x1 = x(from);
    const x2 = x(to);
    const ym = (y1 + y2) / 2;
    path.setAttribute(
      'd',
      from === to ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`,
    );
    path.setAttribute(
      'class',
      `git__lane-stroke--${colour}${node === 'wip' && y1 === middle ? ' git__lane-stroke--dashed' : ''}`,
    );
    svg.append(path);
  };
  for (const edge of row.top) {
    segment(edge.from, edge.to, 0, middle, edge.colour);
  }
  for (const edge of row.bottom) {
    segment(edge.from, edge.to, middle, height, edge.colour);
  }

  if (row.lane < MAX_LANES) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(x(row.lane)));
    circle.setAttribute('cy', String(middle));
    circle.setAttribute('r', node === 'merge' ? '3' : '4.5');
    circle.setAttribute(
      'class',
      node === 'wip'
        ? `git__node git__node--wip git__lane-stroke--${row.colour}`
        : `git__node git__lane-fill--${row.colour}${node === 'head' ? ' git__node--head' : ''}`,
    );
    svg.append(circle);
  }
  return svg;
}

/* ------------------------------------------------------------------ diff */

/**
 * The diff, in the graph's place.
 *
 * One view for a working-tree file, a commit file and a stash file, because all three are unified
 * diffs and the question is the same. The line numbers are shown in two gutters rather than one: a
 * diff is a statement about two files at once, and a single column would have to lie about one.
 */
function renderDiffView(host: HTMLElement, state: GitPanelState, actions: GitPanelActions): void {
  const view = createElement('div', { className: 'git__diff' });
  view.append(buildDiffHeader(state, actions));

  const diff = state.diff;
  if (diff === null) {
    view.append(createElement('p', { className: 'pulls__empty', text: 'Reading…' }));
    host.append(view);
    return;
  }
  if (diff.note !== null) {
    view.append(createElement('p', { className: 'pulls__empty', text: diff.note }));
    host.append(view);
    return;
  }

  const scroller = createElement('div', { className: 'git__diff-body' });
  const body = createElement('div', { className: 'diff' });
  for (const line of diff.lines.slice(0, MAX_DIFF_LINES)) {
    const row = createElement('div', { className: `diff__line diff__line--${line.kind}` });
    row.append(
      createElement('span', {
        className: 'diff__gutter',
        text: line.oldLine === null ? '' : String(line.oldLine),
      }),
      createElement('span', {
        className: 'diff__gutter',
        text: line.newLine === null ? '' : String(line.newLine),
      }),
      createElement('span', { className: 'diff__text', text: line.text }),
    );
    body.append(row);
  }
  scroller.append(body);
  if (diff.lines.length > MAX_DIFF_LINES) {
    // Announced rather than silent: a truncated diff that says nothing reads as a complete one.
    scroller.append(
      createElement('p', {
        className: 'pulls__empty',
        text: `Diff truncated: ${MAX_DIFF_LINES} lines out of ${diff.lines.length}. Open it in the terminal for the rest.`,
      }),
    );
  }
  view.append(scroller);
  host.append(view);
}

/**
 * The diff's heading: the way back, the file, and the index/disk switch when both sides exist.
 *
 * The switch only appears for a file that is staged **and** modified again, which is the one case
 * where "the diff of this file" has two different answers and picking one silently would hide the
 * other. Everywhere else there is nothing to choose and no button.
 */
function buildDiffHeader(state: GitPanelState, actions: GitPanelActions): HTMLElement {
  const header = createElement('div', { className: 'git__diff-head' });

  const back = createElement('button', {
    className: 'button button--quiet',
    text: '← Graph',
    title: 'Back to the graph (Escape)',
  });
  back.type = 'button';
  back.addEventListener('click', () => actions.onCloseDiff());
  header.append(back);

  const target = state.target;
  const title =
    state.diff?.title ?? (target === null ? '' : 'path' in target ? target.path : target.sha);
  header.append(
    createElement('span', { className: 'git__diff-title path-clip-start', text: title }),
  );

  if (target?.kind !== 'file') {
    return header;
  }
  const change = state.repo?.changes.find((entry) => entry.path === target.path);
  if (change === undefined || !isStaged(change) || !hasWorktreeChange(change)) {
    return header;
  }
  header.append(createElement('span', { className: 'git__spacer' }));
  const toggle = createElement('button', {
    className: 'button button--quiet',
    text: target.staged ? 'Show the disk' : 'Show the index',
    title: target.staged
      ? 'Shows the unstaged changes (git diff)'
      : 'Shows what is staged (git diff --cached)',
  });
  toggle.type = 'button';
  toggle.addEventListener('click', () =>
    actions.onOpenDiff({ kind: 'file', path: target.path, staged: !target.staged }),
  );
  header.append(toggle);
  return header;
}
