import { existsSync } from 'node:fs';
import { modelFlag } from '@shared/claude-model.js';

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
 * the whole point of the pairing with `resolveClaudeContext`: the session starts one level up, in the
 * workspace, so it inherits the instructions, skills and knowledge kept there, and it would otherwise
 * have no way to know which of the workspace's repositories the ticket is about. The ticket skill needs
 * that name anyway, a worktree being created per repository.
 *
 * One ticket goes straight to the skill; a batch names them in order and lets the skill run once per
 * ticket. Keys have already passed `ISSUE_KEY_PATTERN`, the folder name `safeRepoName` and the model
 * `CLAUDE_MODEL_PATTERN`, so nothing in here can be read as shell syntax.
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
): string {
  const repo = safeRepoName(folder);
  const where = repo === null ? '' : ` in the ${repo} repository`;
  const prompt =
    keys.length === 1
      ? `/ticket ${keys[0]}${where}`
      : `Work these tickets one after another${where}, using the ticket skill for each: ${keys.join(', ')}`;
  return `claude${modelFlag(model)} ${SKIP_PERMISSIONS_FLAG} "${prompt}"`;
}

/**
 * Where a handed-over ticket's session starts.
 *
 * Claude Code reads its instructions, skills and memory from the folder it is launched in and from that
 * folder's ancestors. A repository under a workspace therefore starts with strictly less than the
 * workspace does: it sees its own `CLAUDE.md` and nothing of what several repositories share one level
 * up. Launching at the workspace root and naming the repository in the prompt keeps both halves.
 *
 * A configured root that is not on disk falls back to the repository rather than being passed on. A pty
 * spawned on a missing directory fails, and the failure is a tab that closes on an error about a path
 * nobody typed today, whereas the fallback is the behaviour every version before this one had.
 */
export function resolveClaudeContext(
  configured: string,
  repositoryPath: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const root = configured.trim();
  return root.length > 0 && exists(root) ? root : repositoryPath;
}
