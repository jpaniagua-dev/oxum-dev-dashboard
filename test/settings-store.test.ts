import { describe, expect, it } from 'vitest';
import { asActions, sanitizeSettings } from '../src/main/store/settings-store.js';

describe('asActions', () => {
  it('gives the one default action when a project declares none', () => {
    /*
     * One, since 5.8.2. The second used to be a `Commit` button running a command called `commit`,
     * which only exists in the author's bash profile: every other machine got a tab reading
     * `command not found`. The Git tab's commit form replaced it, and dropping it from the seeding is
     * what stops a fresh project from shipping a broken button.
     */
    const actions = asActions(undefined);
    expect(actions.map((action) => action.id)).toEqual(['run']);
    // `cmd` and not the default shell: a pty does not resolve the `.cmd` shims, so a bare `npm` fails.
    expect(actions[0]).toMatchObject({ command: 'npm run start', role: 'server', profileId: 'cmd' });
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
    // The migration reads the old `startScript` into the seeded `Run`, which is the whole point: a
    // customised start script must survive the move to actions.
    expect(settings.projects[0]?.actions.map((action) => action.label)).toEqual(['Run']);
  });

  it('reads the tags of a project, and gives none to a configuration written before they existed', () => {
    const settings = sanitizeSettings({
      projects: [
        { id: 'web', label: 'Web', path: 'C:/repos/web', tags: ['Backend', 'backend', ' front '] },
        { id: 'admin', label: 'Admin', path: 'C:/repos/admin-front' },
      ],
    });
    // Deduplicated on the key, trimmed, first spelling kept: the rules of `sanitizeTags`, applied at
    // the boundary rather than trusted from whoever wrote the file.
    expect(settings.projects[0]?.tags).toEqual(['Backend', 'front']);
    // An untagged project is visible under every filter, so an absent list must not become a tag.
    expect(settings.projects[1]?.tags).toEqual([]);
  });

  it('gives a colour to every tag in use, and keeps the ones already chosen', () => {
    const settings = sanitizeSettings({
      projects: [
        { id: 'web', label: 'Web', path: 'C:/repos/web', tags: ['front'] },
        { id: 'api', label: 'Api', path: 'C:/repos/api', tags: ['backend'] },
      ],
      tagColors: { front: 'red', ghost: 'blue', broken: '#ff00bb' },
    });
    // Chosen colours survive, an unknown one is dropped, and the tag that had none is assigned a
    // colour different from the one already taken.
    expect(settings.tagColors.front).toBe('red');
    expect(settings.tagColors.broken).toBeUndefined();
    expect(settings.tagColors.backend).toBeDefined();
    expect(settings.tagColors.backend).not.toBe('red');
    // A colour whose tag has gone is kept: it is what brings the colour back with the tag.
    expect(settings.tagColors.ghost).toBe('blue');
  });

  it('assigns from the SANITISED project list, not from the raw input', () => {
    // The entry has no path, so it is dropped: its tag must not receive a colour on the way out.
    const settings = sanitizeSettings({
      projects: [{ id: 'ghost', label: 'Ghost', tags: ['phantom'] }],
    });
    expect(settings.tagColors).toEqual({});
  });

  it('drops a project entry with no path, since nothing can be inferred for it', () => {
    expect(sanitizeSettings({ projects: [{ id: 'ghost', label: 'Ghost' }] }).projects).toEqual([]);
  });

  it('keeps every tab of the strip as a valid active one', () => {
    /*
     * The other half of the two-gate trap, `asPatch` holding the first. `triage` was missing from
     * `asStrip` while the renderer wrote it and `asPatch` let it through, so every save turned it back
     * into `projects` and the tab was never remembered. A whole tab's persistence failing in silence
     * is what this loop is here to stop happening to the next one.
     */
    for (const tab of ['projects', 'pulls', 'jira', 'git', 'triage', 'worktrees'] as const) {
      expect(sanitizeSettings({ activeStrip: tab }).activeStrip).toBe(tab);
    }
  });

  it('falls back to the projects tab for a strip it does not know', () => {
    expect(sanitizeSettings({ activeStrip: 'mails' }).activeStrip).toBe('projects');
  });

  it('clamps the Worktrees tab height like every other strip height', () => {
    expect(sanitizeSettings({ worktreesHeight: 4 }).worktreesHeight).toBe(90);
    expect(sanitizeSettings({ worktreesHeight: 5000 }).worktreesHeight).toBe(1200);
    expect(sanitizeSettings({}).worktreesHeight).toBe(360);
  });

  it('keeps an empty Claude context root, which means "start in the repository"', () => {
    // Not through `asString`, whose fallback-on-empty behaviour would be wrong here: the empty string is
    // the way back to what every version before 5.2.0 did, so it has to survive a save.
    expect(sanitizeSettings({ claudeContextRoot: '' }).claudeContextRoot).toBe('');
    expect(sanitizeSettings({ claudeContextRoot: '  C:/workspace  ' }).claudeContextRoot).toBe(
      'C:/workspace',
    );
    // Absent is a different statement from empty, and falls back to the workspace default.
    expect(sanitizeSettings({}).claudeContextRoot.length).toBeGreaterThan(0);
  });
});
