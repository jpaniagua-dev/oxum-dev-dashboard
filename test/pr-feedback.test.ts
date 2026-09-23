import { describe, expect, it } from 'vitest';
import {
  RESERVED_ACTION_PREFIX,
  feedbackActionId,
  workActionId,
  type AutoRunRecord,
  type IssueTransition,
  type PullRequest,
  type RepoPulls,
} from '../src/shared/contracts.js';
import { sameLogin } from '../src/main/github/bot-findings.js';
import {
  nextWatermark,
  parseReviewComments,
  type ReviewComment,
} from '../src/main/github/review-comments.js';
import {
  advanceRun,
  looksGone,
  matchRunPull,
  newFeedback,
  pullsFor,
} from '../src/main/feedback/feedback-rules.js';
import { pickDoneTransition } from '../src/main/jira/jira-start.js';
import { feedbackRefusal, type FeedbackGateInput } from '../src/main/feedback/feedback-gate.js';
import { buildFeedbackCommand } from '../src/main/feedback/feedback-command.js';
import type { AutoRunRecords } from '../src/main/autorun/auto-run-store.js';
import { readRecord } from '../src/main/autorun/auto-run-store.js';
import { FeedbackWatcher, type FeedbackPorts } from '../src/main/feedback/feedback-watcher.js';
import { describeRun, findRun } from '../src/renderer/ui/pull-list.js';
import type { AppSettings, Project } from '../src/shared/contracts.js';

const NOW = new Date('2026-09-21T10:00:00.000Z');

/** A payload entry shaped like GitHub's, so the parser is tested against what it actually meets. */
const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 100,
  path: 'src/app.ts',
  line: 12,
  in_reply_to_id: null,
  created_at: '2026-09-21T09:00:00Z',
  body: 'Consider renaming this',
  user: { login: 'hamza-mansouri' },
  ...over,
});

const comment = (id: number, authorLogin: string): ReviewComment =>
  parseReviewComments([raw({ id, user: { login: authorLogin } })])[0]!;

const record = (over: Partial<AutoRunRecord> = {}): AutoRunRecord => ({
  ticketKey: 'TEC-1801',
  projectId: 'neos',
  slug: 'Ethos-Services-SA/neos-shared-front',
  branch: 'TEC-1801-add-a-column',
  port: 1801,
  prNumber: 42,
  prMatchedAt: '2026-09-21T09:00:00.000Z',
  feedbackPhase: 'watching',
  lastSeenCommentId: 0,
  mergedAt: null,
  feedbackStartedAt: null,
  feedbackFinishedAt: null,
  pendingCount: 0,
  notice: null,
  lastRefusal: null,
  ...over,
});

/** A gate input nothing refuses, so each test below can spoil exactly one thing. */
const gate = (over: Partial<FeedbackGateInput> = {}): FeedbackGateInput => ({
  featureEnabled: true,
  viewerLogin: 'julphi127',
  projectKnown: true,
  phase: 'watching',
  state: 'OPEN',
  isDraft: false,
  originalRunActive: false,
  newCount: 1,
  ...over,
});

const pull = (over: Partial<PullRequest> = {}): PullRequest =>
  ({
    number: 42,
    title: 'TEC-1801: Add a column',
    url: 'https://github.com/x/y/pull/42',
    branch: 'TEC-1801-add-a-column',
    authorLogin: 'julphi127',
    isDraft: false,
    review: 'none',
    checks: 'passing',
    passed: 1,
    failed: 0,
    pending: 0,
    isAuthor: true,
    isReviewer: false,
    headSha: 'abc1234',
    changedFiles: 3,
    updatedAt: '2026-09-21T09:30:00Z',
    ...over,
  }) as PullRequest;

