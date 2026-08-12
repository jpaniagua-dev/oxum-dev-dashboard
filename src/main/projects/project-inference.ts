import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectKind } from '@shared/contracts.js';

/**
 * Derives a project's shape from its own `package.json`.
 *
 * Adding a project should mean picking a folder, not filling a form. The two facts the dashboard
 * needs, whether it serves and on which port, are already written in the start script, so asking the
 * user to restate them would just create a second place to be wrong. Every derived value stays
 * overridable, because inference cannot cover an unusual setup.
 */

export interface InferredProject {
  /** True when a `package.json` was found and read. */
  readonly found: boolean;
  /** Scripts declared by the project, used to validate a chosen start script. */
  readonly scripts: readonly string[];
  readonly kind: ProjectKind;
  readonly port: number | null;
  /** The start script's command line, expanded one level, for display. */
  readonly startCommand: string;
}

const UNKNOWN: InferredProject = {
  found: false,
  scripts: [],
  kind: 'server',
  port: null,
  startCommand: '',
};

/**
 * Reads and interprets a repository's `package.json`.
 *
 * The starting point is the server action's command line rather than a script name, because that is
 * now the only place the start command is written. A command shaped like `npm run <name>` is followed
 * into the manifest, since that is where `ng serve` and its port actually appear; anything else is
 * interpreted as given, so a project whose action is a bare `ng serve --port 4300` is understood too.
 */
export function inferProject(repoPath: string, serverCommand = 'npm run start'): InferredProject {
  const manifest = readManifest(repoPath);
  if (manifest === null) {
    return UNKNOWN;
  }

  const script = scriptNameOf(serverCommand);
  const command = script === null ? serverCommand : expandScript(manifest, script);
  return {
    found: true,
    scripts: Object.keys(manifest),
    ...interpretCommand(command),
    startCommand: script === null ? serverCommand : (manifest[script] ?? ''),
  };
}

/**
 * The npm script a command line runs, or null when it is not an `npm run` at all.
 *
 * Exported for testing. Anchored on the start of the command so `npm run build && echo npm run x`
 * resolves to `build`, the script actually launched.
 */
export function scriptNameOf(command: string): string | null {
  const match = /^\s*(?:npm|pnpm|yarn)\s+run\s+([\w:.-]+)/.exec(command);
  return match?.[1] ?? null;
}

/**
 * Interprets an expanded command line.
 *
 * Exported for testing: this is the whole inference, and the `watch` case matters most. A project
 * running `ng build --watch` opens no port, so calling it a server would promise an observable that
 * does not exist.
 */
export function interpretCommand(command: string): { kind: ProjectKind; port: number | null } {
  const kind: ProjectKind = /\bng serve\b/.test(command) ? 'server' : 'watch';
  if (kind === 'watch') {
    return { kind, port: null };
  }
  const explicit = /--port[\s=]+(\d{2,5})/.exec(command);
  if (explicit !== null) {
    const port = Number.parseInt(explicit[1] ?? '', 10);
    if (Number.isFinite(port)) {
      return { kind, port };
    }
  }
  // Angular's default when `ng serve` is given no port.
  return { kind, port: 4200 };
}

/**
 * Expands `npm run <name>` references one level deep.
 *
 * One level is enough and deliberate: `design-system` starts with `npm run lint && npm run build:lib
 * -- --watch`, so the `ng build` that reveals its nature only appears after following the reference.
 * Recursing further would risk a cycle for no practical gain.
 */
export function expandScript(scripts: Record<string, string>, name: string): string {
  const root = scripts[name];
  if (root === undefined) {
    return '';
  }
  let expanded = root;
  for (const referenced of root.matchAll(/npm run ([\w:-]+)/g)) {
    const key = referenced[1];
    if (key !== undefined && key !== name) {
      expanded += ` ${scripts[key] ?? ''}`;
    }
  }
  return expanded;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

export interface PathIssue {
  readonly level: 'error' | 'warning';
  readonly message: string;
}

/**
 * Checks a candidate project path.
 *
 * Only a path that points nowhere is an error. Everything else is a warning, because a project is a
 * folder: git status, a terminal in the right directory and a commit action all work without a
 * `package.json`. Treating a missing manifest as an error blocked saving the whole configuration over
 * a row that was perfectly usable.
 */
export function validateProjectPath(repoPath: string): PathIssue[] {
  const issues: PathIssue[] = [];

  if (repoPath.trim().length === 0) {
    return [{ level: 'error', message: 'Chemin vide' }];
  }
  if (!existsSync(repoPath)) {
    return [{ level: 'error', message: 'This folder does not exist' }];
  }
  if (!existsSync(join(repoPath, '.git'))) {
    issues.push({ level: 'warning', message: 'Not a git repository: the git column stays empty' });
  }

  return issues;
}

/**
 * Checks a project's actions against the repository.
 *
 * Warnings, never errors: an action pointing at a script that does not exist yet is a mistake worth
 * showing, but it breaks one button rather than the row, and blocking the save would be out of
 * proportion. Only a structurally impossible list is an error, and there is exactly one such case:
 * two server actions, which would have two processes writing the same server state.
 */
export function validateActions(
  repoPath: string,
  actions: readonly { label: string; command: string; role: string }[],
): PathIssue[] {
  const issues: PathIssue[] = [];

  if (actions.length === 0) {
    issues.push({ level: 'warning', message: 'No action: the row will have no button' });
    return issues;
  }
  if (actions.filter((action) => action.role === 'server').length > 1) {
    issues.push({
      level: 'error',
      message: 'Two "server" actions: only one can drive the server state',
    });
  }

  const manifest = repoPath.trim().length > 0 && existsSync(repoPath) ? readManifest(repoPath) : null;
  if (manifest === null) {
    return issues;
  }
  for (const action of actions) {
    const script = scriptNameOf(action.command);
    if (script !== null && manifest[script] === undefined) {
      issues.push({
        level: 'warning',
        message: `"${action.label}": the "${script}" script does not exist in package.json`,
      });
    }
  }

  return issues;
}

/** Reads a repository's scripts, or null when there is no readable manifest. */
function readManifest(repoPath: string): Record<string, string> | null {
  const manifestPath = join(repoPath, 'package.json');
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== 'object' || scripts === null) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(scripts)) {
      if (typeof value === 'string') {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return null;
  }
}
