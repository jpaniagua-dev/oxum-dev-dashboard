import { describe, expect, it } from 'vitest';
import { parseWindowsBuild, terminalCompat } from '../src/main/terminal/windows-pty.js';

describe('parseWindowsBuild', () => {
  it('reads the build out of an os.release() string', () => {
    expect(parseWindowsBuild('10.0.26200')).toBe(26200);
  });

  it('ignores anything trailing the build', () => {
    expect(parseWindowsBuild('10.0.19045.5011')).toBe(19045);
  });

  it('returns null on a shape that is not a Windows release', () => {
    expect(parseWindowsBuild('')).toBeNull();
    expect(parseWindowsBuild('unknown')).toBeNull();
  });

  it('rejects a zero build, which a Linux release parses to by accident', () => {
    expect(parseWindowsBuild('6.11.0-24-generic')).toBeNull();
  });
});

describe('terminalCompat', () => {
  it('reports ConPTY on a modern Windows', () => {
    expect(terminalCompat('win32', '10.0.26200')).toEqual({
      backend: 'conpty',
      buildNumber: 26200,
    });
  });

  it('reports winpty below the build node-pty switches at', () => {
    // Wrong here means xterm applies the workarounds of the other era of ConPTY, which is worse than
    // applying none: it would disable a reflow the backend is not doing itself.
    expect(terminalCompat('win32', '10.0.17763')).toEqual({
      backend: 'winpty',
      buildNumber: 17763,
    });
  });

  it('is null off Windows, where xterm defaults are right', () => {
    expect(terminalCompat('linux', '6.11.0')).toBeNull();
    expect(terminalCompat('darwin', '24.1.0')).toBeNull();
  });

  it('is null when the release cannot be parsed rather than guessing a build', () => {
    expect(terminalCompat('win32', 'unknown')).toBeNull();
  });
});
