import { execFile } from 'node:child_process';
import * as pty from '@lydell/node-pty';
import type { IPty } from '@lydell/node-pty';
import type { Project, ProjectId, PtyCommand, TerminalSize } from '@shared/contracts.js';
import { parseOutputChunk, type ParsedOutput } from './output-parser.js';

/**
 * Output retained per project so the terminal pane can be reopened without losing history.
 *
 * Bounded on purpose: a dev server left running for hours would otherwise grow this without limit.
 */
const BUFFER_LIMIT = 200_000;

export interface RunningProcess {
  readonly pty: IPty;
  readonly command: PtyCommand;
  buffer: string;
}

export interface PtyRunnerHooks {
  /** Raw output, forwarded to the renderer's terminal. */
  onOutput: (projectId: ProjectId, data: string) => void;
  /** A phase or error change derived from the output. */
  onParsed: (projectId: ProjectId, parsed: ParsedOutput) => void;
  /** The process ended, on its own or because it was stopped. */
  onExit: (projectId: ProjectId, exitCode: number, stopped: boolean) => void;
}

/**
 * Owns one pseudo-terminal per project.
 *
 * A pty rather than a plain `spawn` for two reasons: the toolchain prints progress with cursor
 * control that only makes sense on a terminal, and `commit` is a full-screen prompt_toolkit TUI
 * that refuses to run without a TTY. Owning the process is also the only way to see errors from
 * `design-system`, which serves nothing and so cannot be observed from the outside.
 */
export class PtyRunner {
  private readonly running = new Map<ProjectId, RunningProcess>();
  /** Projects stopped on purpose, so a normal exit is not reported as a crash. */
  private readonly stopping = new Set<ProjectId>();

  constructor(private readonly hooks: PtyRunnerHooks) {}

  isRunning(projectId: ProjectId): boolean {
    return this.running.has(projectId);
  }

  /** Ids of every project the dashboard currently owns a process for. */
  runningIds(): ProjectId[] {
    return [...this.running.keys()];
  }

  buffer(projectId: ProjectId): string {
    return this.running.get(projectId)?.buffer ?? '';
  }

  /**
   * Starts a command in the project's pty.
   *
   * Refuses if something is already running for that project: two `ng serve` on one port would
   * leave the user with a confusing half-failure.
   */
  run(project: Project, command: PtyCommand, size: TerminalSize): void {
    if (this.running.has(project.id)) {
      return;
    }

    const { file, args } = resolveCommand(command, project);
    const child = pty.spawn(file, args, {
      cwd: project.path,
      cols: size.cols,
      rows: size.rows,
      // Colour is kept: the terminal pane renders it, and the parser strips it before matching.
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    const entry: RunningProcess = { pty: child, command, buffer: '' };
    this.running.set(project.id, entry);

    child.onData((data) => {
      entry.buffer = `${entry.buffer}${data}`.slice(-BUFFER_LIMIT);
      this.hooks.onOutput(project.id, data);
      this.hooks.onParsed(project.id, parseOutputChunk(data, project.kind));
    });

    child.onExit(({ exitCode }) => {
      const stopped = this.stopping.delete(project.id);
      this.running.delete(project.id);
      this.hooks.onExit(project.id, exitCode, stopped);
    });
  }

  /** Sends keystrokes from the terminal pane to the process. */
  write(projectId: ProjectId, data: string): void {
    this.running.get(projectId)?.pty.write(data);
  }

  resize(projectId: ProjectId, size: TerminalSize): void {
    const entry = this.running.get(projectId);
    if (entry === undefined) {
      return;
    }
    try {
      entry.pty.resize(Math.max(2, size.cols), Math.max(2, size.rows));
    } catch {
      // The process can exit between the resize event and this call; harmless.
    }
  }

  /** Stops a project's process and everything it spawned. */
  stop(projectId: ProjectId): void {
    const entry = this.running.get(projectId);
    if (entry === undefined) {
      return;
    }
    this.stopping.add(projectId);
    killTree(entry.pty);
  }

  /** Stops everything, for application shutdown. */
  stopAll(): void {
    for (const projectId of [...this.running.keys()]) {
      this.stop(projectId);
    }
  }
}

/**
 * Maps a logical command to an executable.
 *
 * `npm.cmd` and `cmd.exe` rather than bare names: a pty does not resolve `.cmd` shims the way a
 * shell does. `commit` is a git-bash alias, not an executable, so it is invoked through the same
 * bash that defines it, with `-lc` so the profile holding the alias is actually loaded.
 */
export function resolveCommand(
  command: PtyCommand,
  project: Project,
): { file: string; args: string[] } {
  if (command === 'commit') {
    return { file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-lc', 'commit'] };
  }
  return { file: 'cmd.exe', args: ['/c', 'npm', 'run', project.startScript] };
}

/**
 * Kills a pty's process and its descendants.
 *
 * `pty.kill()` signals only the process at the head of the pty, which for `npm run start` is a
 * `cmd.exe` wrapper; the `ng serve` underneath would survive and keep holding the port. `taskkill
 * /T` walks the tree.
 */
function killTree(child: IPty): void {
  const pid = child.pid;
  if (typeof pid !== 'number') {
    return;
  }
  if (process.platform !== 'win32') {
    child.kill();
    return;
  }
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {
    // A non-zero exit just means the process was already gone.
  });
}
