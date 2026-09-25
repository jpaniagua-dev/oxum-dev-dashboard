import { describe, expect, it } from 'vitest';
import type { PullReviewState, TriageState } from '../src/shared/contracts.js';
import {
  REVIEW_JOB_ID,
  TRIAGE_JOB_ID,
  describeElapsed,
  describeReviewTarget,
  jobRuns,
  reviewJob,
  triageJob,
} from '../src/shared/job-run.js';

/**
 * The two agent runs this app performs without a terminal, shaped so a board can draw them.
 *
 * What the tests below are really pinning is the one property the feature exists for: a run that is
 * going produces a card, and a run that is not produces nothing at all. Everything else is the text
 * on that card.
 */

const IDLE_TRIAGE: TriageState = {
  sprints: [{ id: 42, name: 'Sprint 12', state: 'active', boardName: 'Delivery' }],
  results: {},
  running: null,
  progress: null,
  error: null,
};

const IDLE_REVIEW: PullReviewState = {
  reviews: {},
  runs: {},
  running: false,
  progress: null,
  error: null,
  writesBlocked: null,
};

describe('triageJob', () => {
  it('is nothing at all when no analysis is running', () => {
    expect(triageJob(IDLE_TRIAGE)).toBeNull();
  });

  it('names the sprint it is analysing', () => {
    const job = triageJob({
      ...IDLE_TRIAGE,
      running: 42,
      progress: {
        sprintId: 42,
        phase: 'reading',
        detail: 'Reading schema.graphql',
        steps: 7,
        startedAt: '2026-09-25T08:00:00.000Z',
        tickets: 12,
      },
    });
    expect(job).not.toBeNull();
    expect(job?.id).toBe(TRIAGE_JOB_ID);
    expect(job?.subject).toBe('Sprint 12');
    expect(job?.detail).toBe('Reading schema.graphql');
    expect(job?.progress).toBe('12 tickets');
  });

  it('falls back to the id when the sprint is not in the list', () => {
    // Real: the analysis outlives a sprint list refreshed from Jira, and a card headed `undefined`
    // is worse than one headed by a number.
    const job = triageJob({
      ...IDLE_TRIAGE,
      progress: {
        sprintId: 99,
        phase: 'starting',
        detail: '',
        steps: 0,
        startedAt: '2026-09-25T08:00:00.000Z',
        tickets: 0,
      },
    });
    expect(job?.subject).toBe('Sprint 99');
  });

  it('reports no count before the sprint has been read', () => {
    // Zero tickets means "not known yet", not "a sprint holding nothing": the count arrives with
    // Jira's answer, and `0 tickets` on a card would be a claim the run has not made.
    const job = triageJob({
      ...IDLE_TRIAGE,
      progress: {
        sprintId: 42,
        phase: 'starting',
        detail: 'Starting Claude Code',
        steps: 0,
        startedAt: '2026-09-25T08:00:00.000Z',
        tickets: 0,
      },
    });
    expect(job?.progress).toBeNull();
  });
});

describe('reviewJob', () => {
  it('is nothing at all when no review is running', () => {
    expect(reviewJob(IDLE_REVIEW)).toBeNull();
  });

  it('counts the pull requests done out of the ones selected', () => {
    const job = reviewJob({
      ...IDLE_REVIEW,
      running: true,
      progress: {
        target: { kind: 'all', projectId: null },
        phase: 'reviewing',
        detail: 'web-app#588: reading list.component.ts',
        steps: 31,
        startedAt: '2026-09-25T08:00:00.000Z',
        pulls: 10,
        done: 3,
      },
    });
    expect(job?.id).toBe(REVIEW_JOB_ID);
    expect(job?.progress).toBe('3 of 10');
    expect(job?.detail).toBe('web-app#588: reading list.component.ts');
  });
});

describe('describeReviewTarget', () => {
  it('names a single pull request by its number', () => {
    expect(describeReviewTarget({ kind: 'pull', projectId: 'web-app', number: 588 })).toBe(
      'Pull request #588',
    );
  });

  it('distinguishes every open pull request from the ones not reviewed yet', () => {
    // The two run the same way and select differently, so a card that called them both `All` would
    // report the wrong size of job for the whole run.
    expect(describeReviewTarget({ kind: 'all', projectId: null })).not.toBe(
      describeReviewTarget({ kind: 'new', projectId: null }),
    );
  });
});

describe('jobRuns', () => {
  it('is empty when nothing is running, which is the normal state', () => {
    expect(jobRuns(IDLE_TRIAGE, IDLE_REVIEW)).toEqual([]);
  });

  it('accepts a state that has never been loaded', () => {
    // `triage` is null until the first push, and the board paints before that: a throw here would
    // take the whole surface down at boot.
    expect(jobRuns(null, null)).toEqual([]);
  });

  it('puts the analysis first when both are running, whatever started when', () => {
    const jobs = jobRuns(
      {
        ...IDLE_TRIAGE,
        progress: {
          sprintId: 42,
          phase: 'reading',
          detail: 'a',
          steps: 1,
          startedAt: '2026-09-25T09:00:00.000Z',
          tickets: 2,
        },
      },
      {
        ...IDLE_REVIEW,
        progress: {
          target: { kind: 'new', projectId: null },
          phase: 'reading',
          detail: 'b',
          steps: 1,
          startedAt: '2026-09-25T08:00:00.000Z',
          pulls: 2,
          done: 0,
        },
      },
    );
    expect(jobs.map((job) => job.kind)).toEqual(['triage', 'review']);
  });
});

describe('describeElapsed', () => {
  it('counts minutes and seconds, padded', () => {
    expect(describeElapsed('2026-09-25T08:00:00.000Z', new Date('2026-09-25T08:01:07.000Z'))).toBe(
      '1:07',
    );
  });

  it('never goes negative', () => {
    // Two clocks are involved when a stamp is made in the main process and read in the renderer, and
    // `-1:-5` on a card is a bug report about the wrong thing.
    expect(describeElapsed('2026-09-25T08:00:00.000Z', new Date('2026-09-25T07:59:50.000Z'))).toBe(
      '0:00',
    );
  });

  it('reads an unparseable stamp as zero rather than as NaN', () => {
    expect(describeElapsed('not a date', new Date('2026-09-25T08:00:00.000Z'))).toBe('0:00');
  });
});
