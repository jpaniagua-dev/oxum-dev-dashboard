import { describe, expect, it } from 'vitest';
import {
  extractRepoPath,
  isSameRepo,
  parseListeningServers,
} from '../src/main/projects/port-probe.js';

/** A real command line captured from a running `ng serve`, backslashes and all. */
const REAL_CMD =
  '"node"   "C:\\Users\\julpan\\oxum\\projects\\web-app\\node_modules\\.bin\\\\..\\@angular\\cli\\bin\\ng.js" serve';

const REAL_CMD_WORKTREE =
  '"node"   "C:\\Users\\julpan\\oxum\\projects\\web-app-tec1455\\node_modules\\.bin\\\\..\\@angular\\cli\\bin\\ng.js" serve --port 4202';

describe('extractRepoPath', () => {
  it('pulls the repository out of an Angular CLI command line', () => {
    expect(extractRepoPath(REAL_CMD)).toBe('C:\\Users\\julpan\\oxum\\projects\\web-app');
  });

  it('distinguishes a worktree from the main checkout', () => {
    // The two differ only by a suffix, and they run on different ports. Keying identity on the
    // port instead of the path would merge them.
    expect(extractRepoPath(REAL_CMD_WORKTREE)).toBe(
      'C:\\Users\\julpan\\oxum\\projects\\web-app-tec1455',
    );
  });

  it('returns null when there is no node_modules segment', () => {
    expect(extractRepoPath('"node" "server.js"')).toBeNull();
    expect(extractRepoPath('')).toBeNull();
  });

  it('handles forward slashes', () => {
    expect(extractRepoPath('node C:/dev/my-app/node_modules/x/bin.js serve')).toBe(
      'C:/dev/my-app',
    );
  });
});

describe('isSameRepo', () => {
  it('ignores slash direction, trailing slashes and case', () => {
    expect(isSameRepo('C:\\dev\\app', 'c:/dev/app')).toBe(true);
    expect(isSameRepo('C:/dev/app/', 'C:\\dev\\app')).toBe(true);
  });

  it('does not treat a prefix as a match', () => {
    // `web-app-tec1455` starts with `web-app`; a naive startsWith would
    // attribute the worktree's server to the main project.
    expect(
      isSameRepo(
        'C:\\Users\\julpan\\oxum\\projects\\web-app-tec1455',
        'C:\\Users\\julpan\\oxum\\projects\\web-app',
      ),
    ).toBe(false);
  });

  it('is false for an unknown path', () => {
    expect(isSameRepo(null, 'C:\\dev\\app')).toBe(false);
  });
});

describe('parseListeningServers', () => {
  it('reads the Windows PowerShell 5.1 array envelope', () => {
    // 5.1 has no `-AsArray`, and the `,@(...)` idiom makes it emit `{value, Count}` rather than a
    // bare array. Missing this shape made the probe report zero servers while two were listening.
    const stdout = JSON.stringify({
      value: [
        { port: 4200, pid: 34632, cmd: REAL_CMD },
        { port: 4202, pid: 19544, cmd: REAL_CMD_WORKTREE },
      ],
      Count: 2,
    });

    const servers = parseListeningServers(stdout);
    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({ port: 4200, pid: 34632 });
    expect(servers[0]?.repoPath).toBe('C:\\Users\\julpan\\oxum\\projects\\web-app');
  });

  it('reads a bare array', () => {
    const stdout = JSON.stringify([{ port: 4201, pid: 10, cmd: REAL_CMD }]);
    expect(parseListeningServers(stdout)).toHaveLength(1);
  });

  it('reads a lone object', () => {
    const stdout = JSON.stringify({ port: 4201, pid: 10, cmd: REAL_CMD });
    expect(parseListeningServers(stdout)).toHaveLength(1);
  });

  it('returns nothing for the empty result, blank output or junk', () => {
    expect(parseListeningServers('[]')).toEqual([]);
    expect(parseListeningServers('   ')).toEqual([]);
    expect(parseListeningServers('not json')).toEqual([]);
  });

  it('skips entries with a missing or non-numeric port', () => {
    const stdout = JSON.stringify([
      { port: 4200, pid: 1, cmd: REAL_CMD },
      { pid: 2, cmd: REAL_CMD },
      { port: 'abc', pid: 3, cmd: REAL_CMD },
    ]);
    expect(parseListeningServers(stdout)).toHaveLength(1);
  });

  it('keeps a server whose command line is unrecognisable', () => {
    // Still worth showing: something owns the port, even if we cannot attribute it to a repo.
    const servers = parseListeningServers(
      JSON.stringify([{ port: 3000, pid: 7, cmd: 'node server.js' }]),
    );
    expect(servers).toHaveLength(1);
    expect(servers[0]?.repoPath).toBeNull();
  });
});
