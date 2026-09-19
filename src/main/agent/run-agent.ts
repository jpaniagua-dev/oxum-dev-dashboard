import { spawn } from 'node:child_process';
import {
  buildHeadlessCommand,
  describeCommand,
  type AgentProfile,
} from '@shared/agent-profile.js';
import { splitLines } from './agent-progress.js';

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
export const AGENT_TIMEOUT_MS = 15 * 60_000;

/**
 * Budget for the settings window's one-shot test.
 *
 * Short on purpose: the test measures the plumbing, not the model, so an agent that has not answered
 * a one-word prompt in thirty seconds is one whose command line is wrong. Waiting out the analysis
 * budget to learn that would make configuring a profile a quarter of an hour per attempt.
 */
export const AGENT_TEST_TIMEOUT_MS = 30_000;

/** Answers can be long; the default 1 MB pipe buffer is not a limit worth discovering in use. */
const MAX_OUTPUT = 8 * 1024 * 1024;

export interface AgentRunResult {
  readonly ok: boolean;
  /** The model's answer, empty when the run failed. */
  readonly answer: string;
  readonly error: string | null;
}

export interface AgentRunOptions {
  /**
   * Which agent to run, and how.
   *
   * Passed in rather than read from a module constant, because it is a setting: this app drives
   * whichever CLI coding agent its user has, and the binary, the flags, the way the prompt gets in
   * and the way the answer comes out all differ between them.
   */
  readonly profile: AgentProfile;
  /** Where the run happens, so the agent can read the code it is being asked about. */
  readonly cwd: string;
  readonly prompt: string;
  /**
   * Model to pin the run to, or empty for whatever the agent itself is set to.
   *
   * Per call and not a module constant, because the headless runs in this app are different jobs:
   * classifying a sprint is bulk reading, writing a commit message from a diff is short and frequent.
   * Empty omits the flag entirely; an empty `--model ""` is an error, not a default, and the profile
   * decides how the flag is even spelled.
   */
  readonly model?: string;
  /**
   * Budget for this run, defaulting to `AGENT_TIMEOUT_MS`.
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
  /**
   * Extra folders the run may read, beside `cwd`.
   *
   * One repetition of the profile's own flag per entry, and nothing at all when the list is empty
   * or when the profile declares no such flag.
   *
   * It exists because the pull request review is the first run that needs **two** trees. The
   * standards it applies live one level up, in the workspace; the conventions of the repository
   * being reviewed live in the repository. A review needs both, and `cwd` is one folder. An agent
   * whose CLI cannot open a second directory is not refused: the caller runs it in the repository
   * instead, which is the half a code review cannot do without.
   */
  readonly extraDirs?: readonly string[];
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
 *   default" has to be the absence of the flag and not an empty one. `--add-dir` follows the same
 *   rule: no entries, no flag.
 */
/**
 * `--add-dir <path>` per extra folder, and nothing at all for none.
 *
 * Exported so the argv can be asserted without spawning anything: the guarantee that the two runs
 * that predate this option still produce the exact command line they did is the kind that is easy to
 * believe and easy to break.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const label = options.label ?? 'The run';
  const agent = options.profile.label;
  const { file, args } = buildHeadlessCommand(options.profile, {
    model: options.model ?? '',
    extraDirs: options.extraDirs ?? [],
    prompt: options.prompt,
  });

  /*
   * The command line, kept for every message this function writes.
   *
   * A headless run has no terminal tab, by design: its output is a payload to parse rather than
   * something to read. The cost is that when one fails there is nothing on screen saying what was
   * actually launched, and a wrong flag then reads as six minutes of silence followed by "timed
   * out". Naming the command in the error is what turns that into something diagnosable, and it
   * matters more now that the command is a setting rather than a constant.
   */
  const commandLine = describeCommand(file, args);

