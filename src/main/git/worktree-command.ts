import type { WorktreeCommand } from '@shared/contracts.js';

/**
 * Builds the command line that creates, renames or removes a worktree.
 *
 * Separate from `ipc.ts` for the reason `work-command.ts` is: `ipc.ts` imports Electron at module
 * level, so testing anything living in it would drag Electron into the test run. And what is decided
 * here is a command line that **deletes folders**, which is worth pinning by test rather than read back
 * off a terminal once.
 *
 * ## Why a helper and not `git worktree remove`
 *
 * This tab used to create and remove nothing, on the grounds that the life cycle has rules a list would
 * have to reimplement to be trustworthy: a shared `node_modules` junction to unlink **before**
 * `git worktree remove` (removing it after leaves the junction behind as an orphan), a refusal on a
 * folder git no longer knows about, a stale registration to prune rather than delete. Those rules did
 * not go away; they moved into a shell helper that already implements them, is used from the terminal
 * every day, and is what this tab was drawn from in the first place.
 *
 * So the tab spawns the helper instead of racing it. That is the same choice the Jira tab makes with
 * `dev <TICKET>`: it does not create a branch itself, it runs the command the user would have typed. A
 * second implementation of these rules in TypeScript is the failure this codebase has already paid for
 * twice, with `verdictFor` and `isStaged` drifting next to their twin.
 */

/**
 * Name of the shell helper, called bare so the shell resolves it.
 *
 * A bare name and never a path: the helper is a shell **function** (it has to be, a `cd` in a subshell
 * dies with the subshell), sourced from the profile the terminal already starts with. Hard-coding where
 * someone's dotfiles keep it would work on exactly one machine.
 *
 * A machine without it gets `wt: command not found` in the tab, which is the honest failure: it names
 * what is missing, in the place the command was going to run. Exactly what `dev <TICKET>` does.
 */
export const WORKTREE_HELPER = 'wt';

/**
 * What a name may contain before it is allowed onto a command line.
 *
 * A whitelist and not an escape, for the reason `ISSUE_KEY_PATTERN` is one: this string ends up in
 * `bash -ic`, and the only quoting bug that matters here is the one that removes the wrong folder. A
 * name that does not match is refused with a message pointing at the terminal, rather than quoted and
 * hoped for.
 *
 * Every name the tab can produce is a folder basename read back from `git worktree list`, so in
 * practice this rejects nothing. It is the guard that keeps that true.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Longest description accepted for a new worktree, past which the branch name stops being readable. */
const MAX_DESCRIPTION = 80;

/**
 * Anchors a folder name so the helper matches that worktree and no other.
 *
 * The helper takes a **pattern**, matched unanchored against the label, the repository and the branch of
 * every worktree it knows. Handing it a bare `TEC-175` would match `TEC-1750` too, and the helper would
 * refuse on the ambiguity: safe, but it turns a click into a trip to the terminal. Anchored, the name
 * matches itself and stops.
 *
 * If the helper ever stopped treating its argument as a regular expression, an anchored pattern would
 * match **nothing**, which it reports as "no worktree matches" and does not act on. That is the
 * direction worth being wrong in.
 */
export function anchorPattern(name: string): string {
  return `^${name}$`;
}

/**
 * POSIX single-quoting, for the one argument that is free text.
 *
 * The description is the only value here not already reduced to `SAFE_NAME`, and it is passed quoted
 * rather than trusted: `'` closes the quote, so it becomes the four characters that reopen it. Belt over
 * braces, the braces being `sanitizeDescription`.
 */
export function shellQuote(value: string): string {
  const escaped = value.split("'").join("'\\''");
  return `'${escaped}'`;
}

/**
 * Reduces a typed description to what a branch name can be built from.
 *
 * The helper kebab-cases it anyway, so whatever it would drop is dropped here instead, where it can be
 * tested: everything outside letters, digits, space, dot, hyphen and underscore goes, runs of whitespace
 * collapse, and the result is capped. A description that empties out comes back empty, and the caller
 * decides what that means: it is required for a ticket label and meaningless for a slug one.
 */
export function sanitizeDescription(text: string): string {
  return text
    .replace(/[^A-Za-z0-9 ._-]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_DESCRIPTION)
    .trim();
}

/** True when a label names a ticket, which is the one case where a description is mandatory. */
export function isTicketLabel(label: string): boolean {
  return /^[A-Za-z]{2,10}-\d+$/.test(label);
}

