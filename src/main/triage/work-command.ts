import { existsSync } from 'node:fs';
import { CLAUDE_CODE_PROFILE, type AgentProfile } from '@shared/agent-profile.js';
import type { TriageHandoff } from '@shared/contracts.js';
import { modelFlag } from '@shared/agent-model.js';

/**
 * Builds the `Work on this` command and decides where it runs.
 *
 * Separate from `ipc.ts` for the reason `settings-patch.ts` is: `ipc.ts` imports Electron at module
 * level, so a test of anything living in it would have to import Electron too. What is decided here is
 * the exact command line a ticket is handed over with, which is worth pinning by test rather than
 * reading back off a screenshot.
 */

/**
 * Permission prompts off for a handed-over ticket.
 *
 * The session is opened deliberately, on a ticket that was read, in a repository that was chosen from a
 * menu, to do the one thing the tab exists for: work it. Stopping every file write to ask would make the
 * gesture a click followed by twenty confirmations, which is the version nobody uses.
 *
 * The flag is spelled `--dangerously-skip-permissions`. It has no `--allow-` prefix, and a wrong
 * spelling is not harmless: `claude` rejects an unknown option, so the tab would open, print a usage
 * error and sit at a shell prompt, which reads exactly like a session that started and did nothing.
 */
export const SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

/**
 * Reduces a repository folder name to what is safe in every shell this app launches.
 *
 * The name reaches `bash -ic`, `cmd /c` or `powershell -Command` inside a double-quoted argument, and
 * bash expands `$` and backticks in there. A configured project path is not renderer input, so this is
 * a belt rather than the braces the issue-key pattern is, but the cost is one regular expression and
 * the alternative is a class of bug that only shows up on someone else's folder name.
 *
 * Anything left empty is reported as `null` rather than as a blank name: the caller then omits the
 * repository clause entirely, because a prompt saying "in the  repository" is worse than one that does
 * not mention the repository at all.
 */
