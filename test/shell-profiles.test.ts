import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectProfiles,
  expandHome,
  mergeProfiles,
  resolveDefaultProfile,
  sanitizeProfile,
} from '../src/main/terminal/shell-profiles.js';
import type { ShellProfile } from '../src/shared/contracts.js';

function profile(overrides: Partial<ShellProfile> = {}): ShellProfile {
  return {
    id: 'custom',
    label: 'Custom',
    file: 'C:/tools/sh.exe',
    args: [],
    cwd: 'C:/',
    detected: false,
    ...overrides,
  };
}

describe('detectProfiles', () => {
  it('only offers shells that exist on this machine', () => {
    // Probing rather than assuming is the point: a menu entry that fails on click is worse than no
    // entry at all.
    const found = detectProfiles();
    expect(found.length).toBeGreaterThan(0);
    for (const entry of found) {
      expect(entry.file.length).toBeGreaterThan(0);
      expect(entry.detected).toBe(true);
    }
  });

  it('starts shells in the home directory', () => {
    // Opening inside the app's install folder would be useless.
    for (const entry of detectProfiles()) {
      expect(entry.cwd).toBe(homedir());
    }
  });

  it('loads the git bash profile so aliases work', () => {
    const bash = detectProfiles().find((entry) => entry.id === 'git-bash');
    if (bash !== undefined) {
      // `-i` is what makes `commit` and the rest of the aliases exist in this shell.
      expect(bash.args).toContain('-i');
    }
  });
});

describe('mergeProfiles', () => {
  it('keeps the detected profiles when the user declared none', () => {
    const detected = [profile({ id: 'git-bash', detected: true })];
    expect(mergeProfiles(detected, [])).toEqual(detected);
  });

  it('lets a user profile override a detected one by id', () => {
    // The reason this exists: a Git Bash installed somewhere unusual can be pointed at without
    // touching the code.
    const merged = mergeProfiles(
      [profile({ id: 'git-bash', file: 'C:/Program Files/Git/bin/bash.exe', detected: true })],
      [profile({ id: 'git-bash', file: 'D:/Git/bin/bash.exe' })],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.file).toBe('D:/Git/bin/bash.exe');
    // No longer a detected entry, since the user is now responsible for the path.
    expect(merged[0]?.detected).toBe(false);
  });

  it('appends genuinely new profiles', () => {
    const merged = mergeProfiles([profile({ id: 'cmd', detected: true })], [profile({ id: 'mien' })]);
    expect(merged.map((entry) => entry.id)).toEqual(['cmd', 'mien']);
  });
});

describe('sanitizeProfile', () => {
  it('rejects entries without an id or a file', () => {
    // These values reach `pty.spawn`, so a malformed entry has to be dropped rather than crash.
    expect(sanitizeProfile(null)).toBeNull();
    expect(sanitizeProfile({})).toBeNull();
    expect(sanitizeProfile({ id: 'x' })).toBeNull();
    expect(sanitizeProfile({ file: 'sh.exe' })).toBeNull();
    expect(sanitizeProfile({ id: '', file: 'sh.exe' })).toBeNull();
  });

  it('falls back to the id when no label is given', () => {
    expect(sanitizeProfile({ id: 'zsh', file: 'zsh.exe' })?.label).toBe('zsh');
  });

  it('drops non-string arguments', () => {
    const parsed = sanitizeProfile({ id: 'x', file: 'x.exe', args: ['-i', 42, null, '-l'] });
    expect(parsed?.args).toEqual(['-i', '-l']);
  });

  it('expands a leading tilde in the starting directory', () => {
    expect(sanitizeProfile({ id: 'x', file: 'x.exe', cwd: '~/oxum' })?.cwd).toBe(
      join(homedir(), '/oxum'),
    );
  });

  it('defaults the starting directory to home', () => {
    expect(sanitizeProfile({ id: 'x', file: 'x.exe' })?.cwd).toBe(homedir());
  });
});

describe('expandHome', () => {
  it('expands only a leading tilde', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/oxum')).toBe(join(homedir(), '/oxum'));
    expect(expandHome('C:/dev/~keep')).toBe('C:/dev/~keep');
  });
});

describe('resolveDefaultProfile', () => {
  const profiles = [profile({ id: 'git-bash' }), profile({ id: 'cmd' })];

  it('picks the preferred profile', () => {
    expect(resolveDefaultProfile(profiles, 'cmd')?.id).toBe('cmd');
  });

  it('falls back to the first when the preference is unknown', () => {
    // A stale `defaultShellProfileId` in settings must not leave the + button dead.
    expect(resolveDefaultProfile(profiles, 'pwsh')?.id).toBe('git-bash');
  });

  it('returns nothing when there is no profile at all', () => {
    expect(resolveDefaultProfile([], 'git-bash')).toBeUndefined();
  });
});
