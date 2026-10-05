import { describe, expect, it } from 'vitest';
import { terminalEnvironment } from '../src/main/terminal/terminal-environment.js';

describe('terminalEnvironment', () => {
  it('advertises truecolor rather than limiting RGB-capable clients to 16 colors', () => {
    expect(terminalEnvironment({})).toEqual({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
    });
  });

  it.each(['0', '1', '2', '3', '', 'false', 'true'])(
    'preserves the explicit FORCE_COLOR value %j',
    (FORCE_COLOR) => {
      expect(terminalEnvironment({ FORCE_COLOR }).FORCE_COLOR).toBe(FORCE_COLOR);
    },
  );

  it.each(['1', '0', 'true'])('does not force colors when NO_COLOR is %j', (NO_COLOR) => {
    const env = terminalEnvironment({ NO_COLOR });
    expect(env.NO_COLOR).toBe(NO_COLOR);
    expect(env.FORCE_COLOR).toBeUndefined();
  });

  it('does not treat an empty NO_COLOR as opting out', () => {
    expect(terminalEnvironment({ NO_COLOR: '' }).FORCE_COLOR).toBe('3');
  });

  it('leaves the precedence of explicitly conflicting preferences to the client', () => {
    expect(terminalEnvironment({ NO_COLOR: '1', FORCE_COLOR: '2' })).toMatchObject({
      NO_COLOR: '1',
      FORCE_COLOR: '2',
    });
  });

  it('preserves existing terminal hints and unrelated environment entries without mutation', () => {
    const inherited = { TERM: 'custom-term', COLORTERM: '24bit', PATH: 'C:/tools' };
    const project = { PROJECT_CAPABILITY: 'fixture', FORCE_COLOR: '2' };
    expect(terminalEnvironment(inherited, project)).toEqual({ ...inherited, ...project });
    expect(inherited).toEqual({ TERM: 'custom-term', COLORTERM: '24bit', PATH: 'C:/tools' });
    expect(project).toEqual({ PROJECT_CAPABILITY: 'fixture', FORCE_COLOR: '2' });
  });

  it('applies project preferences after the inherited environment', () => {
    const env = terminalEnvironment({ FORCE_COLOR: '1' }, { FORCE_COLOR: '3' });
    expect(env.FORCE_COLOR).toBe('3');
    expect(terminalEnvironment({}, { NO_COLOR: '1' }).FORCE_COLOR).toBeUndefined();
  });

  it('omits unset variables rather than handing node-pty a literal undefined string', () => {
    const env = terminalEnvironment(
      { FORCE_COLOR: '1', UNUSED: 'inherited' },
      { FORCE_COLOR: undefined, NO_COLOR: '1', UNUSED: undefined },
    );
    expect(env).not.toHaveProperty('FORCE_COLOR');
    expect(env).not.toHaveProperty('UNUSED');
    expect(env.NO_COLOR).toBe('1');
  });

  it('respects Windows case-insensitive preferences without creating duplicate variables', () => {
    expect(terminalEnvironment({ Force_Color: '1' })).toMatchObject({ FORCE_COLOR: '1' });
    const env = terminalEnvironment({ No_Color: '1' });
    expect(env.NO_COLOR).toBe('1');
    expect(env).not.toHaveProperty('No_Color');
    expect(env).not.toHaveProperty('FORCE_COLOR');
  });

  it('keeps project precedence when inherited color variable names use a different case', () => {
    const env = terminalEnvironment({ FORCE_COLOR: '0', Force_Color: '1' }, { FORCE_COLOR: '3' });
    expect(env.FORCE_COLOR).toBe('3');
    expect(env).not.toHaveProperty('Force_Color');
  });
});
