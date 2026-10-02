import { extname } from 'node:path';
import { spawnOffThread } from './spawn-pool.js';

/**
 * Which file a configured command runs, and whether it needs `cmd.exe` to run it.
 *
 * On Windows, Claude Code installs a real `claude.exe` while npm installs CLIs as `.cmd` shims,
 * and `execFile` / `spawn` refuse a batch file without a shell since the fix for CVE-2024-27980.
 * A shim therefore goes through `cmd.exe` with a line quoted here, never through a shell option:
 * every argument is vetted, which is the safer half of the trade. Shared by the headless agent
 * runs and the Extensions tab, so both resolve a command the same way.
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
