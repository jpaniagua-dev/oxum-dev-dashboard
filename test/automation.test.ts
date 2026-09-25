import { describe, expect, it } from 'vitest';
import type {
  JiraIssue,
  ProjectRow,
  PullRequest,
  RepoPulls,
  ServerPhase,
} from '../src/shared/contracts.js';
import {
  type AutomationRule,
  type AutomationWorld,
  canRun,
  evaluate,
  fillTemplate,
  isDue,
  isScheduled,
  quotePrompt,
  targetsFor,
} from '../src/shared/automation.js';

/**
 * Rules that act on their own.
 *
 * Three properties carry the whole feature and each is pinned by name below: a rule adopts what is
 * already true instead of shouting about it, a fact that stops being true can happen again, and a
 * repository whose poll failed is never read as a repository with nothing in it.
 */

function pulls(over: Partial<RepoPulls> = {}): RepoPulls {
  return {
    projectId: 'web-app',
    label: 'web-app',
    slug: 'example-org/web-app',
    pulls: [],
    checkedAt: '2026-09-25T08:00:00.000Z',
    error: null,
    ...over,
  };
}

function pull(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    title: `Pull ${String(number)}`,
    url: `https://github.com/example-org/web-app/pull/${String(number)}`,
    branch: `PROJ-${String(number)}-work`,
    authorLogin: 'dev',
    isDraft: false,
    review: 'review-required' as const,
    checks: 'passing' as const,
    passed: 1,
    failed: 0,
    pending: 0,
    isAuthor: true,
    isReviewer: false,
    updatedAt: '2026-09-25T08:00:00.000Z',
    headSha: 'a'.repeat(40),
    changedFiles: 3,
    ...over,
  };
}

function row(id: string, phase: ServerPhase): ProjectRow {
  return {
    project: {
      id,
      label: id,
      path: `C:/repos/${id}`,
      actions: [],
      kind: 'server',
      expectedPort: 4200,
      tags: [],
    },
    server: {
      phase,
      pid: null,
      port: null,
      errorSummary: null,
      errorCount: 0,
      owned: true,
    },
    git: null,
    workflows: null,
  };
}

function issue(key: string, isMine: boolean): JiraIssue {
  return {
    key,
    summary: 'Do the thing',
    status: 'To Do',
    stage: 'todo',
    type: 'Story',
    assignee: isMine ? 'Dev' : '',
    isMine,
    url: `https://example.atlassian.net/browse/${key}`,
    updatedAt: '2026-09-25T08:00:00.000Z',
  };
}

const EMPTY: AutomationWorld = { rows: [], pulls: [], issues: [] };

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'r1',
    name: 'Tell me',
    enabled: true,
    trigger: 'pull-approved',
    atMinute: null,
    everyMinutes: null,
    action: { kind: 'notify', text: '{{repo}}#{{number}} approved', projectId: null },
    armed: true,
    ...over,
  };
}

describe('targetsFor', () => {
  it('finds an approved pull request and carries its facts', () => {
    const world = {
      ...EMPTY,
      pulls: [pulls({ pulls: [pull(12, { review: 'approved' }), pull(13)] })],
    };
    const found = targetsFor('pull-approved', world);
    expect(found.map((t) => t.id)).toEqual(['pull:example-org/web-app#12']);
    expect(found[0]?.fields['number']).toBe('12');
    expect(found[0]?.projectId).toBe('web-app');
  });

  it('skips a repository whose poll FAILED, and never reads it as empty', () => {
    // The mistake this codebase keeps paying for: an errored poll hands back an empty list, which is
    // indistinguishable from every pull request having closed at once. Here it would only cost a
    // missed notification, but the shape is the one that closes a sprint of tickets elsewhere.
    const world = {
      ...EMPTY,
      pulls: [pulls({ pulls: [pull(12, { review: 'approved' })], error: 'gh failed' })],
    };
    expect(targetsFor('pull-approved', world)).toEqual([]);
  });

  it('skips a project with no GitHub remote rather than keying on null', () => {
    const world = { ...EMPTY, pulls: [pulls({ slug: null, pulls: [pull(1, { review: 'approved' })] })] };
    expect(targetsFor('pull-approved', world)).toEqual([]);
  });

  it('treats a crash, a failed build and a failed lint as broken, and stopped as not', () => {
    const world = {
      ...EMPTY,
      rows: [row('a', 'crashed'), row('b', 'build-error'), row('c', 'lint-error'), row('d', 'stopped'), row('e', 'serving')],
    };
    expect(targetsFor('server-broken', world).map((t) => t.fields['project'])).toEqual(['a', 'b', 'c']);
  });

  it('puts the phase in a server target id, so a crash and a failed build are two things', () => {
    expect(targetsFor('server-broken', { ...EMPTY, rows: [row('a', 'crashed')] })[0]?.id).toBe(
      'server:a:crashed',
    );
  });

  it('finds only the issues assigned to you', () => {
    const world = { ...EMPTY, issues: [issue('PROJ-1', true), issue('PROJ-2', false)] };
    expect(targetsFor('issue-assigned', world).map((t) => t.fields['key'])).toEqual(['PROJ-1']);
  });

  it('gives a scheduled rule no target at all', () => {
    // It is not on that path: the clock decides, and a constant id in the ledger would make a daily
    // rule fire exactly once ever.
    expect(targetsFor('schedule', EMPTY)).toEqual([]);
    expect(isScheduled('schedule')).toBe(true);
    expect(isScheduled('pull-approved')).toBe(false);
  });
});