describe('parseReviewComments', () => {
  it('reads every field off a payload shaped like GitHub', () => {
    const [read] = parseReviewComments([raw({ in_reply_to_id: 99 })]);

    expect(read).toEqual({
      id: 100,
      authorLogin: 'hamza-mansouri',
      path: 'src/app.ts',
      line: 12,
      inReplyToId: 99,
      createdAt: '2026-09-21T09:00:00Z',
      body: 'Consider renaming this',
    });
  });

  it('skips a comment with no usable id', () => {
    // The one hard refusal: a comment that cannot be watermarked is one the watcher would rediscover
    // as new at every poll, for ever.
    expect(parseReviewComments([raw({ id: null }), raw({ id: 0 }), raw({ id: 1.5 })])).toEqual([]);
  });

  it('reads an absent reply target as null and never as zero', () => {
    // 0 is a legal watermark, so a thread root reported as 0 would read as a reply to whatever was
    // seen first.
    expect(parseReviewComments([raw({ in_reply_to_id: undefined })])[0]?.inReplyToId).toBeNull();
  });

  it('falls back to the original line when the hunk has moved, and keeps a file-level comment', () => {
    expect(parseReviewComments([raw({ line: null, original_line: 7 })])[0]?.line).toBe(7);
    expect(parseReviewComments([raw({ line: null, original_line: null })])[0]?.line).toBeNull();
  });

  it('survives a payload that is not an array, and skips an entry that is not an object', () => {
    expect(parseReviewComments(null)).toEqual([]);
    expect(parseReviewComments('nope')).toEqual([]);
    expect(parseReviewComments([raw(), 7, null])).toHaveLength(1);
  });
});

describe('sameLogin', () => {
  it('folds the case and a trailing bot suffix', () => {
    expect(sameLogin('Gemini-Code-Assist', 'gemini-code-assist[bot]')).toBe(true);
    expect(sameLogin('julphi127', 'JULPHI127')).toBe(true);
  });

  it('never matches an empty login', () => {
    // An empty login means "we do not know who we are", and answering true there would make
    // everything look like us.
    expect(sameLogin('', '')).toBe(false);
    expect(sameLogin('julphi127', '')).toBe(false);
  });
});

describe('nextWatermark', () => {
  it('takes the highest id seen, including our own comments', () => {
    expect(nextWatermark([comment(5, 'a'), comment(9, 'julphi127')], 0)).toBe(9);
  });

  it('never goes backwards, and an empty payload leaves it untouched', () => {
    expect(nextWatermark([comment(3, 'a')], 10)).toBe(10);
    expect(nextWatermark([], 10)).toBe(10);
  });
});

describe('newFeedback', () => {
  it('takes what arrived above the watermark from somebody else', () => {
    const fresh = newFeedback([comment(5, 'hamza-mansouri')], 4, 'julphi127');

    expect(fresh.map((entry) => entry.id)).toEqual([5]);
  });

  it('never counts a comment we wrote ourselves, whatever its id', () => {
    // The test this whole design turns on. The gh token is Julio's, so every reply the pass posts
    // comes back authored by the viewer; without this the pass relaunches on its own output.
    expect(newFeedback([comment(9999, 'julphi127')], 0, 'julphi127')).toEqual([]);
    expect(newFeedback([comment(9999, 'JULPHI127')], 0, 'julphi127')).toEqual([]);
  });

  it('treats the watermark as already seen, not as pending', () => {
    expect(newFeedback([comment(5, 'hamza-mansouri')], 5, 'julphi127')).toEqual([]);
  });

  it('counts the review bot, which is feedback like any other', () => {
    expect(newFeedback([comment(5, 'gemini-code-assist[bot]')], 0, 'julphi127')).toHaveLength(1);
  });

  it('yields nothing at all when the viewer login is empty', () => {
    // Belt to the gate's braces: with no login every reply looks like somebody else's, so a caller
    // that forgot the gate still cannot start that loop.
    expect(newFeedback([comment(5, 'hamza-mansouri')], 0, '')).toEqual([]);
  });
});

describe('matchRunPull', () => {
  it('matches the open pull request on our branch, authored by us', () => {
    expect(matchRunPull(record(), [pull()], 'julphi127')?.number).toBe(42);
  });

  it('refuses a pull request somebody else opened on the same branch', () => {
    expect(matchRunPull(record(), [pull({ authorLogin: 'hamza-mansouri' })], 'julphi127')).toBeNull();
  });

  it('matches on the ticket key whatever the skill called the rest of the branch', () => {
    // The app never learns the branch, the skill invents the kebab half, so the key is the only part
    // of the name this side knows.
    const other = pull({ branch: 'TEC-1801-something-else-entirely' });

    expect(matchRunPull(record({ branch: '' }), [other], 'julphi127')?.number).toBe(42);
  });

  it('does not let one ticket match another whose number starts the same way', () => {
    // The trailing dash is what makes the prefix safe: TEC-12- is not a prefix of TEC-123-.
    const neighbour = pull({ branch: 'TEC-18010-other-ticket' });

    expect(matchRunPull(record({ ticketKey: 'TEC-1801' }), [neighbour], 'julphi127')).toBeNull();
  });

  it('yields null rather than a guess when nothing matches', () => {
    expect(matchRunPull(record(), [], 'julphi127')).toBeNull();
    expect(matchRunPull(record({ ticketKey: '' }), [pull()], 'julphi127')).toBeNull();
    expect(matchRunPull(record(), [pull()], '')).toBeNull();
  });
});

