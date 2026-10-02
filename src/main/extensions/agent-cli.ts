import { spawnOffThread, SpawnError } from '../spawn/spawn-pool.js';
import { cmdLine, resolveCommand } from '../spawn/command-resolve.js';

export {
  cmdLine,
  pickWhereResult,
  quoteArgument,
  resolveCommand,
  type ResolvedCommand,
} from '../spawn/command-resolve.js';

/**
 * Running `claude` and `codex` for the Extensions tab.
 *
 * Both CLIs are reached the same way, and the one difference that matters is on Windows: Claude Code
 * installs a real `claude.exe`, while Codex is an npm package whose entry point is a `codex.cmd`
 * shim. `execFile` runs the first and refuses the second (a batch file needs a shell since the
 * fix for CVE-2024-27980), so a `.cmd` goes through `cmd.exe` with a line this module quotes itself.
 * Nothing here takes a shell option: every argument is vetted, which is the safer half of the trade.
 */

const versions = new Map<string, string | null>();

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
