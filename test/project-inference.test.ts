import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expandScript,
  inferProject,
  interpretCommand,
  scriptNameOf,
  validateActions,
  validateProjectPath,
} from '../src/main/projects/project-inference.js';
import { defaultLabel, makeId } from '../src/main/projects/registry.js';

/**
 * Repositories root, built on a temporary directory.
 *
 * These tests used to point at the author's own repositories root and skip themselves when a folder
 * was missing, so on any other machine three of them asserted nothing at all while still counting as
 * passed. Writing the manifests here means the inference is exercised everywhere, and each fixture
 * states the shape it stands for.
 */
let ROOT = '';

/** Writes a folder with a `package.json` holding the given scripts. */
function fixture(folder: string, scripts: Record<string, string>): void {
  const path = join(ROOT, folder);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: folder, scripts }), 'utf8');
}

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'dashboard-projects-'));
  // A plain Angular server on the framework default port.
  fixture('web-app', { start: 'ng serve' });
  // Same, with the port written into the command rather than left implicit.
  fixture('admin-front', { start: 'ng serve --port 4201' });
  // A watch build: healthy, and opens no port at all. Its nature only shows one level down.
  fixture('design-system', {
    start: 'npm run lint && npm run build:lib -- --watch',
    lint: 'ng lint',
    'build:lib': 'ng build',
  });
  // A folder the dashboard can still watch, with no manifest to read.
  mkdirSync(join(ROOT, 'plain-folder'), { recursive: true });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('interpretCommand', () => {
  it('reads a bare ng serve as a server on Angular default port', () => {
    expect(interpretCommand('ng serve')).toEqual({ kind: 'server', port: 4200 });
  });

  it('reads an explicit port', () => {
    expect(interpretCommand('ng serve --port 4201')).toEqual({ kind: 'server', port: 4201 });
    expect(interpretCommand('ng serve --port=4300')).toEqual({ kind: 'server', port: 4300 });
  });

  it('reads a watch build as having no port at all', () => {
    // The distinction that matters: `ng build --watch` opens nothing, so claiming a port would
    // promise an observable that does not exist.
    expect(interpretCommand('ng build --watch')).toEqual({ kind: 'watch', port: null });
  });

  it('is not fooled by the word serve inside another token', () => {
    expect(interpretCommand('node scripts/observe.js').kind).toBe('watch');
  });
});

describe('expandScript', () => {
  it('follows one level of npm run so a delegating script is readable', () => {
    // Exactly the `design-system` shape: its nature only shows after following the reference.
    const scripts = {
      start: 'npm run lint && npm run build:lib -- --watch',
      lint: 'ng lint',
      'build:lib': 'ng build',
    };
    const expanded = expandScript(scripts, 'start');
    expect(expanded).toContain('ng build');
    expect(interpretCommand(expanded).kind).toBe('watch');
  });

  it('does not recurse into itself', () => {
    expect(expandScript({ start: 'npm run start' }, 'start')).toBe('npm run start');
  });

  it('returns empty for an unknown script', () => {
    expect(expandScript({ start: 'ng serve' }, 'dev')).toBe('');
  });
});

describe('inferProject on a repository on disk', () => {
  it('reads a bare ng serve as a server on 4200', () => {
    const inferred = inferProject(join(ROOT, 'web-app'));
    expect(inferred.kind).toBe('server');
    expect(inferred.port).toBe(4200);
    expect(inferred.scripts).toContain('start');
  });

  it('reads the explicit port written in the start script', () => {
    expect(inferProject(join(ROOT, 'admin-front'))).toMatchObject({ kind: 'server', port: 4201 });
  });

  it('reads a delegating watch build as having no port', () => {
    expect(inferProject(join(ROOT, 'design-system'))).toMatchObject({ kind: 'watch', port: null });
  });

  it('reports nothing for a folder without a manifest', () => {
    expect(inferProject(join(ROOT, 'plain-folder')).found).toBe(false);
  });
});

describe('validateProjectPath', () => {
  it('rejects an empty or missing path', () => {
    expect(validateProjectPath('')[0]?.level).toBe('error');
    expect(validateProjectPath('C:/definitely/not/here')[0]?.message).toMatch(/does not exist/);
  });

  it('treats a folder with no package.json as usable', () => {
    // The dashboard watches folders, not only npm projects: this used to be an error, which made the
    // whole settings form unsavable because of one such row.
    expect(validateProjectPath(ROOT).some((issue) => issue.level === 'error')).toBe(false);
  });

  it('accepts a valid repository', () => {
    const issues = validateProjectPath(join(ROOT, 'web-app'));
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
  });
});

describe('scriptNameOf', () => {
  it('reads the script an npm command runs', () => {
    expect(scriptNameOf('npm run start')).toBe('start');
    expect(scriptNameOf('  pnpm run build:lib ')).toBe('build:lib');
  });

  it('takes the script actually launched, not one mentioned later', () => {
    // Anchored at the start: the tail of a chained command is not what the action runs first.
    expect(scriptNameOf('npm run build && echo npm run deploy')).toBe('build');
  });

  it('returns null for a command that is not an npm script', () => {
    // A raw command is interpreted as written rather than looked up in the manifest.
    expect(scriptNameOf('ng serve --port 4300')).toBeNull();
    expect(scriptNameOf('commit')).toBeNull();
  });
});

describe('validateActions', () => {
  const task = { label: 'Commit', command: 'commit', role: 'task' };
  const server = { label: 'Run', command: 'npm run start', role: 'server' };

  it('refuses two server actions', () => {
    // A row holds one server state, so two server actions would both write it and the last one to
    // print would win. This is the only structural error in an action list.
    const issues = validateActions(ROOT, [server, { ...server, label: 'Run 2' }]);
    expect(issues.some((issue) => issue.level === 'error')).toBe(true);
  });

  it('warns on an empty list rather than accepting a row with no buttons', () => {
    expect(validateActions(ROOT, [])).toEqual([
      { level: 'warning', message: 'No action: the row will have no button' },
    ]);
  });

  it('flags a script that does not exist, as a warning naming the button', () => {
    const issues = validateActions(join(ROOT, 'web-app'), [
      { label: 'Nope', command: 'npm run nope', role: 'task' },
    ]);
    expect(issues[0]?.level).toBe('warning');
    expect(issues[0]?.message).toMatch(/Nope/);
    expect(issues[0]?.message).toMatch(/nope/);
  });

  it('says nothing about a command that is not an npm script', () => {
    // `commit` is a shell alias: it exists nowhere in package.json and that is perfectly normal.
    expect(validateActions(join(ROOT, 'web-app'), [server, task])).toEqual([]);
  });
});

describe('label and id derivation', () => {
  it('keeps the folder name as the default label', () => {
    // No shortening rule: guessing which part of someone else's folder name is noise removes the
    // word that told two projects apart. Renaming is a gesture, not an inference.
    expect(defaultLabel('web-app')).toBe('web-app');
    expect(defaultLabel('admin-front')).toBe('admin-front');
    expect(defaultLabel('design-system')).toBe('design-system');
  });

  it('builds a stable id from a folder name', () => {
    expect(makeId('web-app')).toBe('web-app');
    expect(makeId('My App 2')).toBe('my-app-2');
    expect(makeId('--weird--')).toBe('weird');
  });
});