describe('feedbackRefusal', () => {
  it('allows a pass when every rule holds', () => {
    expect(feedbackRefusal(gate())).toBeNull();
  });

  it('refuses when the feature is off', () => {
    expect(feedbackRefusal(gate({ featureEnabled: false }))).toBe(
      'Starting a feedback pass by itself is turned off in the settings',
    );
  });

  it('refuses when gh is signed out', () => {
    expect(feedbackRefusal(gate({ viewerLogin: '' }))).toBe('gh is not signed in');
  });

  it('refuses when the project has left the configuration', () => {
    expect(feedbackRefusal(gate({ projectKnown: false }))).toBe(
      'The repository this run came from is no longer configured',
    );
  });

  it('refuses a pass already running', () => {
    expect(feedbackRefusal(gate({ phase: 'passing' }))).toBe(
      'A feedback pass is already running on this pull request',
    );
  });

  it('refuses a pull request that has had its pass, with fifty brand new comments', () => {
    // The loop test, named as such. Every fix pushes a new head and every reply mints a higher id,
    // so the phase is the only thing that can say "once" and mean it.
    expect(feedbackRefusal(gate({ phase: 'done', newCount: 50 }))).toBe(
      'This pull request has already had its feedback pass',
    );
  });

  it('is not reset by anything about the head', () => {
    // Its twin: there is deliberately no headMoved input, a fix push being the expected outcome of a
    // pass rather than a race that invalidates it.
    expect(Object.keys(gate())).not.toContain('headMoved');
  });

  it('refuses a closed or drafted pull request, naming the state', () => {
    expect(feedbackRefusal(gate({ state: 'MERGED' }))).toBe('The pull request is merged');
    expect(feedbackRefusal(gate({ isDraft: true }))).toBe('The pull request went back to draft');
  });

  it('refuses while the run that opened the pull request is still going', () => {
    expect(feedbackRefusal(gate({ originalRunActive: true }))).toBe(
      'The run that opened this pull request is still going',
    );
  });

  it('refuses when there is nothing new', () => {
    expect(feedbackRefusal(gate({ newCount: 0 }))).toBe('No new review feedback');
  });

  it('does NOT refuse our own pull request', () => {
    // The explicit proof that review-gate's `postable` was inverted and not copied: that rule refuses
    // your own PR because GitHub rejects the write, and this feature exists for exactly those.
    expect(feedbackRefusal(gate())).toBeNull();
  });

  it('reports the first rule that fired, the order being the contract', () => {
    const broken = gate({ featureEnabled: false, viewerLogin: '', phase: 'done', newCount: 0 });

    expect(feedbackRefusal(broken)).toBe(
      'Starting a feedback pass by itself is turned off in the settings',
    );
  });
});

