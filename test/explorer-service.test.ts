import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project } from '../src/shared/contracts.js';
import type { ExplorerTarget } from '../src/shared/explorer.js';
import type { EditorRequest } from '../src/main/editor/editor-process.js';
import { ExplorerService, resolveInside } from '../src/main/explorer/explorer-service.js';

/*
 * A real repository in a temporary folder, because what this service does is ask git and the disk:
 * which files are ignored, which ones are tracked, where a junction leads. A fake of either would test
 * the fake. Anonymised names throughout, the repository being public.
 */
let sandbox: string;
let repo: string;
let outside: string;
let exclusions: string[] = [];
let editor = 'editor';
const opened: EditorRequest[] = [];
const targets: ExplorerTarget[] = [];
const SIZE = { cols: 120, rows: 30 };

function git(...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
}

function service(): ExplorerService {
  const project = { id: 'web-app', label: 'web-app', path: repo } as Project;
  return new ExplorerService({
    projects: () => [project],
    exclusions: () => exclusions,
    editorCommand: () => editor,
    resolve: async (command) =>
      command === 'editor' ? { file: 'C:/tools/editor.exe', viaCmd: false } : command === 'shim' ? { file: 'C:/npm/shim.cmd', viaCmd: true } : null,
    openEditor: (request, target) => {
      opened.push(request);
      targets.push(target);
      return { ok: true, message: '' };
    },
  });
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'oxum-explorer-'));
  repo = join(sandbox, 'web-app');
  outside = join(sandbox, 'elsewhere');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'not yours');
  execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true, stdio: 'pipe' });
  mkdirSync(join(repo, 'src', 'app'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'lib'), { recursive: true });
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n.env\n');
  writeFileSync(join(repo, '.env'), 'TOKEN=x');
  writeFileSync(join(repo, 'README.md'), '# web-app\n');
  writeFileSync(join(repo, 'src', 'main.ts'), 'console.log(1);\n');
  writeFileSync(join(repo, 'src', 'app', 'app.ts'), 'export class App {}\n');
  writeFileSync(join(repo, 'src', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  writeFileSync(join(repo, 'docs', 'notes.log'), 'x');
  writeFileSync(join(repo, 'node_modules', 'lib', 'index.js'), '');
  // A junction out of the project: listed, never followed.
  symlinkSync(outside, join(repo, 'escape'), 'junction');
  git('add', '.gitignore', 'README.md', 'src/main.ts');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init');
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('ExplorerService.list', () => {
  it('lists a folder, folders first, without .git, greying what git ignores', async () => {
    exclusions = [];
    const listing = await service().list('web-app', '');
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    const names = listing.entries.map((entry) => entry.name);
    expect(names).not.toContain('.git');
    expect(names.slice(0, 4)).toEqual(['docs', 'escape', 'node_modules', 'src']);
    const dimmed = listing.entries.filter((entry) => entry.dimmed).map((entry) => entry.name);
    expect(dimmed.sort()).toEqual(['.env', 'node_modules']);
    expect(listing.entries.find((entry) => entry.name === 'escape')?.link).toBe(true);
    expect(listing.entries.find((entry) => entry.name === 'README.md')?.size).toBe(10);
  });

  it('greys what the exclusions match, on top of git', async () => {
    exclusions = ['*.md', 'docs'];
    const listing = await service().list('web-app', '');
    if (!listing.ok) throw new Error(listing.message);
    const dimmed = listing.entries.filter((entry) => entry.dimmed).map((entry) => entry.name);
    expect(dimmed.sort()).toEqual(['.env', 'README.md', 'docs', 'node_modules']);
  });

  it('refuses a junction that leads out of the project', async () => {
    const listing = await service().list('web-app', 'escape');
    expect(listing.ok).toBe(false);
    expect(await service().open('web-app', 'escape/secret.txt', 'panel', SIZE)).toMatchObject({ ok: false });
  });

  it('answers an unknown project or folder with a message, not an exception', async () => {
    expect((await service().list('nope', '')).ok).toBe(false);
    expect((await service().list('web-app', 'missing')).ok).toBe(false);
  });
});

describe('ExplorerService.projectFiles', () => {
  it('returns tracked and untracked files git does not ignore, minus the exclusions', async () => {
    exclusions = ['docs'];
    const files = await service().projectFiles('web-app');
    if (!files.ok) throw new Error(files.message);
    expect([...files.paths].sort()).toEqual(['.gitignore', 'README.md', 'src/app/app.ts', 'src/logo.png', 'src/main.ts']);
  });

  it('drops its cached list when the exclusions change', async () => {
    exclusions = [];
    const explorer = service();
    const before = await explorer.projectFiles('web-app');
    exclusions = ['src'];
    const after = await explorer.projectFiles('web-app');
    if (!before.ok || !after.ok) throw new Error('not a repository');
    expect(before.paths).toContain('src/main.ts');
    expect(after.paths).not.toContain('src/main.ts');
  });
});

describe('ExplorerService.open', () => {
  it('hands the editor a path relative to the project, keyed by file, to the target asked for', async () => {
    editor = 'editor';
    opened.length = 0;
    targets.length = 0;
    expect(await service().open('web-app', 'src/main.ts', 'panel', SIZE)).toEqual({ ok: true, message: '' });
    expect(opened[0]).toMatchObject({
      key: 'web-app\0src/main.ts',
      projectId: 'web-app',
      path: 'src/main.ts',
      title: 'src/main.ts - web-app',
      file: 'C:/tools/editor.exe',
      cwd: repo,
    });
    expect(opened[0]?.args).toEqual([join('src', 'main.ts')]);
    await service().open('web-app', 'src/main.ts', 'window', SIZE);
    expect(targets).toEqual(['panel', 'window']);
  });

  it('runs a batch shim through cmd.exe with a vetted line', async () => {
    editor = 'shim';
    opened.length = 0;
    await service().open('web-app', 'README.md', 'panel', SIZE);
    expect(opened[0]?.file).toBe('cmd.exe');
    expect(opened[0]?.args).toBe('/d /s /c "C:/npm/shim.cmd README.md"');
  });

  it('says so when the editor is not found, and opens nothing', async () => {
    editor = 'missing-editor';
    opened.length = 0;
    expect(await service().open('web-app', 'README.md', 'panel', SIZE)).toEqual({
      ok: false,
      message: 'missing-editor was not found. Set its path in Settings → General',
    });
    expect(opened).toHaveLength(0);
  });

  it('opens only files', async () => {
    editor = 'editor';
    expect((await service().open('web-app', 'src', 'panel', SIZE)).ok).toBe(false);
    expect((await service().open('web-app', 'escape/secret.txt', 'panel', SIZE)).ok).toBe(false);
  });
});

describe('resolveInside', () => {
  it('accepts the root itself and refuses a sibling sharing its prefix', async () => {
    expect(await resolveInside(repo, '')).not.toBeNull();
    mkdirSync(join(sandbox, 'web-app-old'), { recursive: true });
    // `web-app-old` starts with `web-app`: a check on the string prefix alone would let it in.
    symlinkSync(join(sandbox, 'web-app-old'), join(repo, 'old'), 'junction');
    expect(await resolveInside(repo, 'old')).toBeNull();
  });
});
