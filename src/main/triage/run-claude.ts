import { spawn } from 'node:child_process';
import { splitLines } from './triage-progress.js';

/**
 * A headless Claude Code run, used by the Triage tab and nothing else.
 *
 * Not a terminal tab, and that is a deliberate departure from "every row action ends in a tab": a
 * tab is the right home for a command whose **output** is the point (a dev server, a commit and its
 * hooks). Here the output is a payload the tab has to parse and group, so it belongs with the
 * services that call `gh` and Jira from the main process. What the rule really protects, that no
 * work happens in a window the app cannot show or stop, still holds: the run is visible as a state
 * on the sprint row and the process is killed on timeout.
 */

/**
 * Budget for one analysis.
 *
 * Generous on purpose: the run reads a codebase before answering, on twenty tickets, and a run cut
 * off at ninety seconds would report a failure that says more about the timeout than about the
 * sprint. A ceiling still has to exist, or a stuck process holds the button for the session.
 */
export const CLAUDE_TIMEOUT_MS = 15 * 60_000;

/** Answers can be long; the default 1 MB pipe buffer is not a limit worth discovering in use. */
const MAX_OUTPUT = 8 * 1024 * 1024;

export interface ClaudeRunResult {
  readonly ok: boolean;
  /** The model's answer, empty when the run failed. */
  readonly answer: string;
  readonly error: string | null;
}

export interface ClaudeRunOptions {
  /** Where the run happens, so the model can read the code it is being asked about. */
  readonly cwd: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  /**
   * Called for every event as it arrives, which is what makes the wait watchable.
   *
   * The caller decides what to show; this module only guarantees the events are whole objects and
   * arrive in order.
   */
  readonly onEvent?: (event: unknown) => void;
}

/**
 * Runs `claude -p` and returns its answer.
 *
 * Three choices worth keeping:
 *
 * - **The prompt goes in on stdin**, never as an argument. A sprint of twenty tickets with their
 *   descriptions is tens of kilobytes, well past what a Windows command line accepts, and the
 *   failure would be a truncated prompt rather than an error.
 * - **`stream-json`, not `json`.** The plain envelope arrives once, at the end, so a run of several
 *   minutes would have nothing at all to show while it worked. The streamed form emits every tool
 *   call as it happens, which is what turns the wait into something the user can read. It requires
 *   `--verbose` in print mode, and it is line-delimited JSON: one object per line, so the output has
 *   to be split on newlines rather than parsed whole.
 * - **Tools are limited to reading.** The run is allowed to open the codebase to check whether a
 *   field exists, which is the difference between a verdict and a guess, but it can neither write
 *   nor run anything. An analysis is not a change.
 * - **No `--bare`.** That mode requires `ANTHROPIC_API_KEY`; a normal install is signed in through
 *   OAuth, and the run would fail with an authentication error that has nothing to do with the tab.
 */
export async function runClaude(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      [
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--allowedTools',
        'Read',
        'Grep',
        'Glob',
        '--no-session-persistence',
      ],
      { cwd: options.cwd, shell: false, windowsHide: true },
    );

    let pending = '';
    let stderr = '';
    let settled = false;
    let outcome: ClaudeRunResult = {
      ok: false,
      answer: '',
      error: 'Claude Code ended without an answer',
    };

    const finish = (result: ClaudeRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, answer: '', error: 'The analysis timed out' });
    }, CLAUDE_TIMEOUT_MS);

    const onAbort = (): void => {
      child.kill();
      finish({ ok: false, answer: '', error: 'The analysis was cancelled' });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (pending.length > MAX_OUTPUT) {
        return;
      }
      const split = splitLines(pending + chunk.toString('utf8'));
      pending = split.rest;
      for (const line of split.lines) {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          // A line that is not JSON is noise from the CLI, not an event: ignoring it keeps a
          // cosmetic change to that output from breaking the run.
          continue;
        }
        options.onEvent?.(event);
        const finalResult = readResultEvent(event);
        if (finalResult !== null) {
          outcome = finalResult;
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += chunk.toString('utf8');
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      // A missing binary is the one failure worth naming precisely: everything else in this tab
      // works, and "claude was not found" is actionable where "spawn ENOENT" is not.
      const message =
        error.code === 'ENOENT'
          ? 'Claude Code was not found on the PATH'
          : `Could not start Claude Code: ${error.message}`;
      finish({ ok: false, answer: '', error: message });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, answer: '', error: firstLine(stderr) || `Claude Code exited with ${code}` });
        return;
      }
      // A clean exit with no `result` event is possible in principle, and the default outcome says
      // exactly that rather than reporting an empty triage as a successful one.
      finish(outcome);
    });

    child.stdin.on('error', () => {
      // A stdin pipe closed by a process that died is already reported by `error` or `close`.
    });
    child.stdin.end(options.prompt, 'utf8');
  });
}

/**
 * Reads the stream's closing `result` event, or returns null for every other event.
 *
 * That event carries its own `is_error`, which is how a refusal or an API failure arrives with a
 * perfectly successful exit code. Trusting the exit code alone would show an empty triage as a
 * successful one.
 */
function readResultEvent(event: unknown): ClaudeRunResult | null {
  if (typeof event !== 'object' || event === null) {
    return null;
  }
  const record = event as { type?: unknown; is_error?: unknown; result?: unknown };
  if (record.type !== 'result') {
    return null;
  }
  const answer = typeof record.result === 'string' ? record.result : '';
  if (record.is_error === true) {
    return { ok: false, answer: '', error: firstLine(answer) || 'Claude Code reported an error' };
  }
  return { ok: true, answer, error: null };
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}