  if (file.length === 0) {
    return { ok: false, answer: '', error: `${agent} has no command configured` };
  }

  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options.cwd, shell: false, windowsHide: true });

    let pending = '';
    /** Everything printed, for a profile whose answer is its plain output. */
    let plain = '';
    let stderr = '';
    let settled = false;
    let outcome: AgentRunResult = {
      ok: false,
      answer: '',
      error: `${agent} ended without an answer  ·  ${commandLine}`,
    };

    const finish = (result: AgentRunResult): void => {
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
    }, options.timeoutMs ?? AGENT_TIMEOUT_MS);

    const onAbort = (): void => {
      child.kill();
      finish({ ok: false, answer: '', error: `${label} was cancelled` });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    /*
     * Two ways of reading an answer, and the profile decides which.
     *
     * `stream-json` is line-delimited JSON: every tool call arrives as it happens, which is what
     * makes the live progress line possible, and the closing event carries its own error flag.
     * `stdout` is the universal fallback, the whole output taken as the answer. It works for every
     * agent and costs the progress detail, because there is nothing in it to count. Showing a
     * spinner is the honest version of that; inventing activity would not be.
     */
    child.stdout.on('data', (chunk: Buffer) => {
      if (pending.length > MAX_OUTPUT) {
        return;
      }
      const text = chunk.toString('utf8');

      if (options.profile.answerFormat !== 'stream-json') {
        plain += text;
        return;
      }

      const split = splitLines(pending + text);
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
          ? `${agent} was not found on the PATH  ·  ${commandLine}`
          : `Could not start ${agent}: ${error.message}  ·  ${commandLine}`;
      finish({ ok: false, answer: '', error: message });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        finish({
          ok: false,
          answer: '',
          error: `${firstLine(stderr) || `${agent} exited with ${code}`}  ·  ${commandLine}`,
        });
        return;
      }
      if (options.profile.answerFormat !== 'stream-json') {
        /*
         * A clean exit is the whole signal here, and that is a real limitation worth naming: an
         * agent that refuses politely and exits 0 is indistinguishable from one that answered. The
         * stream-json path does better because its closing event carries `is_error`, which is why
         * the progress detail is not the only thing that format buys.
         */
        const answer = plain.trim();
        finish(
          answer.length === 0
            ? { ok: false, answer: '', error: `${agent} answered nothing  ·  ${commandLine}` }
            : { ok: true, answer, error: null },
        );
        return;
      }
      // A clean exit with no `result` event is possible in principle, and the default outcome says
      // exactly that rather than reporting an empty triage as a successful one.
      finish(outcome);
    });

    child.stdin.on('error', () => {
      // A stdin pipe closed by a process that died is already reported by `error` or `close`.
    });
    /*
     * The prompt goes in on stdin unless the profile says otherwise.
     *
     * stdin is the one delivery that has no size limit, and a sprint of twenty tickets with their
     * descriptions is tens of kilobytes, well past what a Windows command line accepts. An agent
     * that only reads an argument gets it appended by `buildHeadlessCommand`, and is the reason that
     * function exists rather than a constant: passing a prompt that large as an argument fails with
     * a truncation rather than an error.
     *
     * stdin is closed either way. A CLI waiting on an input that never ends is a run that hangs
     * until its timeout, which is the failure this whole module is arranged to avoid.
     */
    if (options.profile.promptVia === 'stdin') {
      child.stdin.end(options.prompt, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Reads the stream's closing `result` event, or returns null for every other event.
 *
 * That event carries its own `is_error`, which is how a refusal or an API failure arrives with a
 * perfectly successful exit code. Trusting the exit code alone would show an empty triage as a
 * successful one.
 */
function readResultEvent(event: unknown): AgentRunResult | null {
  if (typeof event !== 'object' || event === null) {
    return null;
  }
  const record = event as { type?: unknown; is_error?: unknown; result?: unknown };
  if (record.type !== 'result') {
    return null;
  }
  const answer = typeof record.result === 'string' ? record.result : '';
  if (record.is_error === true) {
    return { ok: false, answer: '', error: firstLine(answer) || 'The agent reported an error' };
  }
  return { ok: true, answer, error: null };
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}
