import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ShellProfile } from '@shared/contracts.js';

/**
 * Shell profiles, the way Windows Terminal does it: a list of named launchers the user can extend.
 *
 * Candidates are probed on disk rather than assumed, so the menu only ever offers shells that
 * actually exist. On this machine that means Git Bash, PowerShell 5.1, cmd and WSL are offered while
 * PowerShell 7 is not, instead of showing a profile that fails on click.
 */
interface Candidate {
  readonly id: string;
  readonly label: string;
  /** Absolute paths to try, in order of preference. */
  readonly files: readonly string[];
  readonly args: readonly string[];
}

function candidates(): Candidate[] {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';

  return [
    {
      id: 'git-bash',
      label: 'Git Bash',
      files: [join(programFiles, 'Git', 'bin', 'bash.exe'), join(programFilesX86, 'Git', 'bin', 'bash.exe')],
      // `-i` so the profile and its aliases are loaded: this is the shell that has to feel like the
      // one in a normal terminal, aliases included.
      args: ['-i'],
    },
    {
      id: 'powershell',
      label: 'PowerShell',
      files: [join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
      args: ['-NoLogo'],
    },
    {
      id: 'pwsh',
      label: 'PowerShell 7',
      files: [join(programFiles, 'PowerShell', '7', 'pwsh.exe')],
      args: ['-NoLogo'],
    },
    {
      id: 'cmd',
      label: 'cmd',
      files: [join(systemRoot, 'System32', 'cmd.exe')],
      args: [],
    },
    {
      id: 'wsl',
      label: 'WSL',
      files: [join(systemRoot, 'System32', 'wsl.exe')],
      args: [],
    },
  ];
}

/** Profiles whose executable is present on this machine. */
export function detectProfiles(): ShellProfile[] {
  const found: ShellProfile[] = [];

  for (const candidate of candidates()) {
    const file = candidate.files.find((path) => existsSync(path));
    if (file === undefined) {
      continue;
    }
    found.push({
      id: candidate.id,
      label: candidate.label,
      file,
      args: [...candidate.args],
      // Home rather than the app's own directory: a terminal that opens inside the dashboard's
      // install folder is useless.
      cwd: homedir(),
      detected: true,
    });
  }

  return found;
}

/**
 * Merges user-declared profiles over the detected ones.
 *
 * A user profile sharing an id overrides the detected entry, which is how a Git Bash installed
 * somewhere unusual gets pointed at without editing code. Genuinely new ids are appended.
 *
 * Exported for testing.
 */
export function mergeProfiles(
  detected: readonly ShellProfile[],
  custom: readonly ShellProfile[],
): ShellProfile[] {
  const byId = new Map<string, ShellProfile>();
  for (const profile of detected) {
    byId.set(profile.id, profile);
  }
  for (const profile of custom) {
    const base = byId.get(profile.id);
    byId.set(profile.id, {
      ...base,
      ...profile,
      // A hand-written profile is never "detected", even when it replaces one that was.
      detected: false,
    });
  }
  return [...byId.values()];
}

/**
 * Validates a user-supplied profile.
 *
 * Exported for testing, and strict on purpose: these values reach `pty.spawn`, and a malformed entry
 * in a hand-edited `settings.json` must be dropped rather than crash the terminal.
 */
export function sanitizeProfile(raw: unknown): ShellProfile | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const input = raw as Record<string, unknown>;
  if (typeof input.id !== 'string' || input.id.length === 0) {
    return null;
  }
  if (typeof input.file !== 'string' || input.file.length === 0) {
    return null;
  }

  return {
    id: input.id,
    label: typeof input.label === 'string' && input.label.length > 0 ? input.label : input.id,
    file: input.file,
    args: Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === 'string') : [],
    cwd: typeof input.cwd === 'string' && input.cwd.length > 0 ? expandHome(input.cwd) : homedir(),
    detected: false,
  };
}

/** Expands a leading `~`, since that is what anyone hand-writing a path will type. */
export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\')
    ? join(homedir(), path.slice(1))
    : path;
}

/** Picks the profile a bare "new tab" click should use. */
export function resolveDefaultProfile(
  profiles: readonly ShellProfile[],
  preferredId: string,
): ShellProfile | undefined {
  return profiles.find((profile) => profile.id === preferredId) ?? profiles[0];
}

/**
 * Picks a profile whose shell can expand a `.bashrc` alias.
 *
 * The Jira tab runs `dev <TICKET>`, which is an **alias** and therefore exists in exactly one place:
 * an interactive bash. Falling back to the default profile would not degrade gracefully, it would
 * fail with `dev: command not found` in a tab that looks like it worked — so no bash means no command
 * at all, and a message saying which shell is missing.
 *
 * The preferred id is honoured when it happens to be a bash, so a user who pointed `git-bash` at a
 * custom install keeps it. Pure and exported for testing: the branch that matters is the one where
 * the default profile is PowerShell, which is a perfectly ordinary configuration.
 */
export function resolveBashProfile(
  profiles: readonly ShellProfile[],
  preferredId: string,
): ShellProfile | undefined {
  const isBash = (profile: ShellProfile): boolean =>
    /(^|[\\/])(bash|sh|zsh)(\.exe)?$/i.test(profile.file);
  const preferred = profiles.find((profile) => profile.id === preferredId);
  return preferred !== undefined && isBash(preferred) ? preferred : profiles.find(isBash);
}