describe('advanceRun', () => {
  const comments = [comment(7, 'hamza-mansouri')];

  it('moves a watching record to passing, and says to start', () => {
    const advance = advanceRun(record(), comments, 'julphi127', gate(), NOW);

    expect(advance?.start).toBe(true);
    expect(advance?.record.feedbackPhase).toBe('passing');
    expect(advance?.record.lastSeenCommentId).toBe(7);
    expect(advance?.record.feedbackStartedAt).toBe(NOW.toISOString());
  });

  it('records what is waiting on a spent pull request, and starts nothing', () => {
    const spent = record({ feedbackPhase: 'done' });
    const advance = advanceRun(spent, comments, 'julphi127', gate({ phase: 'done' }), NOW);

    expect(advance?.start).toBe(false);
    expect(advance?.record.feedbackPhase).toBe('done');
    expect(advance?.record.pendingCount).toBe(1);
    expect(advance?.record.notice).toBe('1 comment waiting on you');
    expect(advance?.record.lastSeenCommentId).toBe(7);
  });

  it('touches nothing at all while a pass is in flight', () => {
    // Advancing the mark under a running pass would hide the very comments it was started to read.
    const running = record({ feedbackPhase: 'passing' });

    expect(advanceRun(running, comments, 'julphi127', gate({ phase: 'passing' }), NOW)).toBeNull();
  });

  it('reports nothing moved on a quiet poll, so the file is not rewritten', () => {
    const quiet = record({ feedbackPhase: 'done', lastRefusal: 'This pull request has already had its feedback pass' });

    expect(advanceRun(quiet, [], 'julphi127', gate({ phase: 'done', newCount: 0 }), NOW)).toBeNull();
  });

  it('keeps the refusal on the record so the row can say why nothing started', () => {
    const advance = advanceRun(record(), comments, 'julphi127', gate({ featureEnabled: false }), NOW);

    expect(advance?.record.lastRefusal).toBe(
      'Starting a feedback pass by itself is turned off in the settings',
    );
  });
});

describe('buildFeedbackCommand', () => {
  it('names the pr-feedback skill, the number and the repository', () => {
    const command = buildFeedbackCommand(42, 'neos-shared-front');

    expect(command).toContain('/pr-feedback 42 in the neos-shared-front repository');
    expect(command).toContain('--dangerously-skip-permissions');
  });

  it('omits the model flag when no model is pinned', () => {
    // `claude --model ""` is an error, not a default.
    expect(buildFeedbackCommand(42, 'web')).not.toContain('--model');
    expect(buildFeedbackCommand(42, 'web', 'opus')).toContain('--model "opus"');
  });

  it('drops the repository clause rather than saying "in the  repository"', () => {
    expect(buildFeedbackCommand(42, '///')).toContain('"/pr-feedback 42"');
  });

  it('refuses a number that is not one, rather than interpolating it', () => {
    expect(buildFeedbackCommand(0, 'web')).toBe('');
    expect(buildFeedbackCommand(-3, 'web')).toBe('');
    expect(buildFeedbackCommand(1.5, 'web')).toBe('');
  });
});

describe('feedbackActionId', () => {
  it('stays inside the reserved prefix, so a settings save cannot close the tab', () => {
    expect(feedbackActionId('a/b', 42).startsWith(RESERVED_ACTION_PREFIX)).toBe(true);
  });

  it('is one id per pull request, and never the ticket handoff id', () => {
    // Sharing would make a feedback pass land silently inside a live ticket session, since
    // runProjectCommand hands back a running tab of the same id instead of spawning.
    expect(feedbackActionId('a/b', 42)).toBe(feedbackActionId('a/b', 42));
    expect(feedbackActionId('a/b', 42)).not.toBe(feedbackActionId('a/b', 43));
    expect(feedbackActionId('a/b', 42)).not.toBe(workActionId(['TEC-1801']));
  });
});

describe('readRecord', () => {
  const stored = (over: Record<string, unknown> = {}): unknown => ({
    ticketKey: 'TEC-1801',
    projectId: 'neos',
    slug: 'a/b',
    branch: 'TEC-1801-x',
    feedbackPhase: 'watching',
    lastSeenCommentId: 7,
    ...over,
  });

  it('drops a row with no ticket key, that being its identity', () => {
    expect(readRecord(stored({ ticketKey: '' }))).toBeNull();
    expect(readRecord(null)).toBeNull();
  });

  it('reads an unknown phase as done, the value that starts nothing', () => {
    // The opposite of the house fallback, deliberately: a verdict only describes, a phase authorises,
    // so its safe reading is the one that authorises least.
    expect(readRecord(stored({ feedbackPhase: 'whatever' }))?.feedbackPhase).toBe('done');
    expect(readRecord(stored({ feedbackPhase: undefined }))?.feedbackPhase).toBe('done');
  });

  it('reads a missing or nonsense watermark as zero', () => {
    expect(readRecord(stored({ lastSeenCommentId: undefined }))?.lastSeenCommentId).toBe(0);
    expect(readRecord(stored({ lastSeenCommentId: -4 }))?.lastSeenCommentId).toBe(0);
  });

  it('keeps everything else it can read, rather than dropping the row', () => {
    // Dropping would lose the merge watcher's port and branch AND leave the pull request untracked,
    // which the branch join would then re-create in `watching`: a corrupt byte re-arming a pass.
    const read = readRecord(stored({ port: 1801, prNumber: 42, notice: 'x' }));

    expect(read?.port).toBe(1801);
    expect(read?.prNumber).toBe(42);
    expect(read?.notice).toBe('x');
    expect(read?.prMatchedAt).toBeNull();
  });
});


