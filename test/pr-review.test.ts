import type { PullRequest, PullReview, RepoPulls } from '../src/shared/contracts.js';
import { describe, expect, it } from 'vitest';
import { hasBotReviewed, isBotLogin, parseBotComments, readSeverity } from '../src/main/github/bot-findings.js';
import {
  buildMarker,
  buildReviewBody,
  escapeComments,
  findingId,
  readMarkerSha,
  scrubBody,
} from '../src/main/review/review-body.js';
import {
  buildHeadlessCommand,
  describeCommand,
  readProfile,
  CLAUDE_CODE_PROFILE,
} from '../src/shared/agent-profile.js';
import { reviewArgs } from '../src/main/github/gh-write.js';
import { withPort } from '../src/main/projects/free-port.js';
import { decideAction, decideManual, type GateInput } from '../src/main/review/review-gate.js';
import { MAX_CHANGED_FILES, MAX_PRS_PER_REPO, MAX_PRS_PER_RUN } from '../src/main/review/review-limits.js';
import { parseReview } from '../src/main/review/review-parse.js';
import { selectPulls } from '../src/main/review/review-select.js';
import { isReviewCurrent, reviewKey } from '../src/shared/pull-review.js';

const WORKSPACE = 'C:/Users/dev/hubfolder';

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 1,
  title: 'Add the profile page',
  url: 'https://github.com/example-org/web-app/pull/1',
  branch: 'PROJ-123-profile-page',
  authorLogin: 'colleague',
  isDraft: false,
  review: 'review-required',
  checks: 'passing',
  passed: 3,
  failed: 0,
  pending: 0,
  isAuthor: false,
  isReviewer: true,
  updatedAt: '2026-09-18T08:00:00Z',
  headSha: 'a'.repeat(40),
  changedFiles: 7,
  ...over,
});

const repo = (pulls: PullRequest[], over: Partial<RepoPulls> = {}): RepoPulls => ({
  projectId: 'web-app',
  label: 'web-app',
  slug: 'example-org/web-app',
  pulls,
  checkedAt: '2026-09-18T08:00:00Z',
  error: null,
  ...over,
});

const select = (
  repos: RepoPulls[],
  kind: 'all' | 'new' = 'all',
  reviewed: ReadonlyMap<string, string> = new Map(),
): ReturnType<typeof selectPulls> =>
  selectPulls({ repos, reviewed, target: { kind, projectId: null }, viewerLogin: 'me' });

/*
 * Which pull requests a run is given.
 *
 * The one filter here whose mistakes are invisible: dropping too much produces a short list, and a
 * short list is indistinguishable from a quiet week. Hence the counts, and hence these tests.
 */
