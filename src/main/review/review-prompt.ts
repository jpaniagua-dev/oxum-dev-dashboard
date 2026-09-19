import type { BotFinding } from '@shared/contracts.js';
import { PR_FILE_SOFT_LIMIT } from '@shared/pull-review.js';
import { MAX_PATCH_BYTES } from './review-limits.js';

/**
 * The prompt handed to the review run, and the shape of the answer it must send back.
 *
 * Pure and separate from the launch, for the reason `triage-prompt.ts` is: the prompt IS the contract
 * with the model, and a silent change to it changes every verdict. It matters more here than there,
 * because what comes back can end up written on somebody else's pull request.
 */

export interface ReviewPromptInput {
  readonly slug: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly branch: string;
  readonly authorLogin: string;
  readonly changedFiles: number;
  /** The patch, already pinned to the sha under review. */
  readonly patch: string;
  /** What the review bot already said. Input to judge, never a gate. */
  readonly bot: readonly BotFinding[];
  /** Points a human already answered on this pull request, not to be raised again. */
  readonly answered: readonly string[];
  /** Absolute path of the repository, so the prompt can name the folder the run may read. */
  readonly repoPath: string;
}

/**
 * Cuts a patch down to what a prompt can carry, and says that it cut.
 *
 * The run refuses a pull request over `MAX_PATCH_BYTES` outright rather than reviewing part of it,
 * so this only ever trims the tail of one that passed the cap: it is a safety net against a patch
 * whose size was read from `changedFiles` rather than from its bytes. Announced in the text for the
 * reason `trimDescription` announces its own cut, a model reading an extract must know it is one.
 */
export function trimPatch(patch: string): string {
  if (patch.length <= MAX_PATCH_BYTES) {
    return patch;
  }
  return `${patch.slice(0, MAX_PATCH_BYTES)}\n\n[patch truncated: it is larger than this review can carry]`;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const lines: string[] = [
    'You are reviewing a pull request for the developer who guarantees consistency across this',
    "team's front-end applications. Judge it as they would.",
    '',
    `Repository: ${input.slug}`,
    `Pull request: #${input.number} by ${input.authorLogin}`,
    `Title: ${input.title}`,
    `Branch: ${input.branch}`,
    `Files changed: ${input.changedFiles}`,
    '',
  ];

  if (input.body.trim().length > 0) {
    lines.push('Description as the author wrote it:', '', input.body.trim(), '');
  }

  lines.push(
    'HOW TO READ WHAT YOU ARE GIVEN',
    '',
    `The patch below is the ONLY authority on what this pull request changes. The folder`,
    `${input.repoPath} is open to you as read-only context, but it is checked out on the default`,
    'branch, NOT on this pull request. Use it to learn the conventions, to find whether a shared',
    'component already exists, to check whether a symbol is defined. Never contradict a line of the',
    'patch on the strength of a file you read there: if they disagree, the patch is right and the',
    'file is simply older.',
    '',
    'WHAT TO LOOK FOR, IN THIS ORDER',
    '',
    '1. Correctness. A bug the tests would not catch, a case the change breaks, a promise the',
    '   description makes that the diff does not keep.',
    '2. Consistency with the rest of the applications. This is the half a diff hides and the half',
    "   this review exists for: a shared wrapper component that exists and was not used, a list or",
    '   table built by hand where the shared one is the convention, a colour written as a literal',
    '   instead of a theme variable, an icon from outside the icon set, a style reaching into',
    "   another component's internals. Treat these at the same rank as a bug, not as a nit: two",
    '   applications that drift apart cost more than one function that is wrong.',
    '3. The conventions written in the repository itself. Read its own instructions file if it has',
    '   one, and apply what it says rather than what you would do elsewhere.',
    '4. Size. A pull request over ' +
      String(PR_FILE_SOFT_LIMIT) +
      ' changed files is past what a reviewer reads rather than skims.',
    '   Say so once, as a non-blocking point, only when a split was plainly available.',
    '',
    'WHAT NOT TO DO',
    '',
    '- Do not restate the diff. A remark that describes what the code does is a remark that gets',
    '  skipped, and it takes the useful ones with it.',
    '- Do not raise a point about behaviour that already existed before this branch. Out of scope',
    '  is out of scope, however true.',
    '- Do not comment on formatting a linter owns.',
    '- Never name a local folder, an absolute path, a file outside the repository, or the workspace',
    '  you are running in. What you write is posted publicly on the pull request.',
    '',
  );

  if (input.bot.length > 0) {
    lines.push(
      'WHAT AN AUTOMATED REVIEWER ALREADY SAID',
      '',
      'Judge each of these on the merits and reach your own conclusion. Its severity badge is',
      'reproduced as it wrote it and means nothing here: it has been seen to propose fixes that',
      'reintroduce what the pull request had just removed, and to be right about something that was',
      'already true before the branch. Where it is right, say so briefly rather than repeating it at',
      'length; where it is wrong, say why in one line.',
      '',
    );
    for (const finding of input.bot) {
      const where = finding.path.length === 0 ? '' : ` ${finding.path}${finding.line === null ? '' : `:${finding.line}`}`;
      const badge = finding.severity.length === 0 ? '' : ` [${finding.severity}]`;
      lines.push(`-${badge}${where}: ${finding.body.replace(/\s+/g, ' ').slice(0, 600)}`);
    }
    lines.push('');
  } else {
    lines.push(
      'No automated review is on this pull request yet, so there is nothing of its to weigh.',
      '',
    );
  }

  if (input.answered.length > 0) {
    lines.push(
      'ALREADY DISCUSSED ON THIS PULL REQUEST',
      '',
      'A human has answered these. Do not raise them again, under any wording.',
      '',
      ...input.answered.map((point) => `- ${point.replace(/\s+/g, ' ').slice(0, 400)}`),
      '',
    );
  }

  lines.push(
    'THE PATCH',
    '',
    trimPatch(input.patch),
    '',
    'ANSWER',
    '',
    'Reply with one JSON object and nothing else:',
    '',
    '{',
    '  "verdict": "approve" | "comment" | "request-changes" | "unclear",',
    '  "summary": "two sentences at most, what this pull request does and where it stands",',
    '  "findings": [',
    '    {',
    '      "path": "path exactly as the patch spells it, or \\"\\" for the pull request as a whole",',
    '      "line": 44,',
    '      "title": "five words naming the point",',
    '      "blocking": true,',
    '      "body": "one or two sentences: what is wrong and what to do instead"',
    '    }',
    '  ]',
    '}',
    '',
    'Choosing the verdict:',
    '',
    '- "approve": nothing worth saying. Not "nothing serious": nothing.',
    '- "comment": worth saying, none of it blocking.',
    '- "request-changes": at least one finding is blocking. Use it only for something that should',
    '  not reach the main branch as it stands. This verdict BLOCKS the merge and is posted publicly',
    '  under the reviewer\'s own name, so a false one costs them more than a missed remark does.',
    '- "unclear": you could not review it, for instance because the patch is unreadable.',
    '',
    'A finding naming a file the patch does not touch will be discarded, so do not invent paths.',
  );

  return lines.join('\n');
}