describe('FeedbackWatcher', () => {
  /** An in-memory stand-in, so a tick can be asserted to have written nothing. */
  const records = (seed: AutoRunRecord[]): AutoRunRecords & { writes: number } => {
    const map = new Map(seed.map((entry) => [entry.ticketKey.toUpperCase(), entry]));
    return {
      writes: 0,
      get: (key) => map.get(key.toUpperCase()),
      byPull: (slug, number) =>
        [...map.values()].find((entry) => entry.slug === slug && entry.prNumber === number),
      all: () => [...map.values()],
      set(entry) {
        map.set(entry.ticketKey.toUpperCase(), entry);
      },
      remove: (key) => map.delete(key.toUpperCase()),
      async write() {
        this.writes += 1;
      },
    };
  };

  const project = { id: 'neos', label: 'Neos', path: 'C:/repos/neos-shared-front' } as Project;

  /** The poll payload shape, since the watcher needs to tell a failed poll from an empty one. */
  const repos = (pulls: PullRequest[], error: string | null = null): RepoPulls[] => [
    {
      projectId: 'neos',
      label: 'Neos',
      slug: 'Ethos-Services-SA/neos-shared-front',
      pulls,
      checkedAt: '2026-09-21T10:00:00.000Z',
      error,
    },
  ];

  const settings = (over: Partial<AppSettings> = {}): AppSettings =>
    ({
      feedbackPassEnabled: true,
      agentWorkModel: '',
      workspaceRoot: '',
      agentProfile: { interactive: 'claude {model} --dangerously-skip-permissions' },
      ...over,
    }) as AppSettings;

  const ports = (over: Partial<FeedbackPorts> = {}): FeedbackPorts & { spawned: string[] } => {
    const spawned: string[] = [];
    return {
      spawned,
      readComments: async () => ({ value: [comment(7, 'hamza-mansouri')], error: null }),
      viewerLogin: async () => 'julphi127',
      isActionRunning: () => false,
      spawn: (input) => {
        spawned.push(input.command);
        return 't1' as never;
      },
      readState: async () => 'MERGED',
      closeTicket: async () => ({ ok: true, message: 'TEC-1801 moved to Done' }),
      stopServer: () => true,
      notify: () => {},
      now: () => NOW,
      ...over,
    };
  };

  it('launches one pass when feedback lands on a watched pull request', async () => {
    const store = records([record()]);
    const port = ports();
    await new FeedbackWatcher(store, settings, () => [project], port).tick(repos([pull()]));

    expect(port.spawned).toHaveLength(1);
    expect(port.spawned[0]).toContain('/pr-feedback 42');
    expect(store.get('TEC-1801')?.feedbackPhase).toBe('passing');
  });

  it('writes the record BEFORE it spawns, so a crash cannot leave two agents on one worktree', async () => {
    const order: string[] = [];
    const store = records([record()]);
    const wrapped: AutoRunRecords = { ...store, write: async () => void order.push('write') };
    const port = ports({
      spawn: () => {
        order.push('spawn');
        return 't1' as never;
      },
    });
    await new FeedbackWatcher(wrapped, settings, () => [project], port).tick(repos([pull()]));

    expect(order).toEqual(['write', 'spawn']);
  });

  it('launches nothing on a pull request whose pass is spent, however much arrives', async () => {
    const store = records([record({ feedbackPhase: 'done' })]);
    const port = ports();
    await new FeedbackWatcher(store, settings, () => [project], port).tick(repos([pull()]));

    expect(port.spawned).toEqual([]);
    expect(store.get('TEC-1801')?.pendingCount).toBe(1);
  });

  it('launches nothing while the feature is off', async () => {
    const port = ports();
    await new FeedbackWatcher(
      records([record()]),
      () => settings({ feedbackPassEnabled: false }),
      () => [project],
      port,
    ).tick(repos([pull()]));

    expect(port.spawned).toEqual([]);
  });

  it('launches nothing when the only comments are our own replies', async () => {
    const port = ports({ readComments: async () => ({ value: [comment(9, 'julphi127')], error: null }) });
    await new FeedbackWatcher(records([record()]), settings, () => [project], port).tick(repos([pull()]));

    expect(port.spawned).toEqual([]);
  });

  it('launches nothing while the run that opened the pull request is still going', async () => {
    const port = ports({ isActionRunning: () => true });
    await new FeedbackWatcher(records([record()]), settings, () => [project], port).tick(repos([pull()]));

    expect(port.spawned).toEqual([]);
  });

  it('fills in the pull request number from the poll, once', async () => {
    const store = records([record({ prNumber: null, prMatchedAt: null })]);
    await new FeedbackWatcher(store, settings, () => [project], ports()).tick(repos([pull()]));

    expect(store.get('TEC-1801')?.prNumber).toBe(42);
    expect(store.get('TEC-1801')?.branch).toBe('TEC-1801-add-a-column');
    expect(store.get('TEC-1801')?.prMatchedAt).toBe(NOW.toISOString());
  });

  it('stops writing once it has said what it had to say', async () => {
    // The first poll records the refusal, which is new information. Every poll after it must write
    // nothing, or a spent pull request rewrites auto-runs.json every three minutes for ever.
    const store = records([record({ feedbackPhase: 'done', lastSeenCommentId: 7 })]);
    const port = ports();
    const watcher = new FeedbackWatcher(store, settings, () => [project], port);

    await watcher.tick(repos([pull()]));
    const afterFirst = store.writes;
    await watcher.tick(repos([pull()]));
    await watcher.tick(repos([pull()]));

    expect(afterFirst).toBe(1);
    expect(store.writes).toBe(1);
    expect(port.spawned).toEqual([]);
  });

  it('treats a failed read as unknown rather than as an empty pull request', async () => {
    const store = records([record()]);
    const port = ports({ readComments: async () => ({ value: null, error: 'gh exploded' }) });
    await new FeedbackWatcher(store, settings, () => [project], port).tick(repos([pull()]));

    expect(port.spawned).toEqual([]);
    expect(store.get('TEC-1801')?.lastRefusal).toBeNull();
  });

  it('does nothing for a pull request that has left the open list', async () => {
    const store = records([record()]);
    const port = ports();
    await new FeedbackWatcher(store, settings, () => [project], port).tick(repos([]));

    expect(port.spawned).toEqual([]);
    expect(store.get('TEC-1801')?.feedbackPhase).toBe('watching');
  });
});

