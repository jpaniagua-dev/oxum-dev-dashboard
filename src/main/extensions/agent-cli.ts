import { extname } from 'node:path';
import { spawnOffThread, SpawnError } from '../spawn/spawn-pool.js';

/**
 * Running `claude` and `codex` for the Extensions tab.
 *
 * Both CLIs are reached the same way, and the one difference that matters is on Windows: Claude Code
 * installs a real `claude.exe`, while Codex is an npm package whose entry point is a `codex.cmd`
 * shim. `execFile` runs the first and refuses the second (a batch file needs a shell since the
 * fix for CVE-2024-27980), so a `.cmd` goes through `cmd.exe` with a line this module quotes itself.
 * Nothing here takes a shell option: every argument is vetted, which is the safer half of the trade.
 */

export interface ResolvedCommand {
  readonly file: string;
  /** True when `file` is a batch shim that has to run through `cmd.exe`. */
  readonly viaCmd: boolean;
}

/**
 * Characters that do not survive the trip through cmd.exe and an npm shim. Refused, never escaped.
 *
 * `"` is on the list from a measurement rather than a theory: `"a \"b\""` reached Codex as `a `.
 * Spaces do survive, quoted.
 */
const CMD_UNSAFE = /[%^&|<>!"\r\n]/;

/** Quotes one argument the way the C runtime's `argv` parser reads it back. */
export function quoteArgument(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) {
    return arg;
  }
  let out = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(backslashes) + char;
    }
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

/**
 * The `/c` argument that runs a batch file with these arguments, or null when one cannot be built.
 *
 * `/s` makes cmd strip exactly the outer pair of quotes, so the line inside keeps its own. An
 * argument holding a character cmd expands (`%`, `!`) or treats as an operator (`&`, `|`, `<`,
 * `>`, `^`) answers null: quoting does not protect `%` at all, and guessing is how a value
 * becomes a command.
 */
export function cmdLine(file: string, args: readonly string[]): string | null {
  if ([file, ...args].some((part) => CMD_UNSAFE.test(part))) {
    return null;
  }
  return `"${[quoteArgument(file), ...args.map(quoteArgument)].join(' ')}"`;
}

/** What `where.exe` printed, as the one candidate this module can run. */
export function pickWhereResult(output: string): ResolvedCommand | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const exe = lines.find((line) => /\.(exe|com)$/i.test(line));
  if (exe !== undefined) {
    return { file: exe, viaCmd: false };
  }
  const batch = lines.find((line) => /\.(cmd|bat)$/i.test(line));
  return batch === undefined ? null : { file: batch, viaCmd: true };
}

const resolved = new Map<string, ResolvedCommand | null>();
const versions = new Map<string, string | null>();

/**
 * Finds the executable a configured command names.
 *
 * Remembered for the life of the process, per command string: changing the setting changes the key,
 * and a CLI installed while the app runs is found by editing the setting or restarting. One
 * `where.exe` per command per session is the whole cost.
 */
export async function resolveCommand(command: string): Promise<ResolvedCommand | null> {
  const key = command.trim();
  if (key.length === 0) {
    return null;
  }
  if (resolved.has(key)) {
    return resolved.get(key) ?? null;
  }
  let answer: ResolvedCommand | null;
  if (process.platform !== 'win32') {
    answer = { file: key, viaCmd: false };
  } else if (/[\\/]/.test(key)) {
    const ext = extname(key).toLowerCase();
    answer = { file: key, viaCmd: ext === '.cmd' || ext === '.bat' };
  } else {
    try {
      const { stdout } = await spawnOffThread({
        file: 'where.exe',
        args: [key],
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      answer = pickWhereResult(stdout);
    } catch {
      answer = null;
    }
  }
  resolved.set(key, answer);
  return answer;
}

export interface CliResult {
  readonly ok: boolean;
  readonly stdout: string;
  /** The first meaningful line of what went wrong, naming the command that was launched. */
  readonly message: string;
}

/** Runs the CLI once and reports, never throws. */
export async function runCli(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<CliResult> {
  const label = `${command} ${args.slice(0, 3).join(' ')}`.trim();
  const target = await resolveCommand(command);
  if (target === null) {
    return { ok: false, stdout: '', message: `${command} was not found. Set its path in Settings` };
  }
  const timeout = options.timeout ?? 60_000;
  let request: Parameters<typeof spawnOffThread>[0];
  if (target.viaCmd) {
    const line = cmdLine(target.file, args);
    if (line === null) {
      return {
        ok: false,
        stdout: '',
        message: `${label}: a value contains a quote or one of % ^ & | < > !, which cannot pass through cmd.exe safely`,
      };
    }
    request = {
      file: process.env['ComSpec'] ?? 'cmd.exe',
      args: ['/d', '/s', '/c', line],
      verbatim: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    };
  } else {
    request = {
      file: target.file,
      args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    };
  }
  try {
    const { stdout } = await spawnOffThread(request);
    return { ok: true, stdout, message: '' };
  } catch (error) {
    if (error instanceof SpawnError) {
      const detail =
        [error.stderr, error.stdout, error.message]
          .flatMap((text) => text.split(/\r?\n/))
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? 'failed';
      return {
        ok: false,
        stdout: error.stdout,
        message: error.killed ? `${label} timed out` : `${label}: ${detail}`,
      };
    }
    return { ok: false, stdout: '', message: `${label}: ${String(error)}` };
  }
}

/** `<cli> --version`, once per command per session. */
export async function versionOf(command: string): Promise<string | null> {
  const key = command.trim();
  if (versions.has(key)) {
    return versions.get(key) ?? null;
  }
  const result = await runCli(key, ['--version'], { timeout: 20_000 });
  const version = result.ok
    ? (/\d+\.\d+\.\d+[\w.-]*/.exec(result.stdout)?.[0] ?? (result.stdout.trim() || null))
    : null;
  versions.set(key, version);
  return version;
}