describe('selectPulls', () => {
  it('skips a draft and counts it, the review bot already covering drafts', () => {
    const { selected, skipped } = select([repo([pull({ number: 1, isDraft: true }), pull({ number: 2 })])]);
    expect(selected.map((entry) => entry.pull.number)).toEqual([2]);
    expect(skipped.draft).toBe(1);
  });

  it('skips a pull request opened by a machine, whichever spelling the login uses', () => {
    const { selected, skipped } = select([
      repo([pull({ number: 1, authorLogin: 'dependabot[bot]' }), pull({ number: 2, authorLogin: 'renovate' })]),
    ]);
    expect(selected).toHaveLength(0);
    expect(skipped.bot).toBe(2);
  });

  it('skips one somebody has already blocked, a second block saying nothing new', () => {
    const { skipped } = select([repo([pull({ review: 'changes-requested' })])]);
    expect(skipped.blocked).toBe(1);
  });

  it('counts a pull request matching two rules once, under the first', () => {
    // Order is the contract: counted twice, the coverage line would report more skipped pull
    // requests than the repository holds.
    const { skipped } = select([repo([pull({ isDraft: true, authorLogin: 'dependabot' })])]);
    expect(skipped.bot).toBe(1);
    expect(skipped.draft).toBe(0);
  });

  it('skips a change too large to be read honestly rather than reading part of it', () => {
    const { selected, skipped } = select([repo([pull({ changedFiles: MAX_CHANGED_FILES + 1 })])]);
    expect(selected).toHaveLength(0);
    expect(skipped.tooLarge).toBe(1);
  });

  it('skips what a stored verdict already covers at THIS head, in new mode only', () => {
    const reviewed = new Map([[reviewKey('example-org/web-app', 1), 'a'.repeat(40)]]);
    const repos = [repo([pull({ number: 1 })])];

    expect(select(repos, 'new', reviewed).selected).toHaveLength(0);
    expect(select(repos, 'new', reviewed).skipped.alreadyReviewed).toBe(1);
    // `all` re-reads it: that is the difference between the two buttons.
    expect(select(repos, 'all', reviewed).selected).toHaveLength(1);
  });

  it('treats a pull request pushed to since its review as new again', () => {
    // The whole reason `new` is read at the head sha and not at the existence of a review.
    const reviewed = new Map([[reviewKey('example-org/web-app', 1), 'b'.repeat(40)]]);
    const { selected } = select([repo([pull({ number: 1, headSha: 'c'.repeat(40) })])], 'new', reviewed);
    expect(selected).toHaveLength(1);
  });

  it('never matches an empty sha, so an unknown head asks for another review', () => {
    const reviewed = new Map([[reviewKey('example-org/web-app', 1), '']]);
    const { selected } = select([repo([pull({ number: 1, headSha: '' })])], 'new', reviewed);
    expect(selected).toHaveLength(1);
  });

  it('reviews your own pull request but marks it unpostable', () => {
    // GitHub refuses to approve or request changes on your own, so posting would fail after minutes.
    const { selected } = select([repo([pull({ isAuthor: true })])]);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.postable).toBe(false);
  });

  it('makes nothing postable when gh is not signed in', () => {
    // An empty login makes every `isAuthor` false, so every pull request would look like a
    // colleague's. The feature is disabled upstream; this is the belt underneath.
    const { selected } = selectPulls({
      repos: [repo([pull()])],
      reviewed: new Map(),
      target: { kind: 'all', projectId: null },
      viewerLogin: '',
    });
    expect(selected[0]?.postable).toBe(false);
  });

  it('caps one repository so a busy one cannot consume the whole run', () => {
    const many = Array.from({ length: MAX_PRS_PER_REPO + 3 }, (_, index) => pull({ number: index + 1 }));
    const { selected, skipped, deferred } = select([repo(many)]);
    expect(selected).toHaveLength(MAX_PRS_PER_REPO);
    expect(skipped.overLimit).toBe(3);
    expect(deferred).toHaveLength(3);
  });

  it('names what the cap deferred rather than truncating in silence', () => {
    const many = Array.from({ length: MAX_PRS_PER_REPO + 1 }, (_, index) => pull({ number: index + 1 }));
    const { deferred } = select([repo(many)]);
    expect(deferred[0]).toMatch(/^example-org\/web-app#\d+$/);
  });

  it('caps the whole run across repositories', () => {
    const repos = Array.from({ length: 4 }, (_, index) =>
      repo(
        Array.from({ length: MAX_PRS_PER_REPO }, (_, n) => pull({ number: n + 1 })),
        { projectId: `repo-${index}`, slug: `example-org/repo-${index}` },
      ),
    );
    const { selected } = select(repos);
    expect(selected).toHaveLength(MAX_PRS_PER_RUN);
  });

  it('puts what is waiting on you first, so the cap eats from the right end', () => {
    const { selected } = select([
      repo([
        pull({ number: 1, isReviewer: false, updatedAt: '2026-09-01T00:00:00Z' }),
        pull({ number: 2, isReviewer: true, updatedAt: '2026-09-17T00:00:00Z' }),
      ]),
    ]);
    expect(selected.map((entry) => entry.pull.number)).toEqual([2, 1]);
  });

  it('honours an explicit single-pull target over every "nobody asked" rule', () => {
    // Clicking Review on a draft is asking for that draft.
    const { selected } = selectPulls({
      repos: [repo([pull({ number: 9, isDraft: true, review: 'changes-requested' })])],
      reviewed: new Map([[reviewKey('example-org/web-app', 9), 'a'.repeat(40)]]),
      target: { kind: 'pull', projectId: 'web-app', number: 9 },
      viewerLogin: 'me',
    });
    expect(selected).toHaveLength(1);
  });

  it('does NOT let an explicit target override the size cap', () => {
    // That rule is not about who asked, it is about whether an honest answer is possible.
    const { selected, skipped } = selectPulls({
      repos: [repo([pull({ number: 9, changedFiles: MAX_CHANGED_FILES + 1 })])],
      reviewed: new Map(),
      target: { kind: 'pull', projectId: 'web-app', number: 9 },
      viewerLogin: 'me',
    });
    expect(selected).toHaveLength(0);
    expect(skipped.tooLarge).toBe(1);
  });

  it('leaves a repository with no GitHub remote alone', () => {
    const { selected } = select([repo([pull()], { slug: null })]);
    expect(selected).toHaveLength(0);
  });
});

