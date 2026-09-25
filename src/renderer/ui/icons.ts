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

/**
 * A play triangle: the gesture is "start this run".
 *
 * A magnifier was tried first and read as "search", which is what the button is not: it launches a
 * job that takes minutes. Play is the one glyph nobody has to be taught, and it cannot be mistaken
 * for a filter or a search box.
 *
 * Stroked and not filled, unlike the marker below, because that is what separates an action from a
 * state everywhere in this app. Sized against the **rendered** 14px icon like the sync arrows: 7 by
 * 8.2 units of a 16-unit box, since a smaller triangle closes up into a blob at a 1.6 stroke.
 *
 * It lived in `triage-panel.ts` while the Triage tab was its only consumer, which is the rule that
 * keeps the sync arrows in `git-panel.ts`. The pull request review is the second, and two copies of
 * a path drift into two slightly different glyphs for one gesture.
 */
export const RUN_ICON = 'M5.6 3.9L12.6 8L5.6 12.1Z';

/**
 * The same play, smaller, with a plus beside it: "run this, on what was added".
 *
 * One glyph and not a second triangle, because two identical buttons on one row is a row where the
 * reader has to hover to find out which is which. The plus is the shape that already means "the new
 * ones" everywhere else, and it carries the whole difference between a run of several minutes and a
 * run of one.
 *
 * Sized against the **rendered** 14px icon, like every other path here: the triangle loses a third of
 * its span to make room, which is the smallest it can be before a 1.6 stroke closes it into a blob,
 * and the plus is given 6 of the 16 units so its two bars stay apart at that size.
 */
export const RUN_NEW_ICON = 'M2.9 2.6L8.2 6.2L2.9 9.8Z M11.8 8.1V14.1 M8.8 11.1H14.8';

/**
 * A coding agent: a head with an aerial.
 *
 * Deliberately not a plus and not a terminal, because it sits beside both. Starting an agent and
 * starting a shell are different acts with different consequences, and the pair only works if the two
 * glyphs cannot be confused at 13px.
 *
 * Here rather than beside one of its two callers, which is what this module is for: the tab strip's
 * launcher and the board's cards draw the same thing, and two copies of a path drift.
 */
export const AGENT_ICON =
  'M8 2v2M4.5 4.5h7v7h-7zM6.5 7v1.2M9.5 7v1.2M6.4 9.8h3.2M3 6.5v3M13 6.5v3';