describe('findRun', () => {
  it('matches the record filed under this repository and number', () => {
    expect(findRun([record()], 'Ethos-Services-SA/neos-shared-front', 42)?.ticketKey).toBe('TEC-1801');
  });

  it('finds nothing for a pull request nobody ran unattended', () => {
    // The normal case on this tab, which is mostly other people's work. It must draw nothing rather
    // than guess at the nearest record.
    expect(findRun([record()], 'Ethos-Services-SA/neos-shared-front', 43)).toBeUndefined();
    expect(findRun([record()], 'someone/else', 42)).toBeUndefined();
    expect(findRun([record()], null, 42)).toBeUndefined();
  });
});

describe('describeRun', () => {
  it('says nothing about a pull request with no record', () => {
    expect(describeRun(undefined)).toBeNull();
  });

  it('says a pass is running, whatever else the record carries', () => {
    expect(describeRun(record({ feedbackPhase: 'passing', notice: 'stale' }))).toBe('treating feedback');
  });

  it('prefers what happened to what did not', () => {
    // A row showing both would ask its reader to work out which of the two is the current fact.
    const both = record({ notice: '2 comments waiting on you', lastRefusal: 'No new review feedback' });

    expect(describeRun(both)).toBe('2 comments waiting on you');
  });

  it('falls back to the refusal, so a row that started nothing can say why', () => {
    expect(describeRun(record({ notice: null, lastRefusal: 'gh is not signed in' }))).toBe(
      'gh is not signed in',
    );
    expect(describeRun(record())).toBeNull();
  });
});

