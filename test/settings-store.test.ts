import { describe, expect, it } from 'vitest';
import { asActions, sanitizeSettings } from '../src/main/store/settings-store.js';

describe('asActions', () => {
  it('gives the default two actions when a project declares none', () => {
    const actions = asActions(undefined);
    expect(actions.map((action) => action.id)).toEqual(['run', 'commit']);
    expect(actions[0]).toMatchObject({ command: 'npm run start', role: 'server', profileId: 'cmd' });
    // Git Bash, because `commit` is a bash alias and nothing else expands it.
    expect(actions[1]).toMatchObject({ command: 'commit', role: 'task', profileId: 'git-bash' });
  });

  it('migrates a pre-actions project, keeping a customised start script', () => {
    // The shape of `settings.json` before actions existed. Losing the script here would silently
    // change what Run does on a project the user had already tuned.
    expect(asActions(undefined, 'dev')[0]?.command).toBe('npm run dev');
  });

  it('keeps only one server action, demoting the extras', () => {
    // A row holds one server state. Demoting rather than dropping keeps the command the user wrote.
    const actions = asActions([
      { id: 'a', label: 'A', command: 'npm run start', role: 'server' },
      { id: 'b', label: 'B', command: 'npm run start:other', role: 'server' },
    ]);
    expect(actions.map((action) => action.role)).toEqual(['server', 'task']);
    expect(actions[1]?.command).toBe('npm run start:other');
  });

  it('drops an action with no command and falls back rather than leaving a row empty', () => {
    // A button that runs nothing is worse than no button; an empty list reads as a broken dashboard.
    expect(asActions([{ label: 'Vide', command: '   ', role: 'task' }]).map((a) => a.id)).toEqual([
      'run',
      'commit',
    ]);
  });

  it('makes ids unique so two actions cannot share a terminal tab', () => {
    const actions = asActions([
      { id: 'run', label: 'Run', command: 'npm run start', role: 'server' },
      { id: 'run', label: 'Run bis', command: 'npm run start:bis', role: 'task' },
    ]);
    expect(new Set(actions.map((action) => action.id)).size).toBe(2);
  });

  it('treats an unknown role as a task', () => {
    expect(asActions([{ label: 'X', command: 'x', role: 'nonsense' }])[0]?.role).toBe('task');
  });
});

describe('sanitizeSettings: terminal font size', () => {
  it('defaults to a readable size when absent', () => {
    expect(sanitizeSettings({}).terminalFontSize).toBe(14);
  });

  it('clamps a value that would make the terminal unusable', () => {
    // A hand-edited `2` has to be refused: the settings window is the thing you would no longer be
    // able to read in order to fix it.
    expect(sanitizeSettings({ terminalFontSize: 2 }).terminalFontSize).toBe(9);
    expect(sanitizeSettings({ terminalFontSize: 400 }).terminalFontSize).toBe(28);
  });

  it('rounds a fractional size, since xterm works in whole pixels', () => {
    expect(sanitizeSettings({ terminalFontSize: 15.6 }).terminalFontSize).toBe(16);
  });

  it('falls back on a value that is not a number at all', () => {
    expect(sanitizeSettings({ terminalFontSize: 'grand' }).terminalFontSize).toBe(14);
  });
});

describe('sanitizeSettings', () => {
  it('migrates a whole stored project list to actions', () => {
    const settings = sanitizeSettings({
      projects: [{ id: 'web', label: 'Web', path: 'C:/repos/web', startScript: 'start' }],
    });
    expect(settings.projects[0]?.actions.map((action) => action.label)).toEqual(['Run', 'Commit']);
  });

  it('drops a project entry with no path, since nothing can be inferred for it', () => {
    expect(sanitizeSettings({ projects: [{ id: 'ghost', label: 'Ghost' }] }).projects).toEqual([]);
  });
});