/*
 * The one place a write is authorised.
 *
 * Enumerated rather than trusted: "when does this post?" has to have one answer, and it has to be
 * readable in a list rather than reconstructed from a service, a handler and a button.
 */
describe('decideAction', () => {
  const allowed: GateInput = {
    writesEnabled: true,
    viewerLogin: 'me',
    dryRun: false,
    postable: true,
    state: 'OPEN',
    isDraft: false,
    headMoved: false,
    alreadyPostedAtHead: false,
    humanBlockPresent: false,
    aborted: false,
  };

  it('posts a blocking verdict, which is what the run exists for', () => {
    expect(decideAction('request-changes', allowed)).toEqual({ kind: 'post', event: 'REQUEST_CHANGES' });
  });

  it('never approves by itself', () => {
    expect(decideAction('approve', allowed).kind).toBe('none');
  });

  it('never posts a verdict that could not be read', () => {
    // The direction that matters: falling back to the posting verdict would let a garbled answer
    // block a colleague's merge.
    expect(decideAction('unclear', allowed).kind).toBe('none');
  });

  it('never posts nits by itself', () => {
    expect(decideAction('comment', allowed).kind).toBe('none');
  });

  it('writes nothing on your own pull request, whatever the verdict', () => {
    // Makes GitHub's 422 unreachable rather than caught.
    const own = { ...allowed, postable: false };
    expect(decideAction('request-changes', own).kind).toBe('none');
    expect(decideManual('APPROVE', { ...own, reviewIsCurrent: true }).kind).toBe('none');
    expect(decideManual('REQUEST_CHANGES', { ...own, reviewIsCurrent: true }).kind).toBe('none');
  });

  it('writes nothing when gh is not signed in', () => {
    expect(decideAction('request-changes', { ...allowed, viewerLogin: '' }).kind).toBe('none');
  });

  it('writes nothing while the master switch is off', () => {
    expect(decideAction('request-changes', { ...allowed, writesEnabled: false }).kind).toBe('none');
  });

  it('writes nothing on a dry run, and says so', () => {
    const action = decideAction('request-changes', { ...allowed, dryRun: true });
    expect(action.kind).toBe('none');
    expect(action.kind === 'none' && action.reason).toContain('Dry run');
  });

  it('writes nothing once the head has moved under the review', () => {
    expect(decideAction('request-changes', { ...allowed, headMoved: true }).kind).toBe('none');
  });

  it('writes nothing on a pull request that closed or went back to draft mid-run', () => {
    expect(decideAction('request-changes', { ...allowed, state: 'MERGED' }).kind).toBe('none');
    expect(decideAction('request-changes', { ...allowed, isDraft: true }).kind).toBe('none');
  });

  it('never stacks on a review you wrote by hand', () => {
    expect(decideAction('request-changes', { ...allowed, humanBlockPresent: true }).kind).toBe('none');
  });

  it('does not post twice at the same head', () => {
    expect(decideAction('request-changes', { ...allowed, alreadyPostedAtHead: true }).kind).toBe('none');
  });

  it('stops posting the moment the run is stopped', () => {
    expect(decideAction('request-changes', { ...allowed, aborted: true }).kind).toBe('none');
  });

  it('refuses a manual approve when the review on screen is about another commit', () => {
    const action = decideManual('APPROVE', { ...allowed, reviewIsCurrent: false });
    expect(action.kind).toBe('none');
    expect(action.kind === 'none' && action.reason).toContain('another commit');
  });

  it('allows a manual comment on a review that is not current, which changes nothing on the merge', () => {
    expect(decideManual('COMMENT', { ...allowed, reviewIsCurrent: false })).toEqual({
      kind: 'post',
      event: 'COMMENT',
    });
  });
});