describe('pickDoneTransition', () => {
  const move = (id: string, label: string, stage: IssueTransition['stage']): IssueTransition =>
    ({ id, label, stage }) as IssueTransition;

  it('chooses by category, whatever the column is called', () => {
    // A board that calls it "Terminé" is one on which matching the word "done" finds nothing, which is
    // the whole reason the category decides.
    expect(pickDoneTransition([move('1', 'En cours', 'in-progress'), move('2', 'Terminé', 'done')])?.id).toBe('2');
  });

  it('uses the name only to break a tie between two done moves', () => {
    const picked = pickDoneTransition([move('1', 'Rejected', 'done'), move('2', 'Done', 'done')]);

    expect(picked?.id).toBe('2');
  });

  it('falls back to the first done move when no word helps', () => {
    expect(pickDoneTransition([move('7', 'Shipped', 'done'), move('8', 'Archived', 'done')])?.id).toBe('7');
  });

  it('returns null when the workflow offers no done move from here', () => {
    // A real answer and not a failure: a board that needs review before done has none from in progress.
    expect(pickDoneTransition([move('1', 'In review', 'in-progress')])).toBeNull();
    expect(pickDoneTransition([])).toBeNull();
  });
});

describe('looksGone', () => {
  const repo = (pulls: PullRequest[], error: string | null = null): RepoPulls[] => [
    {
      projectId: 'neos',
      label: 'Neos',
      slug: 'Ethos-Services-SA/neos-shared-front',
      pulls,
      checkedAt: '',
      error,
    },
  ];

  it('says a tracked pull request has left the open list', () => {
    expect(looksGone(record(), repo([]))).toBe(true);
  });

  it('says nothing about one still listed', () => {
    expect(looksGone(record(), repo([pull()]))).toBe(false);
  });

  it('refuses to read a FAILED poll as a merge', () => {
    // The guard that matters most here. A repository whose poll failed hands back an empty list with
    // an error, which looks exactly like every one of its pull requests being merged at once: reading
    // that as gone would close a sprint's worth of tickets on a network blip.
    expect(looksGone(record(), repo([], 'gh: network unreachable'))).toBe(false);
  });

  it('refuses to conclude anything from a repository the poll did not cover', () => {
    expect(looksGone(record(), [])).toBe(false);
  });

  it('leaves a record with no pull request, and a retired one, alone', () => {
    expect(looksGone(record({ prNumber: null }), repo([]))).toBe(false);
    expect(looksGone(record({ mergedAt: '2026-09-21T09:00:00.000Z' }), repo([]))).toBe(false);
  });
});

describe('pullsFor', () => {
  it('hands back nothing when that repository errored, rather than an empty truth', () => {
    const errored: RepoPulls[] = [
      { projectId: 'neos', label: 'Neos', slug: 'a/b', pulls: [pull()], checkedAt: '', error: 'boom' },
    ];

    expect(pullsFor(record(), errored)).toEqual([]);
  });
});

