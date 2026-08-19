/**
 * The prompt that turns a staged diff into a commit message, and the reading of what comes back.
 *
 * Pure and separate from the run for the reason `work-command.ts` is separate from `ipc.ts`: what is
 * decided here is what the model is told and what is believed of its answer, and both are worth
 * pinning by test rather than judged from one good result.
 *
 * ## Why the diff is in the prompt rather than fetched
 *
 * The headless run is allowed `Read`, `Grep` and `Glob` and nothing else, because an analysis is not a
 * change. Letting it call `git diff` itself would mean granting `Bash`, and a run that can call git can
 * call git for things nobody asked for. So the app reads the diff and hands it over, which also makes
 * the run reproducible: the same diff produces the same prompt, and the prompt is a string a test can
 * hold.
 *
 * ## Why the run happens in the repository
 *
 * Claude Code reads `CLAUDE.md` from the folder it starts in and from its ancestors, so a run started
 * in the repository picks up **that repository's own commit convention** without this app knowing what
 * it is. That is the whole reason this beats a template: the convention lives where the team wrote it,
 * not in a format string here. The recent subjects below are the fallback for a repository that
 * documents nothing, which is most of them.
 *
 * This is the opposite of the `Work on this` handoff, which starts one level **up** so a session
 * inherits what several repositories share. The two are not inconsistent: that one needs the workspace's
 * skills, this one needs one repository's convention and would be actively misled by a sibling's.
 */

/**
 * How much diff is sent.
 *
 * A staged change can be a lock file or a generated bundle, and megabytes of it says nothing a commit
 * message needs. Truncation is **announced in the prompt** rather than silent: a model told it is
 * looking at part of a change writes a subject about the part it saw, whereas one that believes it has
 * everything writes a confident summary of a fraction.
 */
export const MAX_DIFF_CHARS = 60_000;

/** How many recent subjects go in as observed convention. Enough to show a pattern, short enough to read. */
export const RECENT_SUBJECTS = 10;

/** Longest answer accepted as a commit message, past which something other than a message came back. */
const MAX_MESSAGE_CHARS = 4000;

export interface CommitPromptInput {
  /** Output of `git diff --cached`, or of `git show` when an amend is being reworded. */
  readonly diff: string;
  /** Subjects of the most recent commits, newest first, as the convention actually practised here. */
  readonly recentSubjects: readonly string[];
  /** Branch name, which is where a ticket key usually is. */
  readonly branch: string;
  /** True when the message is replacing the last commit's rather than describing a new one. */
  readonly amend: boolean;
}

/** The diff, capped, with a line saying so when it was. */
export function capDiff(diff: string): { text: string; truncated: boolean } {
  return diff.length <= MAX_DIFF_CHARS
    ? { text: diff, truncated: false }
    : { text: diff.slice(0, MAX_DIFF_CHARS), truncated: true };
}

/**
 * Builds the prompt.
 *
 * Four things it is told, and each earns its place:
 *
 * - **Where it is.** Not stated, but true: the run starts in the repository, so its instructions are
 *   already loaded. The prompt says to follow them, which is the only way to reach a convention this
 *   app has never read.
 * - **The branch.** A ticket key lives in the branch name far more reliably than in a diff, and a
 *   convention that wants `PROJ-123: ...` cannot be followed without it.
 * - **Recent subjects.** What the repository does, as opposed to what it documents. They are shown as
 *   examples of form and explicitly not as content to copy, or a model handed ten subjects starting
 *   with `fix:` will write an eleventh regardless of what the diff does.
 * - **The output rule, twice.** The answer is pasted straight into a textarea, so a preamble or a code
 *   fence is not a cosmetic problem: it becomes the subject line. `readCommitMessage` strips fences as
 *   a second line of defence, but the cheapest fix is asking clearly.
 */
export function buildCommitPrompt(input: CommitPromptInput): string {
  const { text, truncated } = capDiff(input.diff);
  const subjects = input.recentSubjects
    .slice(0, RECENT_SUBJECTS)
    .map((subject) => `- ${subject}`)
    .join('\n');

  const lines = [
    input.amend
      ? 'Write the commit message that replaces the last commit on this branch.'
      : 'Write the commit message for the staged changes below.',
    '',
    "Follow this repository's own commit conventions: read its CLAUDE.md, CONTRIBUTING.md or",
    'equivalent if it has one, and match what the recent subjects below already do if it does not.',
    '',
    `Branch: ${input.branch || '(unknown)'}`,
  ];

  if (subjects.length > 0) {
    lines.push(
      '',
      'Recent commit subjects in this repository, as examples of form only. Do not reuse their',
      'wording or their scope; the message must describe the diff below and nothing else.',
      subjects,
    );
  }

  lines.push(
    '',
    'Rules for your answer:',
    '- Output the commit message and nothing else: no preamble, no explanation, no code fence.',
    '- A subject line, then a blank line, then a body only if the change needs one.',
    '- Describe what the change does and why, not which files were touched.',
    '- Do not sign the message or add any co-author or tool attribution.',
    '',
    truncated
      ? `Diff (truncated at ${MAX_DIFF_CHARS} characters; describe only what you can see):`
      : 'Diff:',
    '',
    text,
  );

  return lines.join('\n');
}

/**
 * Reads the answer back as a message, or refuses it.
 *
 * A code fence is stripped because it is the one wrapper a model adds even when told not to, and it
 * would otherwise become the subject line. A preamble is deliberately **not** stripped: the rules that
 * would catch "Here is the commit message:" also catch a legitimate subject ending in a colon, and a
 * message with one stray line at the top is visible in the textarea and deleted in a second, whereas a
 * subject silently eaten by a cleanup rule is not.
 *
 * An empty answer, or one long enough to be something other than a message, comes back as `null`: the
 * caller then says the generation failed instead of pasting a wall of text over the draft.
 */
export function readCommitMessage(answer: string): string | null {
  const unfenced = stripFence(answer).trim();
  if (unfenced.length === 0 || unfenced.length > MAX_MESSAGE_CHARS) {
    return null;
  }
  // Trailing whitespace only: leading blank lines are already gone, and `writeCommitMessage` adds the
  // final newline git wants. Interior blank lines are the body separator and must survive.
  return unfenced.replace(/[ \t]+$/gm, '');
}

/**
 * Removes one surrounding code fence, if the whole answer is inside it.
 *
 * Only a fence that opens on the first line and closes on the last: a fence in the *middle* is part of
 * a body (a message quoting a snippet is unusual but legal), and unwrapping that would delete real
 * content while keeping the noise.
 */
function stripFence(answer: string): string {
  const lines = answer.trim().split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  const last = lines[lines.length - 1]?.trim() ?? '';
  if (lines.length >= 2 && first.startsWith('```') && last === '```') {
    return lines.slice(1, -1).join('\n');
  }
  return answer;
}
