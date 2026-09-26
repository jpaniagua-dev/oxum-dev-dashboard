export type AppShortcut = 'new-terminal' | 'toggle-terminal-view' | 'new-agent';

type ShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'code' | 'ctrlKey' | 'metaKey' | 'repeat' | 'shiftKey'
>;

/**
 * Resolves the application-wide shortcuts before a focused xterm can consume them.
 *
 * The three chords intentionally form a compact Ctrl-based family: new terminal, new agent, and
 * Cards/Tabs toggle. Exact modifier checks keep nearby terminal shortcuts available.
 */
export function appShortcut(event: ShortcutEvent): AppShortcut | null {
  if (event.repeat || event.metaKey) {
    return null;
  }

  if (event.ctrlKey && !event.altKey && !event.shiftKey && event.code === 'KeyN') {
    return 'new-terminal';
  }

  if (event.ctrlKey && !event.altKey && event.shiftKey && event.code === 'KeyN') {
    return 'new-agent';
  }

  if (event.ctrlKey && !event.altKey && !event.shiftKey && event.code === 'KeyG') {
    return 'toggle-terminal-view';
  }

  return null;
}
