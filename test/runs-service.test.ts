import { describe, expect, it } from 'vitest';
import { classifyRun, parseRunsPayload } from '../src/main/github/runs-service.js';
import { presentWorkflows } from '../src/renderer/ui/presenters.js';

/** Shape captured from `gh run list --json status`, which returns that one field and nothing else. */
const run = (status: string): string => JSON.stringify({ status });

const payload = (...statuses: string[]): string => `[${statuses.map(run).join(',')}]`;

describe('classifyRun', () => {
  it('reads the four ways of not having started as queued', () => {
    for (const status of ['queued', 'waiting', 'requested', 'pending']) {
      expect(classifyRun({ status })).toBe('queued');
    }
  });

  it('separates a running run from a finished one', () => {
    expect(classifyRun({ status: 'in_progress' })).toBe('running');
    expect(classifyRun({ status: 'completed' })).toBe('done');
  });

  it('ignores a status it does not know rather than calling it running', () => {
    // The asymmetry is the point: a wrong "running" would light the column up for good.
    expect(classifyRun({ status: 'some_future_status' })).toBe('ignored');
    expect(classifyRun({})).toBe('ignored');
    expect(classifyRun(null)).toBe('ignored');
  });
});

describe('parseRunsPayload', () => {
  it('counts what is in flight and ignores what has finished', () => {
    expect(parseRunsPayload(payload('completed', 'in_progress', 'queued', 'completed'))).toEqual({
      verdict: 'running',
      running: 1,
      queued: 1,
    });
  });

  it('reports idle when every run has finished', () => {
    expect(parseRunsPayload(payload('completed', 'completed'))).toEqual({
      verdict: 'idle',
      running: 0,
      queued: 0,
    });
  });

  it('tells an empty list apart from an idle pipeline', () => {
    // `gh run list` answers `[]` with exit code 0 on a repository that has no workflow at all —
    // verified on a real one. Reporting that as `idle` would claim a CI setup that does not exist.
    expect(parseRunsPayload('[]')).toEqual({ verdict: 'no-runs', running: 0, queued: 0 });
  });

  it('falls back to unknown on anything that is not a list of runs', () => {
    expect(parseRunsPayload('not json').verdict).toBe('unknown');
    expect(parseRunsPayload('{"status":"in_progress"}').verdict).toBe('unknown');
  });
});

describe('presentWorkflows', () => {
  it('sums running and queued in the label, and splits them in the tooltip', () => {
    const pill = presentWorkflows({
      verdict: 'running',
      running: 2,
      queued: 1,
      checkedAt: '2026-08-30T09:00:00Z',
      error: null,
    });
    expect(pill.label).toBe('running 3');
    expect(pill.tone).toBe('busy');
    expect(pill.title).toContain('2 run(s) in progress');
    expect(pill.title).toContain('1 queued');
  });

  it('keeps every quiet state neutral, so only a running one catches the eye', () => {
    const quiet = (['idle', 'no-runs', 'no-repo', 'unknown'] as const).map((verdict) =>
      presentWorkflows({ verdict, running: 0, queued: 0, checkedAt: null, error: null }),
    );
    expect(quiet.every((pill) => pill.tone === 'neutral')).toBe(true);
    // Four distinct labels: a column that says the same thing for four different situations is a
    // column that has to be checked elsewhere.
    expect(new Set(quiet.map((pill) => pill.label)).size).toBe(4);
  });

  it('shows the error in the tooltip when the lookup failed', () => {
    const pill = presentWorkflows({
      verdict: 'unknown',
      running: 0,
      queued: 0,
      checkedAt: null,
      error: 'gh: could not resolve to a Repository',
    });
    expect(pill.title).toBe('gh: could not resolve to a Repository');
  });
});
