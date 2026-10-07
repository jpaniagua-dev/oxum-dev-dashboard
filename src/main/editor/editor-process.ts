import * as pty from '@lydell/node-pty';
import type { IPty } from '@lydell/node-pty';
import type { TerminalSize } from '@shared/contracts.js';

/** One editor to start, already resolved down to a program and its arguments. */
export interface EditorRequest {
  /** Identifies the file, so a second open finds the editor already showing it. */
  readonly key: string;
  readonly projectId: string;
  /** The file, relative to the project. */
  readonly path: string;
  readonly title: string;
  readonly file: string;
  /** An array for a real executable; a raw command line for a batch shim behind `cmd.exe`. */
  readonly args: readonly string[] | string;
  readonly cwd: string;
}

/**
 * The key that asks the editor to quit: `Ctrl+Q`, micro's.
 *
 * Sent instead of killing the process whenever another file is to take its place, and that choice is
 * the point: the app cannot see whether a buffer holds unsaved changes, and the editor can. A clean
 * buffer quits at once; a modified one makes the editor ask "Save changes?" itself, and nothing is
 * lost on a click.
 */
export const EDITOR_QUIT_KEY = '\u0011';

/** Starts the editor in a pty of its own. Throws when the program cannot be launched. */
export function spawnEditor(
  request: EditorRequest,
  size: TerminalSize,
  env: NodeJS.ProcessEnv,
): IPty {
  return pty.spawn(request.file, typeof request.args === 'string' ? request.args : [...request.args], {
    cwd: request.cwd,
    cols: size.cols,
    rows: size.rows,
    env,
  });
}
