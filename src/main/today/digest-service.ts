import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  DIGEST_TOOLS,
  digestArgs,
  digestPrompt,
  localDay,
  parseDigest,
  readStoredDigest,
  readToolCalls,
  type TodayDigest,
  type TodayDigestState,
} from '@shared/today.js';
import { runCli, type CliResult } from '../extensions/agent-cli.js';
import { atomicWriteFile } from '../store/atomic-write.js';
import { AppPaths } from '../store/paths.js';

/**
 * The Microsoft 365 half of the Today tab: calendar, mail and Teams, read through Claude Code.
 *
 * Microsoft Graph cannot be reached directly without an app registration, which many tenants
 * refuse. The claude.ai Microsoft 365 connector carries its own, and it is only reachable from
 * inside Claude Code, so one headless run makes the read calls and the data is taken from the
 * transcript's tool results. Same shape as the routines reader, for the same reason.
 *
 * Run on demand only: at the first look of the day and on Refresh. Each run costs a few seconds and
 * about a cent, which a poll would multiply by the hours the app is open for nobody looking.
 */

const RUN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

export interface DigestServiceDeps {
  /** The Claude Code command, as configured. */
  readonly command: () => string;
  readonly onChange: (state: TodayDigestState) => void;
  /** Replaced in tests. */
  readonly run?: (command: string, args: readonly string[], timeout: number) => Promise<CliResult>;
  readonly now?: () => Date;
  readonly file?: string;
}

export class DigestService {
  private digest: TodayDigest | null = null;
  private running = false;
  private startedAt: string | null = null;
  private error: string | null = null;
  private inFlight: Promise<TodayDigestState> | null = null;
  /** The day of the last attempt, so a run that failed is not retried on every tab switch. */
  private attemptedDay = '';

  constructor(private readonly deps: DigestServiceDeps) {}

  async load(): Promise<void> {
    try {
      this.digest = readStoredDigest(JSON.parse(await readFile(this.file(), 'utf8')) as unknown);
    } catch {
      // No digest yet, or an unreadable one: the next look of the day reads a fresh one.
      this.digest = null;
    }
  }

  state(): TodayDigestState {
    return {
      digest: this.digest,
      running: this.running,
      startedAt: this.startedAt,
      error: this.error,
    };
  }

  /** Reads again, unless a run is already under way, in which case its answer is shared. */
  refresh(): Promise<TodayDigestState> {
    this.inFlight ??= this.runOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Reads only when nothing has been tried today: the tab's first look of the day. */
  async refreshIfStale(): Promise<TodayDigestState> {
    const today = localDay(this.now());
    if (this.attemptedDay === today || this.digest?.day === today) {
      return this.state();
    }
    return this.refresh();
  }

  /** One call, to say whether the connector answers and as whom. */
  async test(): Promise<{ ok: boolean; message: string }> {
    const command = this.deps.command();
    const prompt = `Call ${DIGEST_TOOLS.me} once with no arguments, then reply with the single word OK.`;
    const result = await this.runner()(command, digestArgs(prompt), TEST_TIMEOUT_MS);
    const line = describeCommand(command);
    if (!result.ok) {
      return { ok: false, message: `${scrub(result.message, prompt)}. Command: ${line}` };
    }
    const call = readToolCalls(result.stdout).find((entry) => entry.name === DIGEST_TOOLS.me);
    if (call === undefined) {
      return { ok: false, message: `${NO_CONNECTOR}. Command: ${line}` };
    }
    if (call.isError) {
      return {
        ok: false,
        message: `The connector refused: ${call.pieces.join(' ').slice(0, 200)}`,
      };
    }
    const me = readIdentity(call.pieces);
    return {
      ok: true,
      message: me.length > 0 ? `Connected as ${me}` : 'The connector answered',
    };
  }

  private async runOnce(): Promise<TodayDigestState> {
    const now = this.now();
    const command = this.deps.command();
    const prompt = digestPrompt(now);
    this.attemptedDay = localDay(now);
    this.running = true;
    this.startedAt = now.toISOString();
    this.error = null;
    this.deps.onChange(this.state());
    try {
      const result = await this.runner()(command, digestArgs(prompt), RUN_TIMEOUT_MS);
      if (!result.ok) {
        this.error = `${scrub(result.message, prompt)}. Command: ${describeCommand(command)}`;
        return this.state();
      }
      const calls = readToolCalls(result.stdout);
      if (!calls.some((call) => call.name.startsWith('mcp__claude_ai_Microsoft_365__'))) {
        this.error = `${NO_CONNECTOR}. Command: ${describeCommand(command)}`;
        return this.state();
      }
      this.digest = parseDigest(calls, now.toISOString(), localDay(now));
      await atomicWriteFile(this.file(), `${JSON.stringify(this.digest, null, 2)}\n`).catch(() => {
        // The digest is on screen either way; losing the cache only costs a run at the next launch.
      });
      return this.state();
    } finally {
      this.running = false;
      this.startedAt = null;
      this.deps.onChange(this.state());
    }
  }

  private runner(): (
    command: string,
    args: readonly string[],
    timeout: number,
  ) => Promise<CliResult> {
    return (
      this.deps.run ??
      ((command, args, timeout) => runCli(command, args, { cwd: tmpdir(), timeout }))
    );
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private file(): string {
    return this.deps.file ?? AppPaths.todayDigest();
  }
}

const NO_CONNECTOR =
  'Claude Code made no Microsoft 365 call. Is the claude.ai Microsoft 365 connector connected for this account?';

/** The line a reader can paste to reproduce the run, with the prompt left out. */
export function describeCommand(command: string): string {
  const args = digestArgs('<prompt>').map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
  return `${command} ${args.join(' ')}`;
}

/** `runCli` names the command with its first arguments, which here include the whole prompt. */
function scrub(message: string, prompt: string): string {
  return message.split(prompt).join('<prompt>');
}

function readIdentity(pieces: readonly string[]): string {
  for (const piece of pieces) {
    try {
      const value = JSON.parse(piece) as unknown;
      if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        const name = typeof record['displayName'] === 'string' ? record['displayName'] : '';
        const mail = typeof record['mail'] === 'string' ? record['mail'] : '';
        return mail.length > 0 ? `${name} (${mail})`.trim() : name;
      }
    } catch {
      // Not the identity.
    }
  }
  return '';
}
