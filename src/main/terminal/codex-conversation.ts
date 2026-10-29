import { Worker } from 'node:worker_threads';
import {
  CONVERSATION_ID_PATTERN,
  isCodexProfile,
  resumeArguments,
  conversationArgs,
  splitCommand,
  type AgentProfile,
} from '@shared/agent-profile.js';
import type { AgentConversation } from '@shared/contracts.js';
import { cmdLine, resolveCommand, type ResolvedCommand } from '../spawn/command-resolve.js';
import { newConversation } from '../triage/work-command.js';

/** Keep only configuration flags: TUI permission flags are not app-server arguments. */
export function codexConfigArgs(profile: AgentProfile): string[] {
  const tokens = splitCommand(profile.interactive.replace('{model}', ''));
  const args: string[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (/^--remote(?:=|$)|^--remote-auth-token-env(?:=|$)/.test(token)) {
      throw new Error(
        'Automatic Codex session restoration currently requires a local Codex command',
      );
    }
    // Codex explicitly refuses --profile on app-server, even before the protocol handshake.
    if (token === '-p' || /^--profile(?:=|$)/.test(token)) {
      throw new Error(
        'Automatic Codex session restoration does not support --profile; use -c configuration overrides',
      );
    }
    if (['-c', '--config', '--enable', '--disable'].includes(token)) {
      const value = tokens[++i];
      if (value === undefined) {
        throw new Error(`Missing value for ${token}`);
      }
      args.push(token, value);
    } else if (/^--(?:config|enable|disable)=/.test(token) || /^-c.+/.test(token)) {
      args.push(token);
    }
  }
  return args;
}

/*
 * A short local JSON-RPC exchange, on a worker so CreateProcessW cannot freeze the terminals.
 * No turn/start is sent: this creates persistent metadata, never a model request or agent work.
 * Each launch has its own request/response channel; simultaneous tabs never match by cwd or time.
 */
const WORKER_SOURCE = String.raw`
const { spawn, execFile } = require('node:child_process');
const { parentPort, workerData: job } = require('node:worker_threads');
let child;
let buffer = '';
let threadId = '';
let outcome;
let killTimer;
const timer = setTimeout(() => finish({ error: 'Codex session creation timed out' }), job.timeoutMs);
const reply = () => {
  clearTimeout(timer);
  clearTimeout(killTimer);
  parentPort.postMessage(outcome || { error: 'Codex app-server closed before creating a session' });
};
const kill = () => {
  if (!child || child.exitCode !== null || typeof child.pid !== 'number') return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => {});
  } else child.kill('SIGKILL');
};
function finish(value) {
  if (outcome) return;
  outcome = value;
  clearTimeout(timer);
  if (!child) { reply(); return; }
  child.stdin.end();
  if (value.error) kill();
  else killTimer = setTimeout(kill, 2000);
}
const send = (id, method, params) => {
  child.stdin.write(JSON.stringify({ ...(id === undefined ? {} : { id }), method, params }) + '\n');
};
parentPort.on('message', () => finish({ error: 'Codex session creation was cancelled' }));
try {
  child = spawn(job.file, job.args, {
    cwd: job.cwd,
    windowsHide: true,
    windowsVerbatimArguments: job.verbatim,
    env: { ...process.env, ...job.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  child.once('error', (error) => finish({ error: error.message }));
  child.once('close', reply);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (outcome) return;
    buffer += chunk.toString('utf8');
    if (buffer.length > 4 * 1024 * 1024) {
      finish({ error: 'Codex app-server returned an oversized response' }); return;
    }
    let end;
    while (!outcome && (end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      if (message.error && [0, 1, 2].includes(message.id)) {
        finish({ error: String(message.error.message || 'Codex rejected the session request') }); return;
      }
      if (!message.result) continue;
      if (message.id === 0) {
        send(undefined, 'initialized', {});
        send(1, 'thread/start', { cwd: job.cwd, ephemeral: false, ...(job.model ? { model: job.model } : {}) });
      } else if (message.id === 1) {
        threadId = message.result.thread?.id;
        if (typeof threadId !== 'string' || !job.idPattern.test(threadId)) {
          finish({ error: 'Codex returned an invalid conversation id' }); return;
        }
        if (job.title) send(2, 'thread/name/set', { threadId, name: job.title });
        else finish({ id: threadId });
      } else if (message.id === 2) finish({ id: threadId });
    }
  });
  send(0, 'initialize', { clientInfo: { name: 'oxum_dev_dashboard', version: '1.0.0' } });
} catch (error) { finish({ error: error.message || String(error) }); }
`;

