import { Worker } from 'node:worker_threads';

/**
 * Starting child processes on worker threads, so that starting one cannot freeze the terminal.
 *
 * This is the load-bearing performance decision of the app, and it is the only one that does not
 * depend on counting anything. The mechanism, measured on 2026-09-09 on the machine this runs on:
 *
 * - libuv's `uv_spawn` calls `CreateProcessW` **synchronously on the event loop thread of whoever
 *   calls it**. A spawn is therefore not merely work the loop has to get through, it is time the loop
 *   is not running at all.
 * - The cost of that call is **bimodal**, and the median hides it completely: over 150 sequential
 *   spawns, the synchronous part measured **p50 8 ms, p90 22 ms, p99 851 ms, max 1653 ms**. Roughly
 *   one spawn in thirteen holds the thread for over 100 ms. The distribution is identical for
 *   `cmd /c exit` and for `git status`, so it is process creation being hooked by the endpoint
 *   scanner, not git working. The exclusion list is locked by policy and cannot be changed by
 *   whoever runs this.
 * - A keystroke's echo travels renderer to main to pty to main to renderer, so a blocked main
 *   process is literally a terminal that has stopped echoing.
 *
 * The consequence is that a **concurrency limit cannot fix this**, and that is worth being blunt
 * about because the app tried it first: a pool spreads the median out and does nothing whatsoever to
 * the tail. Measured on the real eleven-project configuration, the projects table's own poll, already
 * one call per project through a pool of four, still stalled the main process for **429 to 468 ms on
 * four passes out of five**. Cutting the spawn count helps proportionally and is worth doing, and was
 * done, but it only makes the lottery smaller: every remaining spawn is still a ticket.
 *
 * Moving the spawn to another thread takes the app out of the lottery entirely. Same eleven calls,
 * same pool of four, worst lag of the **main** loop:
 *
 * | where the spawn happens | worst main-loop lag | mean wall |
 * |---|---|---|
 * | main thread             | 529 ms | 496 ms |
 * | worker thread           | **27 ms** | 1825 ms |
 *
 * The wall time gets worse and that is the trade, taken deliberately: this serves background polls
 * every ten seconds and reads behind a tab, where a second of wall time is invisible, against a
 * half-second freeze while typing, which is the thing being complained about. Anything a user waits
 * on synchronously is a terminal tab, and those are ptys, which never came through here.
 *
 * **The worker's source is a string evaluated in the thread, not a file**, and that is not laziness.
 * A worker loaded from a path has to resolve that path in three different layouts: the dev server,
 * `out/main` after a build, and inside `app.asar` after packaging, where a worker thread bootstraps a
 * file through a loader that the main thread's asar patching does not obviously cover. This project
 * has one CI gate and it runs at tag time, so a packaging-only failure is found by cutting a release,
 * which is the worst place to find one. A string has no path to resolve and behaves identically in
 * all three. The body is kept to the smallest thing that can be wrong, and
 * `test/spawn-pool.test.ts` drives the real pool against a real executable rather than trusting it.
 */

/** What a caller asks for. Mirrors the `execFile` options this app actually uses, and nothing else. */
export interface SpawnRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeout: number;
  readonly maxBuffer: number;
  /** Added on top of the worker's environment, never replacing it. */
  readonly env?: Readonly<Record<string, string>>;
}

/** What a caller gets back on success. */
export interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A failure, shaped like the error `execFile` rejects with.
 *
 * Deliberately the same shape rather than a nicer one: `describeGitError` and the GitHub services all
 * read `stderr`, then `stdout`, then `message` off the rejection, and git's own stderr is the most
 * useful sentence anyone here could show. Changing the shape would mean rewriting those readers for
 * no gain, and the risk of that rewrite is silently losing the message a user needs.
 */
export class SpawnError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly killed: boolean;

  constructor(init: {
    message: string;
    stdout: string;
    stderr: string;
    code: number | null;
    killed: boolean;
  }) {
    super(init.message);
    this.name = 'SpawnError';
    this.stdout = init.stdout;
    this.stderr = init.stderr;
    this.code = init.code;
    this.killed = init.killed;
  }
}

/** The message the worker posts back. Plain data: it crosses a thread boundary. */
interface WorkerReply {
  readonly id: number;
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
  readonly code: number | null;
  readonly killed: boolean;
}

/**
 * The worker body.
 *
 * Everything it does is answer one message with one message. It never throws out of the handler: a
 * worker that dies takes every request in flight with it, and the failure a caller has to be able to
 * see is "this command failed", not "the thread that runs commands is gone".
 */
const WORKER_SOURCE = `
const { execFile } = require('node:child_process');
const { parentPort } = require('node:worker_threads');

parentPort.on('message', (job) => {
  const options = {
    windowsHide: true,
    timeout: job.timeout,
    maxBuffer: job.maxBuffer,
  };
  if (typeof job.cwd === 'string') {
    options.cwd = job.cwd;
  }
  if (job.env) {
    options.env = { ...process.env, ...job.env };
  }

  const reply = (fields) => {
    parentPort.postMessage({
      id: job.id,
      ok: false,
      stdout: '',
      stderr: '',
      message: '',
      code: null,
      killed: false,
      ...fields,
    });
  };

  try {
    execFile(job.file, job.args, options, (error, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
      const err = typeof stderr === 'string' ? stderr : String(stderr ?? '');
      if (error) {
        reply({
          stdout: out,
          stderr: err,
          message: error.message ?? String(error),
          code: typeof error.code === 'number' ? error.code : null,
          killed: error.killed === true,
        });
        return;
      }
      reply({ ok: true, stdout: out, stderr: err });
    });
  } catch (error) {
    // A missing executable throws here rather than calling back, and it is the case that matters:
    // the app has to say "command not found" in the tab that was going to use it.
    reply({ message: error && error.message ? error.message : String(error) });
  }
});
`;

