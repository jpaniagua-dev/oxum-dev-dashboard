import { describe, expect, it } from 'vitest';
import { parsePullPayload } from '../src/main/github/pulls-service.js';
import { parseRemoteSlug } from '../src/main/git/git-service.js';
import { describeAge, ownPulls } from '../src/renderer/ui/pull-list.js';

const ME = 'jpaniagua-dev';

/** Real payload captured from `gh pr list` on web-app, trimmed to the fields used. */
const REAL = JSON.stringify([
  {
    author: { login: 'jpaniagua-dev', name: 'Julio P.' },
    headRefName: 'PROJ-1674-user-profile-detail-page',
    isDraft: false,
    number: 580,
    reviewDecision: 'REVIEW_REQUIRED',
    reviewRequests: [
      { __typename: 'User', login: 'alex-martin' },
      { __typename: 'User', login: 'sam-reviewer' },
    ],
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
    ],
    title: 'PROJ 412 user profile detail page',
    updatedAt: '2026-08-04T15:15:06Z',
    url: 'https://github.com/example-org/web-app/pull/580',
  },
]);

describe('parsePullPayload', () => {
  it('reads the real payload', () => {
    const [pr] = parsePullPayload(REAL, ME);
    expect(pr).toMatchObject({
      number: 580,
      branch: 'PROJ-1674-user-profile-detail-page',
      authorLogin: 'jpaniagua-dev',
      review: 'review-required',
      isAuthor: true,
      isReviewer: false,
    });
    // One success and one in progress: pending wins, since nothing is settled yet.
    expect(pr?.checks).toBe('pending');
    expect(pr?.passed).toBe(1);
    expect(pr?.pending).toBe(1);
  });

  it('does not read an empty reviewDecision as an approval', () => {
    // `gh` returns "" when the repository requires no review. Calling that approved would invent a fact.
    const [pr] = parsePullPayload(
      JSON.stringify([{ number: 1, reviewDecision: '', author: { login: 'x' } }]),
      ME,
    );
    expect(pr?.review).toBe('none');
  });

  it('maps the three decisions', () => {
    const of = (decision: string): string | undefined =>
      parsePullPayload(JSON.stringify([{ number: 1, reviewDecision: decision }]), ME)[0]?.review;
    expect(of('APPROVED')).toBe('approved');
    expect(of('CHANGES_REQUESTED')).toBe('changes-requested');
    expect(of('REVIEW_REQUIRED')).toBe('review-required');
  });

  it('survives a review requested from a team, which has no login', () => {
    // Regression guard: a team entry carries `slug`, not `login`, and must be skipped rather than throw.
    const [pr] = parsePullPayload(
      JSON.stringify([
        {
          number: 2,
          author: { login: 'someone' },
          reviewRequests: [{ __typename: 'Team', slug: 'front-end' }, { __typename: 'User', login: ME }],
        },
      ]),
      ME,
    );
    expect(pr?.isReviewer).toBe(true);
  });

  it('treats an empty rollup as no-checks, never as green', () => {
    const [pr] = parsePullPayload(JSON.stringify([{ number: 3, statusCheckRollup: [] }]), ME);
    expect(pr?.checks).toBe('no-checks');
  });

  it('claims nothing when gh is not authenticated', () => {
    // An empty login must not make every pull request "mine".
    const [pr] = parsePullPayload(JSON.stringify([{ number: 4, author: { login: '' } }]), '');
    expect(pr?.isAuthor).toBe(false);
    expect(pr?.isReviewer).toBe(false);
  });

  it('returns nothing for empty or invalid output', () => {
    expect(parsePullPayload('', ME)).toEqual([]);
    expect(parsePullPayload('[]', ME)).toEqual([]);
    expect(parsePullPayload('not json', ME)).toEqual([]);
    expect(parsePullPayload('{"number":1}', ME)).toEqual([]);
  });

  it('drops entries without a number, which cannot be opened', () => {
    expect(parsePullPayload(JSON.stringify([{ title: 'ghost' }]), ME)).toEqual([]);
  });
});

describe('parseRemoteSlug', () => {
  it('reads the HTTPS form used by these clones', () => {
    expect(parseRemoteSlug('https://github.com/example-org/web-app.git')).toBe(
      'example-org/web-app',
    );
  });

  it('reads the SSH form', () => {
    expect(parseRemoteSlug('git@github.com:jpaniagua-dev/oxum-dev-dashboard.git')).toBe(
      'jpaniagua-dev/oxum-dev-dashboard',
    );
  });

  it('accepts a missing .git suffix and a token in the URL', () => {
    expect(parseRemoteSlug('https://github.com/owner/repo')).toBe('owner/repo');
    expect(parseRemoteSlug('https://token@github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('returns null for anything that is not GitHub', () => {
    expect(parseRemoteSlug('https://gitlab.com/owner/repo.git')).toBeNull();
    expect(parseRemoteSlug('C:/repos/local')).toBeNull();
    expect(parseRemoteSlug('')).toBeNull();
  });
});

describe('ownPulls', () => {
  const base = { label: 'Web', projectId: 'web', slug: 'o/r', checkedAt: null, error: null };
  const pull = (over: Record<string, unknown>): never =>
    ({
      number: 1,
      title: '',
      url: '',
      branch: '',
      authorLogin: '',
      isDraft: false,
      review: 'none',
      checks: 'no-checks',
      passed: 0,
      failed: 0,
      pending: 0,
      isAuthor: false,
      isReviewer: false,
      updatedAt: '',
      ...over,
    }) as never;

  it('keeps only what involves the user', () => {
    const repo = { ...base, pulls: [pull({ isAuthor: true }), pull({}), pull({ isReviewer: true })] };
    expect(ownPulls(repo as never)).toHaveLength(2);
  });
});

describe('describeAge', () => {
  const now = Date.parse('2026-08-04T18:00:00Z');

  it('counts in minutes, then hours, then days', () => {
    expect(describeAge('2026-08-04T17:30:00Z', now)).toBe('30 min');
    expect(describeAge('2026-08-04T12:00:00Z', now)).toBe('6 h');
    expect(describeAge('2026-08-01T18:00:00Z', now)).toBe('3 j');
  });

  it('says nothing about an unparseable date', () => {
    expect(describeAge('', now)).toBe('');
  });
});