describe('evaluate', () => {
  const approved: AutomationWorld = {
    ...EMPTY,
    pulls: [pulls({ pulls: [pull(12, { review: 'approved' })] })],
  };

  it('ADOPTS what is already true instead of shouting about it', () => {
    // The test that matters at boot. A rule created on a morning with nine approved pull requests
    // must say nothing about the nine, or the feature is a burst of stale news on first launch.
    const decision = evaluate([rule({ armed: false })], approved, {});
    expect(decision.firings).toEqual([]);
    expect(decision.armed).toEqual(['r1']);
    expect(decision.seen['r1']).toEqual(['pull:example-org/web-app#12']);
  });

  it('fires once the rule is armed, with the template filled', () => {
    const decision = evaluate([rule()], approved, {});
    expect(decision.firings).toHaveLength(1);
    expect(decision.firings[0]?.text).toBe('example-org/web-app#12 approved');
  });

  it('says nothing on the next tick about the same target', () => {
    const decision = evaluate([rule()], approved, { r1: ['pull:example-org/web-app#12'] });
    expect(decision.firings).toEqual([]);
  });

  it('FIRES AGAIN once the fact stopped being true and came back', () => {
    // The correction the first draft needed. A ledger that remembered for ever meant a server broke,
    // was fixed, broke again, and said nothing the second time.
    const broken: AutomationWorld = { ...EMPTY, rows: [row('a', 'crashed')] };
    const healthy: AutomationWorld = { ...EMPTY, rows: [row('a', 'serving')] };
    const crash = rule({ trigger: 'server-broken', action: { kind: 'notify', text: '{{project}} is {{phase}}', projectId: null } });

    const first = evaluate([crash], broken, {});
    expect(first.firings).toHaveLength(1);

    // Fixed: the tick fires nothing AND forgets the entry, which is the half that is easy to miss.
    const quiet = evaluate([crash], healthy, first.seen);
    expect(quiet.firings).toEqual([]);
    expect(quiet.seen['r1']).toEqual([]);

    const again = evaluate([crash], broken, quiet.seen);
    expect(again.firings).toHaveLength(1);
    expect(again.firings[0]?.text).toBe('a is crashed');
  });

  it('forgets on a tick that fires nothing, which is when things fall out', () => {
    const decision = evaluate([rule()], EMPTY, { r1: ['pull:example-org/web-app#12'] });
    expect(decision.seen['r1']).toEqual([]);
  });

  it('ignores a disabled rule entirely, ledger included', () => {
    const decision = evaluate([rule({ enabled: false })], approved, {});
    expect(decision.firings).toEqual([]);
    expect(decision.seen['r1']).toBeUndefined();
  });

  it('never evaluates a scheduled rule here', () => {
    const decision = evaluate([rule({ trigger: 'schedule', everyMinutes: 5 })], approved, {});
    expect(decision.firings).toEqual([]);
  });
});

describe('fillTemplate', () => {
  it('substitutes what it knows', () => {
    expect(fillTemplate('{{a}} and {{b}}', { a: 'one', b: 'two' })).toBe('one and two');
  });

  it('LEAVES an unknown name as written rather than blanking it', () => {
    // A typo has to read as a typo. Blanked, `PR {{titel}} was approved` becomes "PR  was approved",
    // a sentence that quietly lost its subject and that nobody can debug from the notification.
    expect(fillTemplate('PR {{titel}} approved', { title: 'x' })).toBe('PR {{titel}} approved');
  });

  it('leaves text with no placeholders alone', () => {
    expect(fillTemplate('nothing here', {})).toBe('nothing here');
  });
});

