import { describe, expect, it } from 'vitest';
import { IDLE_PANEL_EDITOR, type ExplorerEntry, type ExplorerListing } from '../src/shared/explorer.js';
import { editorName, editorStatus, explorerRows } from '../src/renderer/ui/explorer-panel.js';

const entry = (name: string, kind: 'dir' | 'file'): ExplorerEntry => ({
  name,
  kind,
  size: kind === 'file' ? 10 : null,
  link: false,
  dimmed: false,
});

const listing: ExplorerListing = {
  ok: true,
  path: 'src',
  entries: [entry('app', 'dir'), entry('main.ts', 'file'), entry('styles.css', 'file')],
  truncated: false,
};

describe('explorerRows', () => {
  it('lists the folder under its parent link when nothing is typed', () => {
    expect(explorerRows(listing, null, '').map((row) => `${row.type}:${row.path}`)).toEqual([
      'up:',
      'entry:src/app',
      'entry:src/main.ts',
      'entry:src/styles.css',
    ]);
  });

  it('shows the folder matches, then the project matches not already shown', () => {
    const files = { ok: true as const, paths: ['src/main.ts', 'server/main.go', 'docs/readme.md'] };
    expect(explorerRows(listing, files, 'main').map((row) => `${row.type}:${row.path}`)).toEqual([
      'entry:src/main.ts',
      'match:server/main.go',
    ]);
  });

  it('still filters the folder when the project cannot be searched', () => {
    const files = { ok: false as const, message: 'not a repository' };
    expect(explorerRows(listing, files, 'css').map((row) => row.path)).toEqual(['src/styles.css']);
  });
});

describe('editorStatus', () => {
  const running = { ...IDLE_PANEL_EDITOR, session: 1, path: 'a.ts', title: 'a.ts - web-app', running: true };

  it('says nothing while the editor simply runs', () => {
    expect(editorStatus(running, 'micro')).toBe('');
    expect(editorStatus(IDLE_PANEL_EDITOR, 'micro')).toBe('');
  });

  it('names the file waiting for the editor to let go, and where the question is', () => {
    expect(editorStatus({ ...running, pending: 'b.ts - web-app' }, 'micro')).toBe(
      'Opening b.ts - web-app once micro has closed this file. If it asks about unsaved changes, answer below.',
    );
  });

  it('reports a failure to start, then a bad exit', () => {
    expect(editorStatus({ ...running, running: false, message: 'Could not launch micro' }, 'micro')).toBe(
      'Could not launch micro',
    );
    expect(editorStatus({ ...running, running: false, exitCode: 2 }, 'micro')).toBe('micro ended with exit code 2.');
  });
});

describe('editorName', () => {
  it('names the program, whatever form the setting takes', () => {
    expect(editorName('micro')).toBe('micro');
    expect(editorName('C:\\tools\\micro.exe')).toBe('micro');
    expect(editorName('C:/npm/hx.cmd')).toBe('hx');
    expect(editorName('  ')).toBe('the editor');
  });
});
