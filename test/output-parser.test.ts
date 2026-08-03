import { describe, expect, it } from 'vitest';
import {
  countErrors,
  parseOutputChunk,
  readPort,
  stripAnsi,
} from '../src/main/projects/output-parser.js';

/** ESC, built at runtime so the fixtures below read like the bytes a pty really delivers. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('stripAnsi', () => {
  it('removes colour sequences', () => {
    expect(stripAnsi(`${ESC}[32mWatch mode enabled${ESC}[39m`)).toBe('Watch mode enabled');
  });

  it('removes cursor moves and line erases used by spinners', () => {
    expect(stripAnsi(`${ESC}[2K${ESC}[1GBuilding...`)).toBe('Building...');
  });

  it('removes an OSC window-title sequence', () => {
    expect(stripAnsi(`${ESC}]0;npm run start${BEL}ready`)).toBe('ready');
  });

  it('leaves bracketed literals alone', () => {
    // The whole point: a pattern without the escape anchor would delete `[ERROR]` itself and the
    // parser would never see a failure.
    expect(stripAnsi('X [ERROR] something broke')).toBe('X [ERROR] something broke');
    expect(stripAnsi('[1] no escape here')).toBe('[1] no escape here');
  });
});

describe('parseOutputChunk, server projects', () => {
  it('reports serving on the watch-mode banner', () => {
    const chunk = `${ESC}[32m✔${ESC}[39m Application bundle generation complete. Watch mode enabled.`;
    expect(parseOutputChunk(chunk, 'server')).toMatchObject({ phase: 'serving', errorCount: 0 });
  });

  it('reads the announced port, which beats the configured guess', () => {
    const chunk = `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:4201/${ESC}[39m`;
    expect(parseOutputChunk(chunk, 'server').port).toBe(4201);
  });

  it('detects an esbuild error and keeps its message', () => {
    const chunk = [
      `${ESC}[31m✘${ESC}[39m [ERROR] TS2304: Cannot find name 'foo'. [plugin angular-compiler]`,
      '',
      '    src/app/thing.ts:12:5:',
    ].join('\n');

    const parsed = parseOutputChunk(chunk, 'server');
    expect(parsed.phase).toBe('build-error');
    expect(parsed.errorSummary).toContain("Cannot find name 'foo'");
  });

  it('detects a lint failure separately from a build failure', () => {
    // A lint failure aborts before the server starts, so calling it a build error would point at
    // the wrong problem.
    const chunk = `${ESC}[31m✖${ESC}[39m 3 problems (2 errors, 1 warning)`;
    expect(parseOutputChunk(chunk, 'server').phase).toBe('lint-error');
  });

  it('reports linting while the lint step runs', () => {
    expect(parseOutputChunk('> ng lint\n', 'server').phase).toBe('linting');
  });

  it('reports building during the bundle step', () => {
    expect(parseOutputChunk('Building...', 'server').phase).toBe('building');
  });

  it('clears the error state when a rebuild succeeds', () => {
    const failed = parseOutputChunk('X [ERROR] broken', 'server');
    const recovered = parseOutputChunk('Application bundle generation complete.', 'server');
    expect(failed.phase).toBe('build-error');
    expect(recovered.phase).toBe('serving');
    expect(recovered.errorCount).toBe(0);
  });

  it('stays silent on noise', () => {
    expect(parseOutputChunk('npm warn deprecated something@1.0.0\n', 'server')).toMatchObject({
      phase: null,
      port: null,
    });
    expect(parseOutputChunk('', 'server').phase).toBeNull();
  });
});

describe('parseOutputChunk, watch projects', () => {
  it('reports watching rather than serving, since there is no server', () => {
    // `design-system` runs `ng build --watch`: a healthy resting state that never opens a port, so
    // labelling it "serving" would promise something observable that does not exist.
    const chunk = 'Application bundle generation complete. Watch mode enabled.';
    expect(parseOutputChunk(chunk, 'watch').phase).toBe('watching');
  });

  it('still reports build errors', () => {
    expect(parseOutputChunk('✘ [ERROR] boom', 'watch').phase).toBe('build-error');
  });
});

describe('readPort', () => {
  it('reads localhost, IPv4 and IPv6 forms', () => {
    expect(readPort('http://localhost:4200/')).toBe(4200);
    expect(readPort('http://127.0.0.1:4300/')).toBe(4300);
    expect(readPort('http://[::1]:5173/')).toBe(5173);
  });

  it('returns null when there is no url', () => {
    expect(readPort('nothing here')).toBeNull();
  });
});

describe('countErrors', () => {
  it('prefers an explicit total', () => {
    expect(countErrors('3 problems (2 errors, 1 warning)')).toBe(2);
  });

  it('falls back to counting markers', () => {
    expect(countErrors('[ERROR] a\n[ERROR] b')).toBe(2);
  });

  it('reports one when a failure has no count at all', () => {
    expect(countErrors('something went wrong')).toBe(1);
  });
});