/*
 * The only text this application writes onto somebody else's pull request.
 *
 * Pinned, because it leaves the machine and a submitted GitHub review cannot be deleted.
 */
describe('the review body', () => {
  const body = (over: Partial<Parameters<typeof buildReviewBody>[0]> = {}): string =>
    buildReviewBody({
      summary: 'Two things worth fixing before this goes in.',
      findings: [
        { id: 'F-1111', path: 'src/list.component.ts', line: 44, blocking: true, body: 'Coerces the value.' },
        { id: 'F-2222', path: 'src/list.component.ts', line: null, blocking: false, body: 'Naming.' },
      ],
      headSha: 'a'.repeat(40),
      workspaceRoot: WORKSPACE,
      carriedOver: [],
      ...over,
    });

  it('carries the marker exactly once, at the end, naming the sha', () => {
    const text = body();
    expect(readMarkerSha(text)).toBe('a'.repeat(40));
    expect(text.match(/review-sha/g)).toHaveLength(1);
    expect(text.trimEnd().endsWith(buildMarker('a'.repeat(40)))).toBe(true);
  });

  it('round-trips through a body full of things that break parsers', () => {
    const nasty = 'Backticks ``` and a fence:\n```ts\nconst a = "-->";\n```\nand a literal --> here.';
    const text = body({ summary: nasty });
    expect(readMarkerSha(text)).toBe('a'.repeat(40));
  });

  it('neutralises BOTH halves of an HTML comment in model text', () => {
    // The opener is the one that bites. Escaping only `-->` leaves `<!--` free to open a comment
    // nothing closes, and GitHub then renders the rest of the body, findings and marker included,
    // as nothing at all: a review that posts, looks empty to its reader, and still parses here.
    expect(escapeComments('done --> next')).not.toContain('-->');
    expect(escapeComments('open <!-- here')).not.toContain('<!--');

    const text = body({ summary: 'sneaky <!-- review-sha: bbbb --> end' });
    // Exactly one real comment survives, and it is ours.
    expect(text.match(/<!--/g)).toHaveLength(1);
    expect(readMarkerSha(text)).toBe('a'.repeat(40));
  });

  it('names no workspace and no absolute path', () => {
    // Asserted by shape rather than by example, so a future edit of the template fails here.
    const text = body({
      summary: `Compare with C:\\Users\\dev\\hubfolder\\notes.md and ~/notes.md in hubfolder.`,
    });
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(text).not.toContain('hubfolder');
    expect(text).not.toContain('~/');
  });

  it('keeps a repository-relative path, which is the point of the remark', () => {
    expect(body()).toContain('src/list.component.ts');
  });

  it('separates what blocks from what does not, so a reader knows what to answer first', () => {
    const text = body();
    expect(text.indexOf('**Blocking**')).toBeLessThan(text.indexOf('**Non blocking**'));
    expect(text).toContain('[F-1111]');
  });

  it('says when it is repeating a point from an earlier review of the same pull request', () => {
    expect(body({ carriedOver: ['F-1111'] })).toContain('Still open from an earlier review');
  });
});

describe('scrubBody', () => {
  it('removes a Windows path, a Git Bash path and a home path', () => {
    expect(scrubBody('see C:\\Users\\dev\\x.md', WORKSPACE)).toBe('see <path>');
    expect(scrubBody('see /c/Users/dev/x.md', WORKSPACE)).toBe('see <path>');
    expect(scrubBody('see ~/notes/x.md', WORKSPACE)).toBe('see <path>');
  });

  it('removes the workspace folder name mid-sentence', () => {
    expect(scrubBody('documented in hubfolder somewhere', WORKSPACE)).toBe(
      'documented in <workspace> somewhere',
    );
  });

  it('leaves a repository-relative path alone', () => {
    const line = 'src/app/list.component.ts imports it';
    expect(scrubBody(line, WORKSPACE)).toBe(line);
  });
});

