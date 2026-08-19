/**
 * Icon paths shared by more than one view.
 *
 * An icon stays next to the view that draws it as long as it has a single consumer — that is why the
 * sync arrows live in `git-panel.ts` and the picker's chevron in `terminal-pane.ts`. This module exists
 * for the ones that do not: two copies of a path drift into two slightly different glyphs for the same
 * gesture, and the whole point of an icon is that it is recognised before it is read.
 */

/**
 * A terminal window with a prompt inside it.
 *
 * Drawn as a frame plus a chevron and a caret, and sized against the **rendered** 14px icon like the
 * sync arrows: the chevron is 2.2 units of a 16-unit box per barb, because anything finer comes out as
 * a hairline and the glyph stops reading as a prompt.
 *
 * Used by the Git tab's repository column and by the pull request list, which is deliberate: both
 * gestures open a new tab in a repository's folder, so they had better look identical. The pull request
 * list said `Terminal` in words until the icon existed — one label, one behaviour, and now one glyph.
 */
export const TERMINAL_ICON =
  'M2.4 3.4L13.6 3.4L13.6 12.6L2.4 12.6ZM5 6.2L7.2 8.4L5 10.6M8.8 10.6L11.4 10.6';

/**
 * Three dots, the "there is more here" glyph.
 *
 * Drawn as three **near**-zero segments rather than three zero-length ones: a subpath of length zero
 * with a round cap is a dot by the SVG specification and a blank by several renderers, which is a glyph
 * that disappears on someone else's machine. A tenth of a unit is invisible and renders everywhere.
 *
 * Used by the Worktrees tab, whose rows carry a life-cycle menu beside their own gesture. It is the
 * flat, unlabelled affordance on purpose: what it opens is three entries that all end in a terminal
 * tab, and none of them deserves its own permanent button on every row.
 */
export const MORE_ICON = 'M3.6 8L3.7 8M7.95 8L8.05 8M12.3 8L12.4 8';
