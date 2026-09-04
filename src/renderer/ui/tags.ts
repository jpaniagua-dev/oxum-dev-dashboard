import type { Project, ProjectId, TagColor, TagColors } from '@shared/contracts.js';
import { TAG_COLORS, tagColorOf } from '@shared/project-tags.js';
import { showContextMenu, type MenuItem } from './context-menu.js';
import { createElement } from './dom.js';

/**
 * How a tag is drawn on a ROW, at the two densities the strip needs.
 *
 * One module rather than a chip builder in the project table and a dot builder next to whichever tab
 * needed one first, because both reach `--tag-colour` through the same `tag--${color}` class, and that
 * class name is the drift surface: a palette entry renamed in one file and not the other paints an
 * uncoloured chip with no error anywhere.
 *
 * It is the rows and not every chip in the app: the settings window keeps its own two variants, an
 * editable chip carrying a remove button and a preview chip beside a colour select. Folding four
 * shapes into one builder behind flags is the version where every caller reads the flags to find out
 * what it gets, and only the two below are the same drawing at two sizes.
 *
 * The two densities are a deliberate pair and not a fallback of one another:
 *
 * - **The chip carries the word**, and it belongs where tags are *configured*. That is the projects
 *   table, the one surface with room for it and the only one where a tag can be edited.
 * - **The dot carries the colour alone**, and it belongs on the dense rows of the other tabs, where
 *   the question is "which stack is this line" rather than "what is this tag called". Every one of
 *   those surfaces is a fixed-width column (190px for the pull request repositories, 170px for the Git
 *   ones, a 104px grid track for a worktree's project), so a chip there would have to be paid for by
 *   widening the columns the strip is actually read in. The word is not lost: it is in the `title`, and
 *   the projects table is the legend the vocabulary was learned from.
 */

/**
 * The two gestures a chip's own context menu needs.
 *
 * Narrower than `TableActions` on purpose: the chip is handed what it can do and nothing else, so this
 * module cannot grow a dependency on the table's other twenty callbacks.
 */
export interface TagChipActions {
  /** Repaints a tag everywhere it appears. Takes no project id: the colour belongs to the tag. */
  onRecolorTag: (tag: string, color: TagColor) => void;
  /** Drops a tag from one project. The same word stays on every other project carrying it. */
  onRemoveTag: (projectId: ProjectId, tag: string) => void;
}

/**
 * The tags of a project, as chips, each in its tag's colour.
 *
 * The colour is carried by a **border and a dot**, never by the text on a coloured ground, and that is
 * what keeps a chip from reading as a sixth pill state: the status pills of the columns to the right
 * put their colour in the text. Two kinds of statement, two kinds of paint, in a row where they sit
 * side by side.
 *
 * Returns `null` rather than an empty element, so an untagged project costs no node.
 */
export function buildTagChips(
  project: Pick<Project, 'id' | 'label' | 'tags'>,
  colors: TagColors,
  actions: TagChipActions,
): HTMLElement | null {
  const tags = project.tags;
  if (tags.length === 0) {
    return null;
  }
  const host = createElement('span', { className: 'cell-tags' });
  for (const tag of tags) {
    const color = tagColorOf(colors, tag);
    const chip = createElement('span', {
      className: `tag tag--${color} tag--menu`,
      title: `${tag}\n(right-click: colour or remove)`,
    });
    chip.append(createElement('span', { className: 'tag__dot' }));
    chip.append(createElement('span', { text: tag }));

    /*
     * The chip answers its own right click, which is the fast path: two levels, and the tag is already
     * named by the thing that was aimed at. The alternative was a third level under the row's menu
     * (pick a tag, then pick a colour), and a three-deep chain of context menus for a choice among six
     * words is the version nobody uses twice.
     *
     * `stopPropagation` so the row's own menu does not also open: they would stack at the same point,
     * the second replacing the first, and the user would see the wrong one.
     */
    chip.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(
        event.clientX,
        event.clientY,
        buildTagMenuItems(project.id, project.label, tag, color, actions),
      );
    });

    host.append(chip);
  }
  return host;
}