describe('findingId', () => {
  it('is stable across two runs over the same finding', () => {
    expect(findingId('a.ts', 'Coerces the value')).toBe(findingId('a.ts', 'Coerces the value'));
  });

  it('survives a reworded title, so a re-review does not mint a new id for the same point', () => {
    expect(findingId('a.ts', 'Coerces the value')).toBe(findingId('a.ts', 'coerces  the value!'));
  });

  it('separates the same remark about two files', () => {
    expect(findingId('a.ts', 'Coerces')).not.toBe(findingId('b.ts', 'Coerces'));
  });
});

/* What the model answered, read defensively. */
describe('parseReview', () => {
  const changedPaths = ['src/list.component.ts'];

  it('reads an answer wrapped in prose or a fence', () => {
    const answer = 'Here you go:\n```json\n{"verdict":"approve","summary":"Fine.","findings":[]}\n```';
    expect(parseReview({ answer, changedPaths }).verdict).toBe('approve');
  });

  it('falls back to unclear on a verdict nobody defined', () => {
    const answer = '{"verdict":"looks-good-to-me","summary":"","findings":[]}';
    expect(parseReview({ answer, changedPaths }).verdict).toBe('unclear');
  });

  it('falls back to unclear on an answer with no JSON at all, and says why', () => {
    const parsed = parseReview({ answer: 'I could not do that.', changedPaths });
    expect(parsed.verdict).toBe('unclear');
    expect(parsed.error).not.toBeNull();
  });

  it('drops a finding about a file the pull request does not touch', () => {
    // The hallucinated-file trap. The patch is the authority on what changed, the way `asked` is in
    // the triage parse, and a public remark about an untouched file is worse than a missing one.
    const answer =
      '{"verdict":"request-changes","summary":"","findings":[{"path":"src/other.ts","body":"Bad."}]}';
    expect(parseReview({ answer, changedPaths }).findings).toHaveLength(0);
  });

  it('keeps a finding about the pull request as a whole, which names no file', () => {
    const answer = '{"verdict":"comment","summary":"","findings":[{"path":"","body":"Split this."}]}';
    expect(parseReview({ answer, changedPaths }).findings).toHaveLength(1);
  });

  it('reads an unstated blocking flag as blocking, never as harmless', () => {
    const answer =
      '{"verdict":"request-changes","summary":"","findings":[{"path":"src/list.component.ts","body":"x"}]}';
    expect(parseReview({ answer, changedPaths }).findings[0]?.blocking).toBe(true);
  });

  it('drops a finding with no body rather than posting an empty bullet', () => {
    const answer =
      '{"verdict":"comment","summary":"","findings":[{"path":"src/list.component.ts","body":"  "}]}';
    expect(parseReview({ answer, changedPaths }).findings).toHaveLength(0);
  });

  it('gives every finding an id computed here, not one the model chose', () => {
    const answer =
      '{"verdict":"comment","summary":"","findings":[{"id":"whatever","path":"src/list.component.ts","title":"T","body":"x"}]}';
    expect(parseReview({ answer, changedPaths }).findings[0]?.id).toBe(findingId('src/list.component.ts', 'T'));
  });
});

