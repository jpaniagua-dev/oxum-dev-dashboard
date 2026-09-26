import { describe, expect, it } from 'vitest';
import { appShortcut } from '../src/renderer/ui/app-shortcuts.js';

interface TestKeyEvent {
  readonly altKey: boolean;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly shiftKey: boolean;
}

function key(
  code: string,
  modifiers: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    repeat: boolean;
    shiftKey: boolean;
  }> = {},
): TestKeyEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    code,
    ...modifiers,
  };
}

describe('appShortcut', () => {
  it('opens a default terminal with Ctrl+N', () => {
    expect(appShortcut(key('KeyN', { ctrlKey: true }))).toBe('new-terminal');
  });

  it('switches Cards and Tabs with Ctrl+G', () => {
    expect(appShortcut(key('KeyG', { ctrlKey: true }))).toBe('toggle-terminal-view');
  });

  it('opens the configured agent with Ctrl+Shift+N', () => {
    expect(appShortcut(key('KeyN', { ctrlKey: true, shiftKey: true }))).toBe('new-agent');
  });

  it('does not mask nearby terminal chords or repeat a held shortcut', () => {
    expect(appShortcut(key('KeyV', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(appShortcut(key('KeyG', { ctrlKey: true, repeat: true }))).toBeNull();
    expect(appShortcut(key('KeyN', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(appShortcut(key('KeyG', { ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});
