import { readFile } from 'node:fs/promises';
import type { AppSettings, ThemeMode, WindowBounds } from '@shared/contracts.js';
import { atomicWriteFile, fileExists } from './atomic-write.js';

/**
 * Defaults chosen so a fresh install is useful with no configuration.
 *
 * The poll intervals differ by cost: git is local and cheap, GitHub is a network round trip, and
 * scanning Claude transcripts touches many files. Using one interval for all three would either
 * make git feel stale or hammer the GitHub API.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  themeMode: 'system',
  gitPollSeconds: 10,
  checksPollSeconds: 60,
  sessionsPollSeconds: 5,
  // Sessions stay open for days. Below this threshold a session counts as active; above it, idle.
  sessionIdleMinutes: 5,
  showTerminal: true,
};

export const DEFAULT_BOUNDS: WindowBounds = { x: -1, y: -1, width: 1180, height: 760 };

/**
 * Reads and writes `settings.json`.
 *
 * Unknown keys are dropped and missing ones fall back to defaults, so a hand-edited or outdated
 * file degrades instead of breaking startup.
 */
export class SettingsStore {
  private cache: AppSettings = { ...DEFAULT_SETTINGS };

  constructor(private readonly filePath: string) {}

  async load(): Promise<AppSettings> {
    if (!fileExists(this.filePath)) {
      return this.cache;
    }
    try {
      const raw: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.cache = sanitizeSettings(raw);
    } catch (error) {
      console.error('[settings] unreadable file, using defaults', error);
    }
    return this.cache;
  }

  get(): AppSettings {
    return this.cache;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.cache = sanitizeSettings({ ...this.cache, ...patch });
    await atomicWriteFile(this.filePath, `${JSON.stringify(this.cache, null, 2)}\n`);
    return this.cache;
  }
}

/**
 * Coerces arbitrary JSON into valid settings.
 *
 * Exported for testing: this is the boundary protecting the app from a corrupted configuration.
 * The clamps also stop a hand-edited interval of `0` from turning a poll into a busy loop.
 */
export function sanitizeSettings(raw: unknown): AppSettings {
  if (typeof raw !== 'object' || raw === null) {
    return { ...DEFAULT_SETTINGS };
  }
  const input = raw as Record<string, unknown>;

  return {
    themeMode: asThemeMode(input.themeMode),
    gitPollSeconds: clamp(asNumber(input.gitPollSeconds, DEFAULT_SETTINGS.gitPollSeconds), 2, 600),
    checksPollSeconds: clamp(
      asNumber(input.checksPollSeconds, DEFAULT_SETTINGS.checksPollSeconds),
      15,
      3600,
    ),
    sessionsPollSeconds: clamp(
      asNumber(input.sessionsPollSeconds, DEFAULT_SETTINGS.sessionsPollSeconds),
      2,
      600,
    ),
    sessionIdleMinutes: clamp(
      asNumber(input.sessionIdleMinutes, DEFAULT_SETTINGS.sessionIdleMinutes),
      1,
      1440,
    ),
    showTerminal: asBoolean(input.showTerminal, DEFAULT_SETTINGS.showTerminal),
  };
}

function asThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : DEFAULT_SETTINGS.themeMode;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
