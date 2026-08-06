import { describe, expect, it } from 'vitest';
import { LOCAL_ONLY_KEYS, asPatch } from '../src/main/store/settings-patch.js';

describe('asPatch', () => {
  it('lets through every key the dashboard actually writes', () => {
    /*
     * The regression this file exists for. `renderer/main.ts` has always sent `pullsHeight`,
     * `jiraHeight` and `activeStrip`, but they were missing from the whitelist, so they were dropped
     * on every write from the V2 onwards: the strip heights and the remembered tab never survived a
     * restart, and nothing said so.
     */
    const patch = asPatch({
      projectsHeight: 250,
      pullsHeight: 360,
      jiraHeight: 400,
      activeStrip: 'jira',
      notesWidth: 340,
      notesOpen: true,
    });

    expect(patch).toEqual({
      projectsHeight: 250,
      pullsHeight: 360,
      jiraHeight: 400,
      activeStrip: 'jira',
      notesWidth: 340,
      notesOpen: true,
    });
  });

  it('lets through the keys the settings window writes', () => {
    expect(
      asPatch({
        terminalFontSize: 16,
        defaultShellProfileId: 'git-bash',
        gitPollSeconds: 10,
        checksPollSeconds: 60,
        notesFolder: 'C:\\notes',
      }),
    ).toEqual({
      terminalFontSize: 16,
      defaultShellProfileId: 'git-bash',
      gitPollSeconds: 10,
      checksPollSeconds: 60,
      notesFolder: 'C:\\notes',
    });
  });

  it('refuses the collections that have their own sanitising handlers', () => {
    // `projects` and `shellProfiles` go through ProjectsSave / ProfilesSave, which rebuild dependent
    // state. Slipping them in here would change the list without rebuilding the monitors.
    expect(asPatch({ projects: [{ path: 'C:\\x' }], shellProfiles: [{ id: 'x' }], jira: {} })).toEqual(
      {},
    );
  });

  it('drops values of the wrong type rather than trusting them', () => {
    expect(asPatch({ projectsHeight: '250', notesOpen: 'oui', activeStrip: 'mails' })).toEqual({});
  });

  it('survives a non-object payload', () => {
    expect(asPatch(null)).toEqual({});
    expect(asPatch('projectsHeight')).toEqual({});
    expect(asPatch(undefined)).toEqual({});
  });

  it('keeps an empty notesFolder, which means "use the default folder"', () => {
    // `asString`-style fallback-on-empty would be wrong here: empty is a meaningful value.
    expect(asPatch({ notesFolder: '' })).toEqual({ notesFolder: '' });
  });
});

describe('LOCAL_ONLY_KEYS', () => {
  it('covers every geometry key the dashboard writes about itself', () => {
    // A key missing here gets echoed back and rebuilds the table mid-drag; a key wrongly added stops
    // the settings window from reaching the dashboard. Both are silent, hence the list.
    expect([...LOCAL_ONLY_KEYS].sort()).toEqual([
      'activeStrip',
      'jiraHeight',
      'notesOpen',
      'notesWidth',
      'projectsHeight',
      'pullsHeight',
    ]);
  });

  it('does not cover anything the settings window owns', () => {
    for (const key of ['terminalFontSize', 'notesFolder', 'defaultShellProfileId', 'projects']) {
      expect(LOCAL_ONLY_KEYS.has(key)).toBe(false);
    }
  });
});
