import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { ClaudeSession, SessionStatus } from '@shared/contracts.js';

const execFileAsync = promisify(execFile);

/** Root of Claude Code's per-project transcripts. */
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

/** Transcripts untouched for longer than this are not even read: they cannot be active. */
const MAX_AGE_HOURS = 24;

/** Below this, a session is treated as mid-turn rather than waiting. */
const WORKING_WINDOW_SECONDS = 12;

/**
 * Reports the state of local Claude Code sessions.
 *
 * Reads the append-only transcripts under `~/.claude/projects/` rather than relying on hooks: a
 * hook only fires after the dashboard is running, so sessions already open would be invisible.
 * Hooks are the right channel for zero-latency updates, but this scan is what makes a cold start
 * truthful.
 *
 * **Only metadata is read.** Each line is parsed for `type`, `timestamp`, `cwd` and `gitBranch`;
 * message bodies are never retained, so no conversation content enters the dashboard.
 */
export async function readSessions(idleMinutes: number): Promise<ClaudeSession[]> {
  const [files, livePids] = await Promise.all([listRecentTranscripts(), countLiveClaudeProcesses()]);

  const sessions = await Promise.all(
    files.map((file) => readSession(file, idleMinutes, livePids > 0)),
  );

  return sessions
    .filter((session): session is ClaudeSession => session !== null)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

interface TranscriptFile {
  readonly path: string;
  readonly project: string;
  readonly id: string;
  readonly modifiedAt: Date;
}

async function listRecentTranscripts(): Promise<TranscriptFile[]> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(PROJECTS_ROOT);
  } catch {
    return [];
  }

  const cutoff = Date.now() - MAX_AGE_HOURS * 3600_000;
  const found: TranscriptFile[] = [];

  for (const project of projectDirs) {
    const dir = join(PROJECTS_ROOT, project);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (!name.endsWith('.jsonl')) {
        continue;
      }
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (info.mtimeMs >= cutoff) {
          found.push({
            path,
            project,
            id: name.replace(/\.jsonl$/, ''),
            modifiedAt: info.mtime,
          });
        }
      } catch {
        // Transcript rotated away mid-scan; skip it.
      }
    }
  }

  return found;
}

/**
 * Reads one transcript's metadata.
 *
 * The whole file is streamed line by line rather than loaded: an active session's transcript
 * reaches tens of megabytes, and reading it into memory every few seconds would be wasteful.
 */
async function readSession(
  file: TranscriptFile,
  idleMinutes: number,
  anyProcessAlive: boolean,
): Promise<ClaudeSession | null> {
  let entries = 0;
  let lastType: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;

  try {
    const stream = createReadStream(file.path, { encoding: 'utf8' });
    const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    for await (const line of reader) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        continue;
      }
      const record = parsed as Record<string, unknown>;
      entries += 1;
      if (typeof record.type === 'string') {
        lastType = record.type;
      }
      // Keep the latest known values: cwd and branch can change during a session.
      if (typeof record.cwd === 'string' && record.cwd.length > 0) {
        cwd = record.cwd;
      }
      if (typeof record.gitBranch === 'string' && record.gitBranch.length > 0) {
        gitBranch = record.gitBranch;
      }
    }
  } catch {
    return null;
  }

  if (entries === 0) {
    return null;
  }

  const idleMs = Date.now() - file.modifiedAt.getTime();
  return {
    id: file.id,
    shortId: file.id.slice(0, 8),
    cwd,
    gitBranch,
    project: file.project,
    status: deriveStatus({
      idleMs,
      lastType,
      idleMinutes,
      anyProcessAlive,
    }),
    lastActivityAt: file.modifiedAt.toISOString(),
    idleMinutes: Math.round((idleMs / 60_000) * 10) / 10,
    entries,
  };
}

/**
 * Decides what a session is doing.
 *
 * `idle` is not cosmetic: sessions are routinely left open for days, and without this state a
 * dashboard would permanently claim several sessions are active. A transcript that ends on a `user`
 * entry means the assistant is mid-turn; ending on `assistant` means it is waiting for input.
 *
 * Exported for testing.
 */
export function deriveStatus(input: {
  idleMs: number;
  lastType: string | null;
  idleMinutes: number;
  anyProcessAlive: boolean;
}): SessionStatus {
  const idleThresholdMs = input.idleMinutes * 60_000;

  if (input.idleMs > idleThresholdMs) {
    // No recent writes: either a stale session whose process is still up, or one that is gone.
    return input.anyProcessAlive ? 'idle' : 'ended';
  }
  if (input.idleMs <= WORKING_WINDOW_SECONDS * 1000 && input.lastType === 'user') {
    return 'working';
  }
  return 'waiting';
}

/** How many `claude` processes are alive, used to tell a stale session from a closed one. */
async function countLiveClaudeProcesses(): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process claude -ErrorAction SilentlyContinue | Measure-Object).Count',
      ],
      { timeout: 10_000, windowsHide: true },
    );
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}
