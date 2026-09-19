import { createHash } from 'node:crypto';
import type { PullFinding } from '@shared/contracts.js';

/**
 * The text this application writes onto somebody else's pull request, and nothing else does.
 *
 * Worth a module of its own, pure and pinned by tests, for the reason `buildWorktreeCommand` is: what
 * is decided here leaves the machine. Every other string in this app can be wrong and be corrected;
 * this one arrives in a colleague's inbox, and a submitted GitHub review cannot be deleted.
 */

/**
 * Marker that lets a later run recognise what an earlier one said, invisible on GitHub.
 *
 * It names **a sha and nothing else**. Not the product, not the tool, not the workspace: a marker
 * that identifies the tool identifies the private workspace it was run from, and that workspace is
 * never named in anything that reaches a shared repository.
 */
const MARKER = /<!--\s*review-sha:\s*([0-9a-f]{7,40})\s*-->/i;

/** Length of a derived finding id, in hex characters. Four is 65 536 buckets over one pull request. */
const ID_LENGTH = 4;

export function buildMarker(headSha: string): string {
  return `<!-- review-sha: ${headSha} -->`;
}

/** The sha a body was written about, or `null` when it carries no marker of ours. */
export function readMarkerSha(body: string): string | null {
  const found = MARKER.exec(body);
  return found === null ? null : (found[1] ?? '').toLowerCase();
}

/**
 * A stable id for one finding, derived rather than asked of the model.
 *
 * Derived, because an id the model invents changes between two runs over the same unchanged finding,
 * and idempotency is built on recognising "this one again". The path and the title are what identify
 * a remark; the wording around it is allowed to drift without minting a new id, so the title is
 * lowercased and its runs of non-alphanumerics collapsed before hashing.
 */
export function findingId(path: string, title: string): string {
  const normalised = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `F-${createHash('sha1').update(`${path}\n${normalised}`).digest('hex').slice(0, ID_LENGTH)}`;
}

/**
 * Removes anything that would name the machine or the private workspace.
 *
 * The prompt already forbids it; this is the half that can be tested. A prompt is an instruction a
 * model may or may not follow, and the cost of it not following is a private folder name on a
 * company pull request, so the belt is the instruction and these are the braces.
 *
 * Three shapes, and only three, because over-scrubbing is its own failure: a finding that says
 * `src/app/list.component.ts` must keep saying it, that being the whole point of the remark.
 * Absolute paths go, home-relative paths go, the workspace's own folder name goes; everything
 * repository-relative stays.
 */
export function scrubBody(text: string, workspaceRoot: string): string {
  let out = text
    // C:\Users\... and C:/Users/..., up to the first whitespace or closing quote/backtick.
    .replace(/[A-Za-z]:[\\/][^\s`'")\]]*/g, '<path>')
    // The Git Bash spelling of the same thing.
    .replace(/(?<![\w/])\/[a-z]\/Users\/[^\s`'")\]]*/gi, '<path>')
    .replace(/(?<![\w/])~\/[^\s`'")\]]*/g, '<path>');

  const folder = basename(workspaceRoot);
  if (folder.length > 2) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(folder)}\\b`, 'gi'), '<workspace>');
  }
  return out;
}

/**
 * Neutralises anything in model text that could open, close or forge an HTML comment.
 *
 * **Both halves, and the opener is the one that bites.** Escaping only `-->` looks sufficient until
 * a model writes `<!--` in a remark: that opens a comment nothing closes, so GitHub renders the rest
 * of the body, the findings and the real marker included, as nothing at all. The review would post,
 * look empty to its reader, and still parse correctly here, which is the shape of a bug nobody
 * reports. A forged `<!-- review-sha: ... -->` would additionally make a later run believe it had
 * already spoken.
 */
export function escapeComments(text: string): string {
  return text.replace(/<!--/g, '&lt;!--').replace(/--+>/g, (match) => `${match.slice(0, -1)}&gt;`);
}

export interface ReviewBodyInput {
  readonly summary: string;
  readonly findings: readonly PullFinding[];
  readonly headSha: string;
  readonly workspaceRoot: string;
  /** Findings raised at an earlier sha and still open, so the body can say it is not repeating itself. */
  readonly carriedOver: readonly string[];
}

/**
 * The review body, exactly as it will be posted.
 *
 * Findings carry their id **visibly**, which is what lets the stored review, the tab, the GitHub
 * thread and a human's reply all name the same remark. Blocking points come first and are the reason
 * the review blocks; the rest is grouped under a heading that says plainly it is not blocking, so a
 * reader knows which half to answer before the merge and which half can wait.
 *
 * No greeting, no sign-off, no mention of how it was produced. It is a review, and padding a review
 * with process is how a reader learns to skim it.
 */
export function buildReviewBody(input: ReviewBodyInput): string {
  const clean = (text: string): string =>
    escapeComments(scrubBody(text, input.workspaceRoot)).trim();

  const blocking = input.findings.filter((finding) => finding.blocking);
  const rest = input.findings.filter((finding) => !finding.blocking);
  const lines: string[] = [];

  const summary = clean(input.summary);
  if (summary.length > 0) {
    lines.push(summary, '');
  }

  if (blocking.length > 0) {
    lines.push('**Blocking**', '');
    for (const finding of blocking) {
      lines.push(`- ${describeFinding(finding, clean)}`);
    }
    lines.push('');
  }

  if (rest.length > 0) {
    lines.push('**Non blocking**', '');
    for (const finding of rest) {
      lines.push(`- ${describeFinding(finding, clean)}`);
    }
    lines.push('');
  }

  if (input.carriedOver.length > 0) {
    lines.push(
      `Still open from an earlier review of this pull request: ${input.carriedOver.join(', ')}.`,
      '',
    );
  }

  lines.push(buildMarker(input.headSha));
  return `${lines.join('\n')}\n`;
}

/** One bullet: the id, where it is, then what it says. */
function describeFinding(finding: PullFinding, clean: (text: string) => string): string {
  const where =
    finding.path.length === 0
      ? ''
      : finding.line === null
        ? ` \`${finding.path}\``
        : ` \`${finding.path}:${finding.line}\``;
  return `**[${finding.id}]**${where} : ${clean(finding.body)}`;
}

/** Last path segment, whichever separator was used. */
function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
