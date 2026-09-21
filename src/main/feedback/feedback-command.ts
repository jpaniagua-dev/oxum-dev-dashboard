import { CLAUDE_CODE_PROFILE, type AgentProfile } from '@shared/agent-profile.js';
import { modelFlag } from '@shared/agent-model.js';
import { safeRepoName } from '../triage/work-command.js';

/**
 * The command line a feedback pass is handed over with.
 *
 * Beside `work-command.ts` and deliberately not inside it. That file's whole doc is that "which skill
 * is named is the whole of the difference between the two handoffs", and both of those take a list of
 * Jira keys; a third with another argument shape would make the sentence false. The two files share
 * `safeRepoName` because the rule it encodes is about shells, not about tickets.
 *
 * Same division of labour as the unattended run: the app names a skill and a pull request, the agent
 * does the reading, the fixing, the replying and the announcing. The app posts no comment, because the
 * judgement each remark needs, apply it or say in the thread why it was not applied, is not a judgement
 * a watcher can make.
 */

/** The hub skill that treats a pull request's review feedback. */
export const FEEDBACK_SKILL = 'pr-feedback';

/**
 * `<interactive template> "/pr-feedback 42 in the <repo> repository"`.
 *
 * The narrowest shell surface in this app: one integer and one whitelisted name. The number is checked
 * as a number rather than escaped as a string, the rule `buildWorktreeCommand` already applies to a
 * pull request number, and the folder goes through `safeRepoName`, which strips anything bash could
 * read as syntax inside the double-quoted argument.
 *
 * The ticket key is deliberately **not** in the prompt. The pull request knows its own branch, and
 * `gh pr view 42` is the first thing the skill does anyway: passing the key would be a second source of
 * truth about which branch to check out, free to disagree with GitHub's.
 *
 * Returns an empty string on a number that is not one, rather than interpolating it. The caller then
 * reports that it started nothing, which beats opening a tab that prints a usage error and reads
 * exactly like a session that did nothing.
 */
export function buildFeedbackCommand(
  number: number,
  folder: string,
  model = '',
  profile: AgentProfile = CLAUDE_CODE_PROFILE,
): string {
  if (!Number.isInteger(number) || number <= 0) {
    return '';
  }
  const repo = safeRepoName(folder);
  const where = repo === null ? '' : ` in the ${repo} repository`;
  const prompt = `/${FEEDBACK_SKILL} ${number}${where}`;
  const command = profile.interactive.replace(
    '{model}',
    model.trim().length === 0 ? '' : modelFlag(model).trim(),
  );
  return `${command.replace(/\s+/g, ' ').trim()} "${prompt}"`;
}
