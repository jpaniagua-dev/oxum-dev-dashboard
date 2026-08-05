import { describe, expect, it } from 'vitest';
import { insertPane, removePane, replacePane } from '../src/renderer/ui/terminal-pane.js';

const PANES = ['a', 'b', 'c'];

describe('insertPane', () => {
  it('puts the new pane right after the one being split', () => {
    expect(insertPane(PANES, 'd', 'a')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('appends when the reference pane is not on screen', () => {
    expect(insertPane(PANES, 'd', 'zzz')).toEqual(['a', 'b', 'c', 'd']);
    expect(insertPane(PANES, 'd', null)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never shows the same session twice', () => {
    // One session cannot occupy two panes: it has a single xterm element.
    expect(insertPane(PANES, 'b', 'a')).toEqual(PANES);
  });

  it('starts a layout from nothing', () => {
    expect(insertPane([], 'a', null)).toEqual(['a']);
  });
});

describe('removePane', () => {
  it('takes a pane off the surface', () => {
    expect(removePane(PANES, 'b')).toEqual(['a', 'c']);
  });

  it('refuses to empty the layout', () => {
    // An empty layout is a blank surface with no gesture left to fix it.
    expect(removePane(['a'], 'a')).toEqual(['a']);
  });

  it('ignores a pane that is not there', () => {
    expect(removePane(PANES, 'zzz')).toEqual(PANES);
  });
});

describe('replacePane', () => {
  it('shows the session in place of the focused pane', () => {
    // What clicking a tab does: the split survives, only one slot changes.
    expect(replacePane(PANES, 'b', 'd')).toEqual(['a', 'd', 'c']);
  });

  it('does nothing when the session is already on screen', () => {
    expect(replacePane(PANES, 'a', 'c')).toEqual(PANES);
  });

  it('falls back to the last pane when nothing is focused', () => {
    expect(replacePane(PANES, null, 'd')).toEqual(['a', 'b', 'd']);
  });

  it('starts a layout from nothing', () => {
    expect(replacePane([], null, 'a')).toEqual(['a']);
  });

  it('keeps the pane count', () => {
    for (const focused of [...PANES, null]) {
      expect(replacePane(PANES, focused, 'new')).toHaveLength(PANES.length);
    }
  });
});
