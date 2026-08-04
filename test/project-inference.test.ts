import { join } from 'node:path';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  expandScript,
  inferProject,
  interpretCommand,
  scriptNameOf,
  validateActions,
  validateProjectPath,
} from '../src/main/projects/project-inference.js';
import { makeId, shortLabel } from '../src/main/projects/registry.js';

const ROOT = join(homedir(), 'oxum', 'projects');

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

describe('inferProject on the real repositories', () => {
  it('reads web-app as a server on 4200', () => {
    const inferred = inferProject(join(ROOT, 'web-app'));
    if (!inferred.found) {
      return; // Repository absent on this machine; nothing to assert.
    }
    expect(inferred.kind).toBe('server');
    expect(inferred.port).toBe(4200);
    expect(inferred.scripts).toContain('start');
  });

  it('reads the explicit port of admin-front', () => {
    const inferred = inferProject(join(ROOT, 'admin-front'));
    if (!inferred.found) {
      return;
    }
    expect(inferred).toMatchObject({ kind: 'server', port: 4201 });
  });

  it('reads design-system as a watch build with no port', () => {
    const inferred = inferProject(join(ROOT, 'design-system'));
    if (!inferred.found) {
      return;
    }
    expect(inferred).toMatchObject({ kind: 'watch', port: null });
  });

  it('reports nothing for a folder without a manifest', () => {
    expect(inferProject(join(ROOT, 'documentation')).found).toBe(false);
  });
});

describe('validateProjectPath', () => {
  it('rejects an empty or missing path', () => {
    expect(validateProjectPath('')[0]?.level).toBe('error');
    expect(validateProjectPath('C:/definitely/not/here')[0]?.message).toMatch(/n’existe pas/);
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
      { level: 'warning', message: 'Aucune action : la ligne n’aura pas de bouton' },
    ]);
  });

  it('flags a script that does not exist, as a warning naming the button', () => {
    const issues = validateActions(join(ROOT, 'web-app'), [
      { label: 'Nope', command: 'npm run nope', role: 'task' },
    ]);
    if (issues.length === 0) {
      return; // Repository absent on this machine.
    }
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
  it('drops the shared prefix but keeps the rest readable', () => {
    // Stripping `-front` too would leave a bare `shared`, which says less than the folder did.
    expect(shortLabel('web-app')).toBe('shared-front');
    expect(shortLabel('admin-front')).toBe('rating-acquisition-front');
    expect(shortLabel('design-system')).toBe('design-system');
  });

  it('builds a stable id from a folder name', () => {
    expect(makeId('web-app')).toBe('web-app');
    expect(makeId('My App 2')).toBe('my-app-2');
    expect(makeId('--weird--')).toBe('weird');
  });
});