/**
 * How many threads spawn on this app's behalf.
 *
 * Six, matching `VIEW_CONCURRENCY`, and the equality is the decision: the widest caller in the app
 * allows six calls in flight, so it must find six lanes rather than queue behind one stuck in
 * `CreateProcessW`. Measured on 2026-09-09, the Git tab's five-call read went from 1068 ms of wall
 * time on four lanes to 173 ms on six, with the main loop unaffected either way; eight lanes bought
 * nothing. Not imported from that constant, to keep this module free of any dependency on the
 * policies it serves, so the two numbers are kept equal by this comment and the one over there.
 *
 * A lane costs a thread that is idle almost all the time, which is why the number can be chosen for
 * the widest caller rather than rationed.
 */
const WORKER_COUNT = 6;

interface Lane {
  readonly worker: Worker;
  outstanding: number;
}

interface Pending {
  readonly resolve: (result: SpawnResult) => void;
  readonly reject: (error: unknown) => void;
  readonly lane: Lane;
}

const lanes: Lane[] = [];
const pending = new Map<number, Pending>();
let nextId = 0;

/**
 * The lane to send the next job to: the one with the least work outstanding.
 *
 * Least-outstanding and not round-robin, because the jobs are not interchangeable in duration. One
 * lane holding a `gh` call over a slow network while the others idle is the normal case, and
 * round-robin would hand it the next job anyway.
 */
function pickLane(): Lane {
  while (lanes.length < WORKER_COUNT) {
    lanes.push(startLane());
  }
  // Non-null: the loop above guarantees the list is full, and `WORKER_COUNT` is positive.
  let best = lanes[0] as Lane;
  for (const lane of lanes) {
    if (lane.outstanding < best.outstanding) {
      best = lane;
    }
  }
  return best;
}

function startLane(): Lane {
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  const lane: Lane = { worker, outstanding: 0 };

  worker.on('message', (reply: WorkerReply) => {
    const waiting = pending.get(reply.id);
    if (waiting === undefined) {
      return;
    }
    pending.delete(reply.id);
    lane.outstanding = Math.max(0, lane.outstanding - 1);
    if (reply.ok) {
      waiting.resolve({ stdout: reply.stdout, stderr: reply.stderr });
      return;
    }
    waiting.reject(
      new SpawnError({
        message: reply.message,
        stdout: reply.stdout,
        stderr: reply.stderr,
        code: reply.code,
        killed: reply.killed,
      }),
    );
  });

  /*
   * A lane that dies is dropped, and everything it was carrying fails loudly.
   *
   * Both halves matter. Leaving the promises unsettled would hang whatever asked for them, and a
   * strip that says `Reading...` forever is the failure mode this app spends most of its comments
   * avoiding. Keeping the dead lane in the list would send every future job to a `Worker` whose
   * `postMessage` goes nowhere, which is the same hang arriving later. The next call builds a
   * replacement, because `pickLane` refills the list.
   */
  const abandon = (reason: string): void => {
    const index = lanes.indexOf(lane);
    if (index !== -1) {
      lanes.splice(index, 1);
    }
    for (const [id, waiting] of [...pending]) {
      if (waiting.lane === lane) {
        pending.delete(id);
        waiting.reject(
          new SpawnError({ message: reason, stdout: '', stderr: '', code: null, killed: false }),
        );
      }
    }
  };

  worker.on('error', (error: Error) => abandon(`The command runner failed: ${error.message}`));
  worker.on('exit', () => abandon('The command runner stopped before the command answered'));
  // The threads must not hold the app open: quitting is decided by the windows, and a lane sitting
  // idle on its message port would otherwise keep the process alive after the last one closed.
  worker.unref();

  return lane;
}

/**
 * Runs one command on a worker thread and resolves with its output.
 *
 * Rejects with a {@link SpawnError} on a non-zero exit, a timeout or a missing executable, which is
 * the contract `execFile` had and every caller here was written against.
 */
export async function spawnOffThread(request: SpawnRequest): Promise<SpawnResult> {
  const lane = pickLane();
  nextId += 1;
  const id = nextId;

  return new Promise<SpawnResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, lane });
    lane.outstanding += 1;
    lane.worker.postMessage({
      id,
      file: request.file,
      args: [...request.args],
      cwd: request.cwd,
      timeout: request.timeout,
      maxBuffer: request.maxBuffer,
      env: request.env,
    });
  });
}

/**
 * Stops every lane. For tests, and for a clean quit.
 *
 * Not called on the app's own shutdown path: the lanes are `unref`'d, so they do not hold the process
 * open, and `app.quit` has enough to do. A test that leaves threads running is a test runner that
 * does not exit, which is why this is exported at all.
 */
export async function stopSpawnPool(): Promise<void> {
  const running = [...lanes];
  lanes.length = 0;
  await Promise.all(running.map((lane) => lane.worker.terminate()));
}