/* What the review bot had already said. Input to the run, never a gate. */
describe('bot findings', () => {
  const comment = (over: Record<string, unknown> = {}): unknown => ({
    path: 'src/list.component.ts',
    line: 12,
    body: '![critical] This changes what the component stores.',
    user: { login: 'review-bot[bot]' },
    ...over,
  });

  it('matches the bot login with and without the [bot] suffix', () => {
    // Matching one spelling returns zero findings, which looks exactly like a pull request the bot
    // has not reached yet: a silent failure with a plausible explanation.
    expect(isBotLogin('review-bot', 'review-bot[bot]')).toBe(true);
    expect(isBotLogin('review-bot[bot]', 'review-bot')).toBe(true);
    expect(isBotLogin('someone-else', 'review-bot[bot]')).toBe(false);
  });

  it('carries an unknown badge through verbatim', () => {
    // Only two levels have ever been seen on this team's pull requests. Mapping an unseen one onto a
    // scale of ours would file a remark under a word the bot never used.
    expect(readSeverity('![banana] odd one')).toBe('banana');
    expect(readSeverity('![critical] bad')).toBe('critical');
    expect(readSeverity('![medium] meh')).toBe('medium');
  });

  it('keeps a comment that carries no badge at all', () => {
    const findings = parseBotComments([comment({ body: 'No badge here.' })], 'review-bot[bot]');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('');
  });

  it('ignores a comment written by a human', () => {
    expect(parseBotComments([comment({ user: { login: 'colleague' } })], 'review-bot[bot]')).toHaveLength(0);
  });

  it('places a comment whose hunk has moved, using the original line', () => {
    const findings = parseBotComments([comment({ line: null, original_line: 40 })], 'review-bot[bot]');
    expect(findings[0]?.line).toBe(40);
  });

  it('answers an empty list on a payload that is not an array', () => {
    expect(parseBotComments(null, 'review-bot[bot]')).toEqual([]);
  });

  it('tells "the bot found nothing" from "the bot has not run"', () => {
    expect(hasBotReviewed([{ user: { login: 'review-bot[bot]' } }], 'review-bot[bot]')).toBe(true);
    expect(hasBotReviewed([{ user: { login: 'colleague' } }], 'review-bot[bot]')).toBe(false);
    expect(hasBotReviewed([], 'review-bot[bot]')).toBe(false);
  });
});

/* Is a stored review still about the pull request as it stands. */
describe('isReviewCurrent', () => {
  const stored = (headSha: string): PullReview =>
    ({ headSha }) as PullReview;

  it('is true only when both shas are known and equal', () => {
    expect(isReviewCurrent(stored('a'.repeat(40)), pull({ headSha: 'a'.repeat(40) }))).toBe(true);
    expect(isReviewCurrent(stored('a'.repeat(40)), pull({ headSha: 'b'.repeat(40) }))).toBe(false);
  });

  it('is false when either sha is unknown, which asks for another review', () => {
    // The direction to be wrong in: never the one that approves a commit nobody read.
    expect(isReviewCurrent(stored(''), pull({ headSha: 'a'.repeat(40) }))).toBe(false);
    expect(isReviewCurrent(stored('a'.repeat(40)), pull({ headSha: '' }))).toBe(false);
  });
});

/*
 * The argument list a submission would use.
 *
 * The one test that makes "the body is never quoted" checkable rather than a claim in a comment.
 */
describe('reviewArgs', () => {
  const body = 'Nasty: "quotes", `backticks`, $(rm -rf /), %PATH% and a newline\nhere.';
  const args = reviewArgs({
    slug: 'example-org/web-app',
    number: 12,
    headSha: 'a'.repeat(40),
    event: 'REQUEST_CHANGES',
    bodyPath: 'C:/tmp/body.md',
  });

  it('never puts the body on the command line', () => {
    // It travels as bytes in a file, so nothing inside it can be read as an option or as syntax.
    expect(args.join('\0')).not.toContain(body);
    expect(args.join('\0')).toContain('body=@C:/tmp/body.md');
  });

  it('carries the event and the body in ONE call', () => {
    // Locks out the two-step version (`gh pr comment` then `gh pr review`), which is the one that
    // can half-fail: text posted, merge unblocked.
    expect(args).toContain('event=REQUEST_CHANGES');
    expect(args.filter((arg) => arg.startsWith('body=@'))).toHaveLength(1);
  });

  it('pins the review to the sha that was read', () => {
    // `gh pr review` has no such option, so a review landing after a push would be attributed to a
    // commit nobody reviewed.
    expect(args).toContain(`commit_id=${'a'.repeat(40)}`);
  });

  it('asks for the review id, which is the only thing that makes a review retractable', () => {
    expect(args.join(' ')).toContain('.id');
  });
});

/* The port a review workspace serves on. */
describe('withPort', () => {
  it('REPLACES a port the command already carries', () => {
    // Appending a second `--port` makes the result depend on which flag the CLI keeps, which is a
    // different answer per tool and per version.
    expect(withPort('npm start -- --port 4200', 4321)).toBe('npm start -- --port 4321');
    expect(withPort('ng serve --port=4200 --open', 4321)).toBe('ng serve --port=4321 --open');
  });

  it('appends one when the command carries none', () => {
    expect(withPort('npm start', 4321)).toBe('npm start --port 4321');
  });

  it('leaves the rest of the command alone', () => {
    expect(withPort('npm run start:dev -- --host 0.0.0.0 --port 4200', 5000)).toBe(
      'npm run start:dev -- --host 0.0.0.0 --port 5000',
    );
  });
});

