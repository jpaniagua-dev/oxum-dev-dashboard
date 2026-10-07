import { describe, expect, it } from 'vitest';
import {
  CARD_WIDTH,
  QUIET_AFTER_MS,
  ZOOM_MAX,
  ZOOM_MIN,
  activityOf,
  cardInView,
  centreCardView,
  clampZoom,
  defaultPoint,
  fitView,
  projectSubtitle,
  sessionCardKind,
  zoomAbout,
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

describe('fitView', () => {
  const viewport = { x: 24, y: 48, width: 800, height: 600 };

  it('centres cards that fit, without enlarging them past 100%', () => {
    const view = fitView({ x: 100, y: 100, width: 200, height: 100 }, viewport);
    expect(view.zoom).toBe(1);
    expect(view.pan).toEqual({ x: 24 + 300 - 100, y: 48 + 250 - 100 });
  });

  it('zooms out until the widest side fits', () => {
    const view = fitView({ x: 0, y: 0, width: 1600, height: 300 }, viewport);
    expect(view.zoom).toBe(0.5);
    expect(view.pan.x).toBe(24);
  });

  it('keeps the top left in view when even the minimum zoom is too large', () => {
    const view = fitView({ x: 50, y: 70, width: 10_000, height: 10_000 }, viewport);
    expect(view.zoom).toBe(ZOOM_MIN);
    expect(view.pan).toEqual({ x: 24 - 50 * ZOOM_MIN, y: 48 - 70 * ZOOM_MIN });
  });
});

describe('centreCardView', () => {
  it('centres a new card inside a narrow canvas left beside a wide sidebar', () => {
    const card = { x: 540, y: 160, width: 240, height: 112 };
    const viewport = { x: 24, y: 48, width: 360, height: 500 };
    const pan = centreCardView(card, viewport, 1);

    expect(pan.x + (card.x + card.width / 2)).toBe(viewport.x + viewport.width / 2);
    expect(pan.y + (card.y + card.height / 2)).toBe(viewport.y + viewport.height / 2);
  });

  it('accounts for the current zoom when centring', () => {
    const card = { x: 300, y: 200, width: 240, height: 112 };
    const viewport = { x: 20, y: 40, width: 700, height: 500 };
    const pan = centreCardView(card, viewport, 0.5);

    expect(pan.x + (card.x + card.width / 2) * 0.5).toBe(viewport.x + viewport.width / 2);
    expect(pan.y + (card.y + card.height / 2) * 0.5).toBe(viewport.y + viewport.height / 2);
  });
});

describe('cardInView', () => {
  const viewport = { x: 24, y: 48, width: 600, height: 400 };
  const card = { x: 100, y: 100, width: 240, height: 112 };

  it('leaves a card in plain sight alone, which is what a click on it must do', () => {
    expect(cardInView(card, viewport, { x: 0, y: 0 }, 1)).toBe(true);
  });

  it('wants to move a card that is off screen or cut by an edge', () => {
    expect(cardInView(card, viewport, { x: -500, y: 0 }, 1)).toBe(false);
    // Its right edge under the sidebar: 100 + 240 = 340 past a 300px-wide visible canvas.
    expect(cardInView(card, { ...viewport, width: 300 }, { x: 0, y: 0 }, 1)).toBe(false);
  });

  it('measures at the current zoom', () => {
    const far = { x: 800, y: 100, width: 240, height: 112 };
    expect(cardInView(far, viewport, { x: 0, y: 0 }, 1)).toBe(false);
    expect(cardInView(far, viewport, { x: 0, y: 0 }, 0.5)).toBe(true);
  });
});

describe('zoomAbout', () => {
  it('keeps the canvas point under the anchor in place', () => {
    const anchor = { x: 300, y: 200 };
    const pan = { x: 40, y: -20 };
    const before = { x: (anchor.x - pan.x) / 1, y: (anchor.y - pan.y) / 1 };
    const next = zoomAbout(anchor, pan, 1, 1.5);
    expect(next.x + before.x * 1.5).toBeCloseTo(anchor.x);
    expect(next.y + before.y * 1.5).toBeCloseTo(anchor.y);
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