const pending = new Set<{ cancel: () => void; done: Promise<void> }>();
let stopped = false;
let creationQueue: Promise<void> = Promise.resolve();

/** Stop preparation before quit, so an awaited launch cannot open a new tab during shutdown. */
export function stopCodexPreparations(): Promise<void> | null {
  stopped = true;
  if (pending.size === 0) return null;
  return Promise.all(
    [...pending].map(({ cancel, done }) => {
      cancel();
      return done;
    }),
  ).then(() => undefined);
}

export interface CodexThreadOptions {
  readonly target: ResolvedCommand;
  readonly configArgs: readonly string[];
  readonly cwd: string;
  readonly model: string;
  readonly title: string;
  readonly timeoutMs?: number;
  /** Used by isolated protocol tests, never a replacement for the user's environment. */
  readonly env?: Readonly<Record<string, string>>;
}

/** One extra process at a time, including when a fresh Codex home still needs initialization. */
export function createCodexThread(options: CodexThreadOptions): Promise<string> {
  const task = creationQueue.then(() => runCodexThread(options));
  creationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function runCodexThread(options: CodexThreadOptions): Promise<string> {
  if (stopped) throw new Error('Codex session creation was cancelled');
  const args = [...options.configArgs, 'app-server', '--listen', 'stdio://'];
  const line = options.target.viaCmd ? cmdLine(options.target.file, args) : null;
  if (options.target.viaCmd && line === null) {
    throw new Error(
      'The Codex command contains characters that cannot pass through cmd.exe safely',
    );
  }
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      ...options,
      file: options.target.viaCmd ? (process.env['ComSpec'] ?? 'cmd.exe') : options.target.file,
      args: line === null ? args : ['/d', '/s', '/c', line],
      verbatim: options.target.viaCmd,
      timeoutMs: options.timeoutMs ?? 30_000,
      idPattern: CONVERSATION_ID_PATTERN,
    },
  });
  const request = {
    cancel: (): void => {
      worker.postMessage('cancel');
    },
    done: new Promise<void>((resolve) => {
      worker.once('exit', () => resolve());
    }),
  };
  pending.add(request);
  try {
    const id = await new Promise<string>((resolve, reject) => {
      worker.once('message', (reply: { id?: string; error?: string }) => {
        if (typeof reply.id === 'string' && CONVERSATION_ID_PATTERN.test(reply.id))
          resolve(reply.id);
        else reject(new Error(reply.error ?? 'Codex did not return a conversation id'));
      });
      worker.once('error', reject);
      worker.once('exit', () =>
        reject(new Error('Codex session preparation stopped before answering')),
      );
    });
    // Quit can arrive after the id was received but before the server finished closing.
    if (stopped) throw new Error('Codex session creation was cancelled');
    return id;
  } finally {
    await worker.terminate();
    pending.delete(request);
  }
}

export interface PreparedConversation {
  readonly args: string;
  readonly conversation: AgentConversation;
}

/** Prepare an id before any launch path opens a PTY. A failed preparation is reported to the caller. */
export async function prepareConversation(
  profile: AgentProfile,
  plan: boolean,
  cwd: string,
  model: string,
  title: string,
): Promise<PreparedConversation | null> {
  if (!isCodexProfile(profile)) {
    const fresh = newConversation(profile, plan);
    return fresh === null ? null : { args: fresh.args, conversation: { id: fresh.id, plan } };
  }
  const program = splitCommand(profile.interactive)[0] ?? '';
  const target = await resolveCommand(program);
  if (target === null) throw new Error(`${program} was not found. Set its path in Settings`);
  const id = await createCodexThread({
    target,
    configArgs: codexConfigArgs(profile),
    cwd,
    model,
    title,
  });
  return {
    args: conversationArgs(resumeArguments(profile), id),
    conversation: { id, plan, provider: 'codex' },
  };
}
