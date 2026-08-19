import { spawn } from 'node:child_process';
import { modelArgs } from '@shared/claude-model.js';
import { splitLines } from './triage-progress.js';

/**
 * A headless Claude Code run: the Triage tab's sprint analysis, and the Git tab's commit message.
 *
 * Not a terminal tab, and that is a deliberate departure from "every row action ends in a tab": a
 * tab is the right home for a command whose **output** is the point (a dev server, a commit and its
 * hooks). In both of these the output is a payload the caller has to parse and put somewhere, so
 * they belong with the services that call `gh` and Jira from the main process. What the rule really
 * protects, that no work happens in a window the app cannot show or stop, still holds: each run shows
 * as a state on the control that started it, and the process is killed on timeout.
 *
 * It lives under `triage/` because that is where it was written. Moving it now would be churn in
 * every importer for a folder name; what matters is that it is not triage-specific, and its options
 * say so.
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
  /**
   * Model to pin the run to, or empty for whatever Claude Code itself is set to.
   *
   * Per call and not a module constant, because the two headless runs in this app are different jobs:
   * classifying a sprint is bulk reading, writing a commit message from a diff is short and frequent.
   * Empty omits the flag entirely; `--model ""` is an error, not a default.
   */
  readonly model?: string;
  /**
   * Budget for this run, defaulting to `CLAUDE_TIMEOUT_MS`.
   *
   * The sprint analysis needs fifteen minutes; a commit message that has not arrived in three is not
   * coming, and waiting out the sprint budget for it would leave a button held for a quarter of an
   * hour. One constant for both would have to be the larger, which is the wrong answer for the run
   * somebody is watching.
   */
  readonly timeoutMs?: number;
  /**
   * How this run is named when it times out or is cancelled, e.g. `The analysis`.
   *
   * The two messages are the only ones this module writes that a user reads, and "the analysis timed
   * out" in front of a commit form describes something nobody asked for.
   */
  readonly label?: string;
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
 * - **`--model` last, and only when there is one.** The CLI rejects a blank model, so "use the
 *   default" has to be the absence of the flag and not an empty one.
 */
export async function runClaude(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const label = options.label ?? 'The run';
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
        ...modelArgs(options.model ?? ''),
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
      finish({ ok: false, answer: '', error: `${label} timed out` });
    }, options.timeoutMs ?? CLAUDE_TIMEOUT_MS);

    const onAbort = (): void => {
      child.kill();
      finish({ ok: false, answer: '', error: `${label} was cancelled` });
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