export function safeRepoName(folder: string): string | null {
  const cleaned = folder.trim().replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The command line that hands tickets to an interactive Claude Code session.
 *
 * The repository is **named in the prompt** rather than implied by the working directory, and that is
 * the whole point of the pairing with `resolveWorkspaceRoot`: the session starts one level up, in the
 * workspace, so it inherits the instructions, skills and knowledge kept there, and it would otherwise
 * have no way to know which of the workspace's repositories the ticket is about. The ticket skill needs
 * that name anyway, a worktree being created per repository.
 *
 * One ticket goes straight to the skill; a batch names them in order and lets the skill run once per
 * ticket. Keys have already passed `ISSUE_KEY_PATTERN`, the folder name `safeRepoName` and the model
 * `MODEL_PATTERN`, so nothing in here can be read as shell syntax.
 *
 * Which skill is named is the whole of the difference between the two handoffs. `ask` opens `ticket`,
 * the session that stops whenever the work needs a decision; `auto` opens `ticket-auto`, which runs to
 * an open pull request without stopping. The app deliberately does no more than name it: it cannot
 * open a pull request itself, `gh-write.ts` holding no `gh pr create`, and Mail and Teams were
 * measured and dropped in V3, so both of the last two steps belong to a session that has the skills
 * and the M365 connector. The cost is stated rather than hidden: the unattended run is not
 * agent-agnostic the way the rest of this app is, and a profile without those loses the last two
 * steps in silence.
 *
 * The model is the one of the three Claude Code runs that reaches a **shell**, which is why it is
 * double-quoted and whitelisted rather than trusted: `claude-opus-5[1m]` is a legitimate pinned name
 * and its brackets are glob characters. Empty omits the flag entirely, the CLI rejecting a blank
 * model. It sits before `--dangerously-skip-permissions` for readability only; the CLI takes them in
 * any order.
 */
export function buildWorkCommand(
  keys: readonly string[],
  folder: string,
  model = '',
  profile: AgentProfile = CLAUDE_CODE_PROFILE,
  handoff: TriageHandoff = 'ask',
  options: HandoffOptions = { skill: '', notes: '' },
): string {
  const prompt = handoffPrompt(keys, folder, handoff, options);

  /*
   * The interactive template, with the prompt appended as a quoted argument.
   *
   * Always an argument and never stdin, unlike the headless runs: this lands in a terminal tab whose
   * stdin belongs to the user, who is the one about to type in it. The prompt is this app's own text
   * (a ticket key that `ISSUE_KEY_PATTERN` has already vetted, plus a repository name through
   * `safeRepoName`), so the double quotes here are enough; nothing a colleague wrote reaches this
   * line.
   */
  return `${buildInteractiveCommand(profile, model)} "${prompt}"`;
}

/** What a handoff names instead of the built-in prompt, and where the triage notes are. */
export interface HandoffOptions {
  /** A slash command such as `/ticket`, or empty for the built-in prompt. */
  readonly skill: string;
  /** The triage file, named in the built-in prompt so the session can read the notes. */
  readonly notes: string;
}

/**
 * A skill name safe inside the prompt's double quotes, with its slash, or null.
 *
 * Letters, digits, dash, underscore and the colon of a plugin skill (`plugin:skill`): what a skill
 * is named, and nothing a shell reads as syntax.
 */
export function safeSkill(value: string): string | null {
  const name = value.trim().replace(/^\//, '');
  return /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(name) ? `/${name}` : null;
}

/** A path safe inside the prompt's double quotes, or null. */
function safePath(path: string): string | null {
  return /^[A-Za-z0-9 :\\/._-]+$/.test(path) ? path : null;
}

/**
 * The words a ticket is handed over with.
 *
 * A configured skill keeps the exact sentence the handoffs always had: `/ticket PROJ-1 in the web
 * repository`. Without one, the app's own prompt says what to do, and where the triage notes are,
 * so a machine with no skill installed still hands over a ticket the agent can work. It holds
 * only this app's text, keys already vetted and a vetted repository name, because it lands inside
 * a double-quoted shell argument; the ticket's own description is read from the notes, never put
 * on the command line.
 */
export function handoffPrompt(
  keys: readonly string[],
  folder: string,
  handoff: TriageHandoff,
  options: HandoffOptions,
): string {
  const repo = safeRepoName(folder);
  const where = repo === null ? '' : ` in the ${repo} repository`;
  const skill = safeSkill(options.skill);
  if (skill !== null) {
    return keys.length === 1
      ? `${skill} ${keys[0]}${where}`
      : `Work these tickets one after another${where}, using ${skill} for each: ${keys.join(', ')}`;
  }
  const subject =
    keys.length === 1 ? `Work on ticket ${keys[0]}${where}.` : `Work on these tickets one after another${where}: ${keys.join(', ')}.`;
  const notes = safePath(options.notes);
  const read = notes === null ? '' : ` The triage notes about it are in ${notes}.`;
  const how =
    handoff === 'auto'
      ? ' Work without stopping for approval: create a branch named after the ticket from the default branch, implement the change, run the checks, commit, push the branch and open a draft pull request with gh. Stop only when something blocks you.'
      : ' Create a branch named after the ticket from the default branch, implement the change and run the checks. Ask before pushing, and before anything that cannot be undone.';
  return `${subject}${read}${how}`;
}

/**
 * The agent's interactive command line, with no prompt appended.
 *
 * What the Agent button in the tab strip runs: the same template and the same model flag as a
 * handed-over ticket, minus the ticket. Shared with `buildWorkCommand` rather than written twice,
 * because the model flag is the one token in there that is whitelisted rather than trusted and two
 * copies of that rule is one copy too many.
 */
export function buildInteractiveCommand(
  profile: AgentProfile = CLAUDE_CODE_PROFILE,
  model = '',
): string {
  const command = profile.interactive.replace(
    '{model}',
    model.trim().length === 0 ? '' : modelFlag(model).trim(),
  );
  return command.replace(/\s+/g, ' ').trim();
}

/**
 * Where a handed-over ticket's session starts.
 *
 * A CLI coding agent reads its instructions from the folder it is launched in and from that
 * folder's ancestors. A repository under a workspace therefore starts with strictly less than the
 * workspace does: it sees its own instructions file and nothing of what several repositories share one level
 * up. Launching at the workspace root and naming the repository in the prompt keeps both halves.
 *
 * A configured root that is not on disk falls back to the repository rather than being passed on. A pty
 * spawned on a missing directory fails, and the failure is a tab that closes on an error about a path
 * nobody typed today, whereas the fallback is the behaviour every version before this one had.
 */
export function resolveWorkspaceRoot(
  configured: string,
  repositoryPath: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const root = configured.trim();
  return root.length > 0 && exists(root) ? root : repositoryPath;
}