describe('isDue', () => {
  const at = (h: number, m: number): Date => new Date(2026, 8, 25, h, m, 0);

  it('an interval rule that has never run is due at once', () => {
    expect(isDue(rule({ trigger: 'schedule', everyMinutes: 30 }), null, at(9, 0))).toBe(true);
  });

  it('an interval rule waits out its interval', () => {
    const r = rule({ trigger: 'schedule', everyMinutes: 30 });
    expect(isDue(r, at(9, 0).toISOString(), at(9, 20))).toBe(false);
    expect(isDue(r, at(9, 0).toISOString(), at(9, 30))).toBe(true);
  });

  it('a daily rule waits for its hour rather than running at once', () => {
    // The reading that cannot surprise: an interval means "repeatedly, starting now", an hour means
    // "at that hour".
    const r = rule({ trigger: 'schedule', atMinute: 9 * 60 });
    expect(isDue(r, null, at(8, 59))).toBe(false);
    expect(isDue(r, null, at(9, 0))).toBe(true);
  });

  it('a daily rule that already ran today does not run again after a restart', () => {
    const r = rule({ trigger: 'schedule', atMinute: 9 * 60 });
    expect(isDue(r, at(9, 1).toISOString(), at(14, 0))).toBe(false);
    expect(isDue(r, new Date(2026, 8, 24, 9, 1).toISOString(), at(14, 0))).toBe(true);
  });

  it('a rule that says WHEN to run in neither way never runs', () => {
    // Rather than running on every tick, which is the direction to be wrong in. The settings form
    // refuses to save one; this is the second gate.
    expect(isDue(rule({ trigger: 'schedule' }), null, at(9, 0))).toBe(false);
  });

  it('is false for a disabled rule and for every non-scheduled trigger', () => {
    expect(isDue(rule({ trigger: 'schedule', everyMinutes: 5, enabled: false }), null, at(9, 0))).toBe(false);
    expect(isDue(rule({ trigger: 'pull-approved' }), null, at(9, 0))).toBe(false);
  });

  it('survives an unparseable last-run stamp by treating it as never', () => {
    expect(isDue(rule({ trigger: 'schedule', everyMinutes: 30 }), 'not a date', at(9, 0))).toBe(true);
  });
});

describe('quotePrompt', () => {
  it('escapes what a double-quoted shell argument reads as syntax', () => {
    // The four characters that mean something inside `"..."` in bash: a quote ends the argument,
    // a dollar and a backtick run something, and a backslash escapes whatever follows it.
    expect(quotePrompt('say "hi" $USER `now`')).toBe('say \\"hi\\" \\$USER \\`now\\`');
  });

  it('escapes the backslash itself, in the same pass', () => {
    // One pass over a character class rather than a chain of replaces: escaping the quote first
    // and the backslash after would put a backslash in front of the one it had just added.
    expect(quotePrompt('a\\b')).toBe('a\\\\b');
  });

  it('folds a newline to a space, because a prompt is ONE argument', () => {
    // A line break inside the quotes would end the command and run the rest as a second one, which
    // is the difference between a prompt that reads oddly and a machine running something else.
    expect(quotePrompt('first line\nsecond line')).toBe('first line second line');
    expect(quotePrompt('a\r\n\r\nb')).toBe('a b');
  });

  it('leaves ordinary text alone', () => {
    expect(quotePrompt('  check my inbox and file anything from the PO  ')).toBe(
      'check my inbox and file anything from the PO',
    );
  });
});

describe('canRun', () => {
  it('refuses a rule with no name, however enabled it says it is', () => {
    // The second gate. The form will not let a nameless rule be switched on, and this catches one
    // that reached the file another way: a rule's name is what its tab, its card and every line of
    // its log are called, so an unnamed one produces a session nobody can tell from another.
    expect(canRun(rule({ name: '' }))).toBe(false);
    expect(canRun(rule({ name: '   ' }))).toBe(false);
  });

  it('refuses a disabled rule, named or not', () => {
    expect(canRun(rule({ enabled: false }))).toBe(false);
  });

  it('allows a named, enabled rule', () => {
    expect(canRun(rule())).toBe(true);
  });

  it('is what stops an unnamed rule from firing and from being due', () => {
    const world: AutomationWorld = {
      ...EMPTY,
      pulls: [pulls({ pulls: [pull(12, { review: 'approved' })] })],
    };
    expect(evaluate([rule({ name: '' })], world, {}).firings).toEqual([]);
    expect(isDue(rule({ name: '', trigger: 'schedule', everyMinutes: 5 }), null, new Date())).toBe(
      false,
    );
  });
});

describe('evaluate, naming', () => {
  it('carries the rule name onto the firing, which is what names its tab', () => {
    const world: AutomationWorld = {
      ...EMPTY,
      pulls: [pulls({ pulls: [pull(12, { review: 'approved' })] })],
    };
    const decision = evaluate([rule({ name: 'Ping me on approval' })], world, {});
    expect(decision.firings[0]?.ruleName).toBe('Ping me on approval');
  });
});
