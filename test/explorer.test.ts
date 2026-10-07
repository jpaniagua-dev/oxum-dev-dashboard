import { describe, expect, it } from 'vitest';
import {
  breadcrumb,
  childPath,
  compileExclusions,
  editorModified,
  formatSize,
  isExcluded,
  matchFiles,
  moveSelection,
  parentPath,
  sanitizeExclusions,
  sanitizeExplorerPath,
  sortEntries,
  type ExplorerEntry,
} from '../src/shared/explorer.js';

describe('editorModified', () => {
  // The status lines micro 2.0.15 drew in a real pty, before and after one keystroke.
  const clean = 'probe.ts (1,1) | ft:typescript | unix | utf-8          Alt-g: bindings, Ctrl-g: help';
  const dirty = 'probe.ts + (1,2) | ft:typescript | unix | utf-8        Alt-g: bindings, Ctrl-g: help';

  it('reads the + micro puts after the file name', () => {
    expect(editorModified(['const a = 1;', '~', clean, ''])).toBe(false);
    expect(editorModified(['xconst a = 1;', '~', dirty, ''])).toBe(true);
  });

  it('counts any split that is modified, and the overwrite word between', () => {
    expect(editorModified([clean, dirty])).toBe(true);
    expect(editorModified(['src/app.ts + ovr (3,9) | ft:typescript'])).toBe(true);
  });

  it('does not take a + in the file itself, or a path with spaces, for the mark', () => {
    expect(editorModified(['a + (1,2)', 'my file.ts (4,2) | ft:typescript'])).toBe(false);
  });

  it('answers null when there is no status line it knows', () => {
    expect(editorModified(['some other editor', 'line 2'])).toBeNull();
  });
});

describe('sanitizeExplorerPath', () => {
  it('accepts the root and plain relative paths', () => {
    expect(sanitizeExplorerPath('')).toBe('');
    expect(sanitizeExplorerPath('src/app/app.ts')).toBe('src/app/app.ts');
    expect(sanitizeExplorerPath('.github/workflows')).toBe('.github/workflows');
  });

  it('refuses every shape that could point outside the project', () => {
    // Each of these could mean a second place once joined to the root, which is the whole point of
    // refusing rather than normalising.
    for (const path of ['..', 'src/../..', '/etc', 'C:/Windows', 'C:', 'src\\app', './src', 'src//app', 'src/']) {
      expect(sanitizeExplorerPath(path)).toBeNull();
    }
    expect(sanitizeExplorerPath(42)).toBeNull();
    expect(sanitizeExplorerPath('a\u0000b')).toBeNull();
  });

  it('keeps .git out at any depth', () => {
    expect(sanitizeExplorerPath('.git')).toBeNull();
    expect(sanitizeExplorerPath('.git/config')).toBeNull();
    expect(sanitizeExplorerPath('vendor/lib/.GIT/HEAD')).toBeNull();
  });
});

describe('paths', () => {
  it('walks up and down a relative path', () => {
    expect(childPath('', 'src')).toBe('src');
    expect(childPath('src', 'app')).toBe('src/app');
    expect(parentPath('src/app')).toBe('src');
    expect(parentPath('src')).toBe('');
    expect(parentPath('')).toBeNull();
    expect(breadcrumb('src/app')).toEqual([
      { name: 'src', path: 'src' },
      { name: 'app', path: 'src/app' },
    ]);
    expect(breadcrumb('')).toEqual([]);
  });
});

describe('sortEntries', () => {
  const entry = (name: string, kind: 'dir' | 'file'): ExplorerEntry => ({
    name,
    kind,
    size: kind === 'file' ? 1 : null,
    link: false,
    dimmed: false,
  });

  it('puts folders first, then sorts by name the way a person reads them', () => {
    const sorted = sortEntries([
      entry('b.ts', 'file'),
      entry('src', 'dir'),
      entry('A.md', 'file'),
      entry('file10.ts', 'file'),
      entry('file2.ts', 'file'),
      entry('assets', 'dir'),
    ]);
    expect(sorted.map((row) => row.name)).toEqual(['assets', 'src', 'A.md', 'b.ts', 'file2.ts', 'file10.ts']);
  });
});