/*
 * Which agent runs, and how it is called.
 *
 * Three of the four things a profile decides fail in silence when wrong, and none of them is
 * visible on screen: a headless run has no terminal tab. These pin the ones a test can reach.
 */
describe('buildHeadlessCommand', () => {
  it('builds the verified Claude Code command', () => {
    const { file, args } = buildHeadlessCommand(CLAUDE_CODE_PROFILE, {});
    expect(file).toBe('claude');
    expect(args).toContain('--print');
    expect(args.join(' ')).toContain('--allowedTools Read Grep Glob');
  });

  it('drops the model placeholder entirely when nothing is pinned', () => {
    // An empty `--model ""` is a run that fails before it starts, not a default.
    const { args } = buildHeadlessCommand(CLAUDE_CODE_PROFILE, { model: '' });
    expect(args).not.toContain('--model');
    expect(args.join(' ')).not.toContain('{model}');
  });

  it('expands the model through the profile\'s own flag, whatever its spelling', () => {
    // `--model X` and `-m X` are both common, so the spelling is a setting and not an assumption.
    const profile = { ...CLAUDE_CODE_PROFILE, modelFlag: '-m {model}' };
    expect(buildHeadlessCommand(profile, { model: 'opus' }).args).toContain('-m');
    expect(buildHeadlessCommand(profile, { model: 'opus' }).args).toContain('opus');
  });

  it('repeats the extra directory flag, and adds nothing when the agent has none', () => {
    const withFlag = buildHeadlessCommand(CLAUDE_CODE_PROFILE, { extraDirs: ['C:/repo'] });
    expect(withFlag.args.join(' ')).toContain('--add-dir C:/repo');

    const without = buildHeadlessCommand(
      { ...CLAUDE_CODE_PROFILE, extraDirFlag: '' },
      { extraDirs: ['C:/repo'] },
    );
    expect(without.args.join(' ')).not.toContain('C:/repo');
  });

  it('keeps a quoted path whole', () => {
    // The first thing a user writes, and the thing a naive split on spaces breaks.
    const profile = { ...CLAUDE_CODE_PROFILE, headless: '"C:/Program Files/agent.exe" --print' };
    expect(buildHeadlessCommand(profile, {}).file).toBe('C:/Program Files/agent.exe');
  });

  it('is not a shell', () => {
    // No expansion, no globbing, no substitution: the template is a list of arguments written on one
    // line, and treating it as a command line to interpret is how a setting becomes an injection.
    const profile = { ...CLAUDE_CODE_PROFILE, headless: 'agent $HOME *.ts' };
    expect(buildHeadlessCommand(profile, {}).args).toEqual(['$HOME', '*.ts']);
  });
});

describe('describeCommand', () => {
  it('quotes only what needs it, so the line can be pasted back into a shell', () => {
    expect(describeCommand('claude', ['--print', 'C:/a b/c'])).toBe('claude --print "C:/a b/c"');
  });
});

describe('readProfile', () => {
  it('fills anything missing from the profile it is given', () => {
    expect(readProfile({ label: 'Codex' }).headless).toBe(CLAUDE_CODE_PROFILE.headless);
    expect(readProfile({ label: 'Codex' }).label).toBe('Codex');
  });

  it('reads an unknown answer format as plain output, never as stream-json', () => {
    // Falling back the other way would parse an output that is not JSONL and report every run as
    // empty. Plain output always works; it only costs the progress detail.
    expect(readProfile({ answerFormat: 'whatever' }).answerFormat).toBe('stdout');
  });

  it('lets a flag be explicitly empty, which means "this agent has no such flag"', () => {
    expect(readProfile({ extraDirFlag: '' }).extraDirFlag).toBe('');
    expect(readProfile({ modelFlag: '' }).modelFlag).toBe('');
  });
});
