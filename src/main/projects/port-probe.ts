import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 10_000;

/** One listening dev process, with the repository it was started from. */
export interface ListeningServer {
  readonly port: number;
  readonly pid: number;
  /** Repository path extracted from the command line, when recognisable. */
  readonly repoPath: string | null;
  readonly commandLine: string;
}

/**
 * Lists node processes that are listening on a TCP port, with the repository each belongs to.
 *
 * This is what lets the dashboard show servers it did not start. Identity is keyed on the
 * repository path from the command line, never on the port: a port says nothing about which
 * checkout it serves, and running the same project from two worktrees on two ports is normal.
 */
export async function listListeningNodeServers(): Promise<ListeningServer[]> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$nodePids = (Get-Process node).Id
$conns = Get-NetTCPConnection -State Listen | Where-Object { $nodePids -contains $_.OwningProcess }
$procs = @{}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ForEach-Object { $procs[[int]$_.ProcessId] = $_.CommandLine }
$out = foreach ($c in $conns) {
  [pscustomobject]@{ port = [int]$c.LocalPort; pid = [int]$c.OwningProcess; cmd = [string]$procs[[int]$c.OwningProcess] }
}
if ($null -eq $out) { '[]' } else { ,@($out) | ConvertTo-Json -Compress -Depth 3 }
`;

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    return parseListeningServers(stdout);
  } catch {
    // A probe failure must not take the dashboard down: it just means no external server is known
    // this cycle.
    return [];
  }
}

/** Parses the PowerShell payload. Exported for testing without a live machine. */
export function parseListeningServers(stdout: string): ListeningServer[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const entries = unwrapEntries(payload);
  const servers: ListeningServer[] = [];

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const port = typeof record.port === 'number' ? record.port : Number.NaN;
    const pid = typeof record.pid === 'number' ? record.pid : Number.NaN;
    if (!Number.isFinite(port) || !Number.isFinite(pid)) {
      continue;
    }
    const commandLine = typeof record.cmd === 'string' ? record.cmd : '';
    servers.push({ port, pid, commandLine, repoPath: extractRepoPath(commandLine) });
  }

  return servers;
}

/**
 * Normalises the three shapes `ConvertTo-Json` can produce.
 *
 * Windows PowerShell 5.1 does not have `-AsArray`, and forcing an array with the `,@(...)` idiom
 * makes it serialise an envelope, `{"value":[...],"Count":2}`, rather than a bare array. Without
 * this, every external server is silently dropped even though the query worked, which is exactly
 * how the first version failed: the probe reported nothing while a server was plainly listening.
 */
function unwrapEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (typeof payload === 'object' && payload !== null) {
    const wrapped = (payload as { value?: unknown }).value;
    if (Array.isArray(wrapped)) {
      return wrapped;
    }
    return [payload];
  }
  return [];
}

/**
 * Pulls the repository path out of an Angular CLI command line.
 *
 * The CLI is launched through its own `node_modules`, so the path is always present, for example:
 * `"node" "C:\...\projects\web-app\node_modules\...\ng.js" serve`.
 */
export function extractRepoPath(commandLine: string): string | null {
  const match = /"?([A-Za-z]:[\\/][^"]*?)[\\/]node_modules[\\/]/.exec(commandLine);
  return match?.[1] ?? null;
}

/** True when `repoPath` refers to the same directory as `candidate`, ignoring case and slashes. */
export function isSameRepo(repoPath: string | null, candidate: string): boolean {
  if (repoPath === null) {
    return false;
  }
  return normalise(repoPath) === normalise(candidate);
}

function normalise(value: string): string {
  return value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

/**
 * Checks whether something accepts TCP connections on a port.
 *
 * Uses `localhost` rather than `127.0.0.1`: the Angular dev server binds IPv6 only, so probing
 * the IPv4 loopback reports every running server as down. `localhost` resolves to `::1` here.
 */
export function isPortListening(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: 'localhost', port });
    const finish = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