describe('matchFiles', () => {
  const paths = [
    'src/app/app.component.ts',
    'src/main.ts',
    'src/app/shared/app-header.ts',
    'docs/apps.md',
    'README.md',
  ];

  it('ranks a name that starts with the query above one that contains it, then a folder match', () => {
    expect(matchFiles(paths, 'app', 10)).toEqual([
      'docs/apps.md',
      'src/app/app.component.ts',
      'src/app/shared/app-header.ts',
    ]);
    expect(matchFiles(paths, 'shared', 10)).toEqual(['src/app/shared/app-header.ts']);
  });

  it('ignores case, returns nothing for an empty query, and stops at the limit', () => {
    expect(matchFiles(paths, 'README', 10)).toEqual(['README.md']);
    expect(matchFiles(paths, 'readme', 10)).toEqual(['README.md']);
    expect(matchFiles(paths, '  ', 10)).toEqual([]);
    expect(matchFiles(paths, 'ts', 2)).toHaveLength(2);
  });
});

describe('moveSelection', () => {
  it('enters the list from either end and stays inside it', () => {
    expect(moveSelection(-1, 1, 3)).toBe(0);
    expect(moveSelection(-1, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(2);
    expect(moveSelection(0, -1, 3)).toBe(0);
    expect(moveSelection(1, 1, 3)).toBe(2);
    expect(moveSelection(0, 1, 0)).toBe(-1);
  });
});

describe('formatSize', () => {
  it('reads like a file list', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(20 * 1024)).toBe('20 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('exclusions', () => {
  it('cleans the setting', () => {
    expect(sanitizeExclusions(['  dist ', '', '#x', 'dist', 3])).toEqual(['dist']);
    expect(sanitizeExclusions(null)).toEqual([]);
  });

  it('matches a bare name at any depth, and everything inside a matched folder', () => {
    const rules = compileExclusions(['node_modules', '*.lock']);
    expect(isExcluded('node_modules', rules)).toBe(true);
    expect(isExcluded('packages/web/node_modules/react/index.js', rules)).toBe(true);
    expect(isExcluded('package-lock.json', rules)).toBe(false);
    expect(isExcluded('yarn.lock', rules)).toBe(true);
    expect(isExcluded('src/app.ts', rules)).toBe(false);
  });

  it('anchors a pattern holding a slash at the project root', () => {
    const rules = compileExclusions(['docs/generated', '/build/']);
    expect(isExcluded('docs/generated/api.md', rules)).toBe(true);
    expect(isExcluded('packages/docs/generated/api.md', rules)).toBe(false);
    expect(isExcluded('build/out.js', rules)).toBe(true);
    expect(isExcluded('src/build/out.js', rules)).toBe(false);
  });

  it('lets ** cross folders, including none at all', () => {
    const rules = compileExclusions(['src/**/*.spec.ts']);
    expect(isExcluded('src/app/a.spec.ts', rules)).toBe(true);
    expect(isExcluded('src/a.spec.ts', rules)).toBe(true);
    expect(isExcluded('test/a.spec.ts', rules)).toBe(false);
  });

  it('ignores case and treats regex characters literally', () => {
    const rules = compileExclusions(['DIST', 'a+b.(x)']);
    expect(isExcluded('dist/main.js', rules)).toBe(true);
    expect(isExcluded('a+b.(x)', rules)).toBe(true);
    expect(isExcluded('aab.x', rules)).toBe(false);
  });

  it('excludes nothing without rules', () => {
    expect(isExcluded('anything', compileExclusions([]))).toBe(false);
  });
});