/**
 * Splits one typed line into the label and the description the helper takes as two arguments.
 *
 * One field rather than two, because the two are one thought: `PROJ-123 documents list` is how the
 * command is typed in the terminal and how the convention reads back off the branch name. A label with
 * no ticket number needs no description, the label itself being the slug.
 *
 * Pure and exported: a split that puts the first word in the wrong argument produces a plausible
 * worktree on a wrong branch, which is the kind of thing nobody notices until the pull request.
 */
export function parseCreateInput(text: string): { label: string; description: string } {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  const cut = trimmed.indexOf(' ');
  return cut === -1
    ? { label: trimmed, description: '' }
    : { label: trimmed.slice(0, cut), description: sanitizeDescription(trimmed.slice(cut + 1)) };
}

/**
 * Reads an IPC payload back into a `WorktreeCommand`, or refuses it.
 *
 * The renderer is trusted here about as far as it is anywhere else in this file: `invoke` carries
 * whatever the caller passed, a preload bridge is not a validator, and the payload decides whether a
 * folder is deleted. Anything not matching the shape comes back `null` and the handler answers "invalid
 * command" without opening a tab.
 *
 * The two booleans are read strictly (`=== true`) rather than coerced: a `discardChanges` that arrived
 * as the string `"false"` would be truthy, and the flag it sets throws away uncommitted work.
 */
export function parseWorktreeCommand(value: unknown): WorktreeCommand | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (label.length === 0) {
    return null;
  }

  if (raw.kind === 'remove') {
    return {
      kind: 'remove',
      label,
      discardChanges: raw.discardChanges === true,
      deleteBranch: raw.deleteBranch === true,
    };
  }
  if (raw.kind === 'rename') {
    const newLabel = typeof raw.newLabel === 'string' ? raw.newLabel.trim() : '';
    return newLabel.length === 0 ? null : { kind: 'rename', label, newLabel };
  }
  if (raw.kind === 'create') {
    return {
      kind: 'create',
      label,
      description: typeof raw.description === 'string' ? raw.description : '',
    };
  }
  return null;
}

/** Either the line to run or why nothing will be run, never both. */
export type BuiltCommand =
  | { readonly command: string; readonly error?: undefined }
  | { readonly command?: undefined; readonly error: string };

/**
 * Turns a gesture from the Worktrees tab into the helper invocation it stands for.
 *
 * `repoFolder` is the **basename of the configured project's path**, not its label: the label is
 * whatever the row was renamed to, while the helper addresses a repository by the folder it is cloned
 * into. Passing the label would create the worktree in a repository that does not exist, or worse, in
 * one that does.
 *
 * The flags are not decoration. `-f` discards uncommitted work and is only ever offered on a row the
 * list has just shown as dirty; `-d` deletes the branch, and the helper keeps an unmerged branch and
 * says so rather than forcing it. Neither is implied by a bare removal, which is why they are separate
 * menu entries and not one "remove" that guesses.
 */
export function buildWorktreeCommand(command: WorktreeCommand, repoFolder: string): BuiltCommand {
  if (command.kind === 'create') {
    if (!SAFE_NAME.test(repoFolder)) {
      return { error: `Repository folder "${repoFolder}" cannot be passed to ${WORKTREE_HELPER}` };
    }
    const label = command.label.trim();
    if (!SAFE_NAME.test(label)) {
      return { error: 'A label is letters, digits, dots, dashes or underscores' };
    }
    const description = sanitizeDescription(command.description);
    if (isTicketLabel(label) && description.length === 0) {
      // The helper refuses this too, and its message is the better one. Refusing here as well puts the
      // refusal on the field being typed, rather than in a tab that opens only to complain.
      return { error: `A ticket worktree needs a description: ${label} <what it is about>` };
    }
    const parts = [WORKTREE_HELPER, 'new', repoFolder, label];
    if (description.length > 0) {
      parts.push(shellQuote(description));
    }
    return { command: parts.join(' ') };
  }

  if (!SAFE_NAME.test(command.label)) {
    return { error: `"${command.label}" is not a name this can pass to ${WORKTREE_HELPER}` };
  }
  const pattern = shellQuote(anchorPattern(command.label));

  if (command.kind === 'rename') {
    const target = command.newLabel.trim();
    if (!SAFE_NAME.test(target)) {
      return { error: 'A new label is letters, digits, dots, dashes or underscores' };
    }
    return { command: `${WORKTREE_HELPER} mv ${pattern} ${target}` };
  }

  const flags = [
    ...(command.discardChanges ? ['-f'] : []),
    ...(command.deleteBranch ? ['-d'] : []),
  ];
  return { command: [WORKTREE_HELPER, 'rm', pattern, ...flags].join(' ') };
}