describe('FeedbackWatcher: closing a merged ticket', () => {
  const records = (seed: AutoRunRecord[]): AutoRunRecords & { writes: number } => {
    const map = new Map(seed.map((entry) => [entry.ticketKey.toUpperCase(), entry]));
    return {
      writes: 0,
      get: (key) => map.get(key.toUpperCase()),
      byPull: (slug, number) =>
        [...map.values()].find((entry) => entry.slug === slug && entry.prNumber === number),
      all: () => [...map.values()],
      set(entry) {
        map.set(entry.ticketKey.toUpperCase(), entry);
      },
      remove: (key) => map.delete(key.toUpperCase()),
      async write() {
        this.writes += 1;
      },
    };
  };

  const project = { id: 'neos', label: 'Neos', path: 'C:/repos/neos-shared-front' } as Project;
  const settings = (): AppSettings =>
    ({
      feedbackPassEnabled: true,
      agentWorkModel: '',
      workspaceRoot: '',
      agentProfile: { interactive: 'claude {model} --dangerously-skip-permissions' },
    }) as AppSettings;

  const empty = (error: string | null = null): RepoPulls[] => [
    { projectId: 'neos', label: 'Neos', slug: 'Ethos-Services-SA/neos-shared-front', pulls: [], checkedAt: '', error },
  ];

  const ports = (
    over: Partial<FeedbackPorts> = {},
  ): FeedbackPorts & { closed: string[]; stopped: string[]; said: string[] } => {
    const closed: string[] = [];
    const stopped: string[] = [];
    const said: string[] = [];
    return {
      closed,
      stopped,
      said,
      readComments: async () => ({ value: [], error: null }),
      viewerLogin: async () => 'julphi127',
      isActionRunning: () => false,
      spawn: () => 't1' as never,
      readState: async () => 'MERGED',
      closeTicket: async (key) => {
        closed.push(key);
        return { ok: true, message: `${key} moved to Done` };
      },
      stopServer: (projectId) => {
        stopped.push(projectId);
        return true;
      },
      notify: (title) => void said.push(title),
      now: () => NOW,
      ...over,
    };
  };

  it('closes the ticket, stops the server and says so when the pull request was merged', async () => {
    const store = records([record()]);
    const port = ports();
    await new FeedbackWatcher(store, settings, () => [project], port).tick(empty());

    expect(port.closed).toEqual(['TEC-1801']);
    expect(port.stopped).toEqual(['neos']);
    expect(store.get('TEC-1801')?.mergedAt).toBe(NOW.toISOString());
    expect(store.get('TEC-1801')?.notice).toContain('Merged');
    // The one moment where there is nothing left to do and nobody has been told: the pull request
    // left the list minutes ago and the tab may not have been open since.
    expect(port.said).toEqual(['TEC-1801 is merged']);
  });

  it('says nothing when it decided nothing', async () => {
    const port = ports({ readState: async () => null });
    await new FeedbackWatcher(records([record()]), settings, () => [project], port).tick(empty());

    expect(port.said).toEqual([]);
  });

  it('says nothing twice about one merge', async () => {
    const store = records([record()]);
    const port = ports();
    const watcher = new FeedbackWatcher(store, settings, () => [project], port);

    await watcher.tick(empty());
    await watcher.tick(empty());

    expect(port.said).toEqual(['TEC-1801 is merged']);
  });

  it('leaves the board alone when the pull request was closed rather than merged', async () => {
    const store = records([record()]);
    const port = ports({ readState: async () => 'CLOSED' });
    await new FeedbackWatcher(store, settings, () => [project], port).tick(empty());

    expect(port.closed).toEqual([]);
    expect(store.get('TEC-1801')?.mergedAt).toBe(NOW.toISOString());
    expect(store.get('TEC-1801')?.notice).toContain('closed');
  });

  it('does nothing at all when GitHub could not be asked', async () => {
    // Waiting three minutes costs nothing next to closing a ticket somebody abandoned on purpose.
    const store = records([record()]);
    const port = ports({ readState: async () => null });
    await new FeedbackWatcher(store, settings, () => [project], port).tick(empty());

    expect(port.closed).toEqual([]);
    expect(store.get('TEC-1801')?.mergedAt).toBeNull();
    expect(store.writes).toBe(0);
  });

  it('does nothing when the repository poll failed', async () => {
    const store = records([record()]);
    const port = ports();
    await new FeedbackWatcher(store, settings, () => [project], port).tick(empty('gh exploded'));

    expect(port.closed).toEqual([]);
    expect(store.get('TEC-1801')?.mergedAt).toBeNull();
  });

  it('closes a ticket once and never again', async () => {
    const store = records([record()]);
    const port = ports();
    const watcher = new FeedbackWatcher(store, settings, () => [project], port);

    await watcher.tick(empty());
    await watcher.tick(empty());
    await watcher.tick(empty());

    expect(port.closed).toEqual(['TEC-1801']);
  });

  it('says the worktree is still there, rather than removing it', async () => {
    // The one irreversible act in the chain, on a directory that can still hold uncommitted work. The
    // Worktrees tab owns that gesture and already shows whether the checkout is clean.
    const store = records([record()]);
    await new FeedbackWatcher(store, settings, () => [project], ports()).tick(empty());

    expect(store.get('TEC-1801')?.notice).toContain('worktree TEC-1801-add-a-column left to remove');
  });
});