/**
 * What can be done to one tag, from its own chip.
 *
 * The colours come first because they are why the menu exists, and the current one is **skipped**
 * rather than shown ticked: `MenuItem` has no checked state, a disabled entry in a list of six would
 * read as a colour that is unavailable, and the chip that was right-clicked is already painted in it.
 */
function buildTagMenuItems(
  projectId: ProjectId,
  label: string,
  tag: string,
  current: TagColor,
  actions: TagChipActions,
): MenuItem[] {
  const items: MenuItem[] = TAG_COLORS.filter((color) => color !== current).map((color) => ({
    label: color,
    hint: `Paints ${tag} ${color}, on every project carrying it`,
    run: () => actions.onRecolorTag(tag, color),
  }));

  // Last, being the one entry that is not about colour, and the one that changes this project rather
  // than the tag: the same word stays on every other row that carries it.
  items.push({
    label: `Remove from ${label}`,
    hint: `${tag} stays on the other projects carrying it`,
    run: () => actions.onRemoveTag(projectId, tag),
  });

  return items;
}

/** The two fields a view needs off a project to paint its tags. */
export type TaggedProject = Pick<Project, 'id' | 'tags'>;

/**
 * Everything a tab needs to paint tags it does not own.
 *
 * Threaded as one value rather than resolved by each view, so the three tabs that show dots cannot end
 * up looking a project up three different ways.
 *
 * **The projects are the source, and the tab's own payload is not widened.** `RepoPulls` and
 * `RepoWorktrees` could each have carried a `tags` field filled in the main process, and that is the
 * version to refuse: the same fact would then be stored in three shapes, and those two payloads arrive
 * from *polls* while a tag change arrives as a settings broadcast. A tag added would appear on the
 * projects table at once and in the pull request column at the next GitHub poll, which is up to a
 * minute of two tabs disagreeing about the same word. Reading the project list the renderer already
 * holds costs a `find` per row and cannot be stale.
 *
 * That the lookup always hits is a property of the main process rather than luck: the pull monitor and
 * `readAllWorktrees` are both handed `resolveProjects(...)`, the very list the renderer receives, so a
 * row can only exist for a project that is in it. `buildTagDots` answers `null` for a miss all the
 * same, an unknown id being a reason to draw nothing and not to blank a tab.
 */
export interface TagPalette {
  /** The resolved projects: the only record of which project carries which tag. */
  readonly projects: readonly TaggedProject[];
  /** `tagKey -> colour`, from the settings. */
  readonly colors: TagColors;
}

/**
 * The tags of one project as a strip of coloured dots, or `null` when it has none.
 *
 * Read-only, deliberately: a tag is *context* on these rows and configuration in the projects table,
 * which is where both gestures live. It also settles a collision the Git tab would otherwise have,
 * a right click on a repository line there already opening the repository's own menu (fetch, pull,
 * push), and a chip answering the same gesture would put two menus on one target.
 *
 * The words go in the `title`, which is what makes the dots legible at all: hovering names them, and
 * the projects table names them permanently.
 *
 * The strip is one `role="img"` carrying that same list as its label, which is the pattern the Triage
 * tab's state marker already uses: a `title` on a span with no text is announced by nothing, so the
 * dots would be a statement that exists for a sighted reader only. One image and not one per dot, for
 * the reason there is one tooltip: "front, angular" is the fact, and five images announcing a colour
 * each is a row nobody can listen to.
 */
export function buildTagDots(palette: TagPalette, projectId: ProjectId): HTMLElement | null {
  const project = palette.projects.find((entry) => entry.id === projectId);
  if (project === undefined || project.tags.length === 0) {
    return null;
  }

  const names = project.tags.join(', ');
  const host = createElement('span', {
    className: 'tag-dots',
    // One tooltip on the strip rather than one per dot: a dot is 7px, so a per-dot tooltip would be a
    // hover target nobody can aim at, and the useful reading is the set and not the third of five.
    title: names,
  });
  host.setAttribute('role', 'img');
  // Prefixed, because "front, angular" alone in the middle of a row announcing a repository and a
  // count is a pair of words with nothing saying what they are.
  host.setAttribute('aria-label', `Tags: ${names}`);
  for (const tag of project.tags) {
    host.append(
      createElement('span', {
        className: `tag-dots__dot tag--${tagColorOf(palette.colors, tag)}`,
      }),
    );
  }
  return host;
}
