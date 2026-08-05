import { describe, expect, it } from 'vitest';
import { decideTerminalKey } from '../src/renderer/ui/terminal-pane.js';

type Key = Parameters<typeof decideTerminalKey>[0];

function key(over: Partial<Key> = {}): Key {
  return {
    type: 'keydown',
    key: 'c',
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...over,
  };
}

describe('decideTerminalKey', () => {
  it('copies Ctrl+C when there is a selection', () => {
    expect(decideTerminalKey(key({ key: 'c' }), true)).toBe('copy');
  });

  it('leaves Ctrl+C as SIGINT when there is no selection', () => {
    // The one that must never regress: this is how a dev server gets stopped.
    expect(decideTerminalKey(key({ key: 'c' }), false)).toBe('pass');
  });

  it('always copies with Ctrl+Shift+C, selection or not', () => {
    // `Ctrl+Shift+C` means nothing to a shell, so it can be unconditional.
    expect(decideTerminalKey(key({ key: 'c', shiftKey: true }), false)).toBe('copy');
    expect(decideTerminalKey(key({ key: 'C', shiftKey: true }), true)).toBe('copy');
  });

  it('always pastes with Ctrl+V', () => {
    expect(decideTerminalKey(key({ key: 'v' }), false)).toBe('paste');
    expect(decideTerminalKey(key({ key: 'V', shiftKey: true }), true)).toBe('paste');
  });

  it('ignores keyup, so one press does not act twice', () => {
    expect(decideTerminalKey(key({ type: 'keyup', key: 'v' }), false)).toBe('pass');
  });

  it('leaves everything else to the shell', () => {
    expect(decideTerminalKey(key({ key: 'd' }), true)).toBe('pass');
    expect(decideTerminalKey(key({ key: 'r' }), false)).toBe('pass');
    expect(decideTerminalKey(key({ key: 'z' }), false)).toBe('pass');
  });

  it('does not fire without Ctrl, nor with Alt or Meta held', () => {
    // AltGr arrives as Ctrl+Alt on a Swiss French layout: pasting on AltGr+v would be a real hazard.
    expect(decideTerminalKey(key({ key: 'v', ctrlKey: false }), false)).toBe('pass');
    expect(decideTerminalKey(key({ key: 'v', altKey: true }), false)).toBe('pass');
    expect(decideTerminalKey(key({ key: 'c', metaKey: true }), true)).toBe('pass');
  });
});
