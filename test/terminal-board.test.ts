import { describe, expect, it } from 'vitest';
import {
  CARD_WIDTH,
  QUIET_AFTER_MS,
  ZOOM_MAX,
  ZOOM_MIN,
  activityOf,
  clampZoom,
  defaultPoint,
  projectSubtitle,
  sessionCardKind,
} from '../src/renderer/ui/terminal-board.js';
import type { TerminalSession } from '../src/shared/contracts.js';

/**
 * A session's activity is derived from **when it last spoke**, never from what it said.
 *
 * Matching strings would let a card claim "waiting for your answer", and it would be wrong the first
 * time Claude Code reworded a prompt or a program printed something that looked like one. Bytes
 * arriving is a fact about any process whatsoever, which is why this is the rule pinned here.
 */
describe('activityOf', () => {
  const NOW = 1_000_000;

  it('calls a session working while its output is still fresh', () => {
    expect(activityOf(true, NOW - 100, NOW)).toBe('working');
    expect(activityOf(true, NOW - (QUIET_AFTER_MS - 1), NOW)).toBe('working');
  });

  it('calls it quiet once the silence passes the window', () => {
    expect(activityOf(true, NOW - QUIET_AFTER_MS, NOW)).toBe('quiet');
    expect(activityOf(true, NOW - 60_000, NOW)).toBe('quiet');
  });

  it('calls a session never heard from quiet, not working', () => {
    // At boot the renderer adopts sessions it has not seen a byte of. Claiming those are busy is a
    // statement made about nothing.
    expect(activityOf(true, undefined, NOW)).toBe('quiet');
  });

  it('calls a dead process exited whatever it was doing a moment ago', () => {
    // `running` wins over the clock: a session that crashed mid-sentence stamped its last output a
    // millisecond ago, and "working" would be the one reading nobody could act on.
    expect(activityOf(false, NOW - 1, NOW)).toBe('exited');
    expect(activityOf(false, undefined, NOW)).toBe('exited');
  });

  it('cannot tell waiting for an answer from finished, and does not pretend to', () => {
    // Both are silence. The distinction needs a signal from the program itself, which on Claude Code
    // means its hooks. Written as a test so the limit is stated where it would be forgotten.
    const waiting = activityOf(true, NOW - 10_000, NOW);
    const finished = activityOf(true, NOW - 10_000, NOW);
    expect(waiting).toBe(finished);
  });
});

describe('defaultPoint', () => {
  it('lays untouched cards out in a grid rather than a heap', () => {
    // Two new sessions landing on the same coordinates is one card nobody knows is there.
    const points = [0, 1, 2, 3].map(defaultPoint);
    const seen = new Set(points.map((point) => `${point.x}:${point.y}`));
    expect(seen.size).toBe(4);
  });

  it('wraps to a new row rather than running off to the right', () => {
    expect(defaultPoint(0).y).toBe(defaultPoint(2).y);
    expect(defaultPoint(3).y).toBeGreaterThan(defaultPoint(0).y);
    expect(defaultPoint(3).x).toBe(defaultPoint(0).x);
  });

  it('leaves a gap between two cards of a row', () => {
    expect(defaultPoint(1).x - defaultPoint(0).x).toBeGreaterThan(CARD_WIDTH);
  });
});

describe('clampZoom', () => {
  it('keeps the zoom inside what the buttons offer', () => {
    expect(clampZoom(5)).toBe(ZOOM_MAX);
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(1)).toBe(1);
  });

  it('falls back to 1 for anything that is not a finite number', () => {
    // Not clamped to the nearest bound: NaN compares false against everything, so a clamp written
    // with Math.min/Math.max lets it straight through, and a plane scaled by NaN renders nothing at
    // all with no gesture left to bring it back. Infinity takes the same road for one reason, which
    // is that a single answer for "this is not a zoom" is easier to hold than two.
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(1);
  });
});

describe('session card presentation', () => {
  it('distinguishes agents, servers and build watchers', () => {
    const agent = {} as NonNullable<TerminalSession['agent']>;
    expect(sessionCardKind({ agent, role: null }, null)).toBe('agent');
    expect(sessionCardKind({ agent: null, role: 'server' }, 'server')).toBe('server');
    expect(sessionCardKind({ agent: null, role: 'server' }, 'watch')).toBe('build');
    expect(sessionCardKind({ agent: null, role: null }, null)).toBe('terminal');
  });

  it('drops a project subtitle only when the action title already names it', () => {
    expect(projectSubtitle('Design system · run', 'Design system')).toBeNull();
    expect(projectSubtitle('Design system', 'Design system')).toBeNull();
    expect(projectSubtitle('Docs build', 'Design system')).toBe('Design system');
  });
});
