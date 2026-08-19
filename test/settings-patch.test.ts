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
      gitHeight: 460,
      activeStrip: 'jira',
    });

    expect(patch).toEqual({
      projectsHeight: 250,
      pullsHeight: 360,
      jiraHeight: 400,
      gitHeight: 460,
      activeStrip: 'jira',
    });
  });

  it('accepts every tab of the strip as the active one', () => {
    /*
     * Both gates, in one place. `asPatch` accepted `triage` while `asStrip` in the settings store did
     * not, so `update()` sanitised the value back to `projects` on its way to disk: the Triage tab was
     * simply never remembered, and there was nothing to see. Every tab is checked here so the next one
     * added cannot repeat it, and `settings-store.test.ts` holds the other half.
     */
    for (const tab of ['projects', 'pulls', 'jira', 'git', 'triage', 'worktrees']) {
      expect(asPatch({ activeStrip: tab })).toEqual({ activeStrip: tab });
    }
  });

  it('accepts the Git tab as an active strip', () => {
    // A fourth tab is one more branch in a union that is checked by hand in three places: here, the
    // settings store's `asStrip`, and the renderer's height lookup. Missing it here would silently
    // send the user back to the projects tab at every restart.
    expect(asPatch({ activeStrip: 'git', gitHeight: 500, gitListWidth: 520 })).toEqual({
      activeStrip: 'git',
      gitHeight: 500,
      gitListWidth: 520,
    });
  });

  it('lets through the keys the settings window writes', () => {
    expect(
      asPatch({
        terminalFontSize: 16,
        uiFontSize: 14,
        defaultShellProfileId: 'git-bash',
        gitPollSeconds: 10,
        checksPollSeconds: 60,
      }),
    ).toEqual({
      terminalFontSize: 16,
      uiFontSize: 14,
      defaultShellProfileId: 'git-bash',
      gitPollSeconds: 10,
      checksPollSeconds: 60,
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
    expect(asPatch({ projectsHeight: '250', stripCollapsed: 'oui', activeStrip: 'mails' })).toEqual({});
  });

  it('survives a non-object payload', () => {
    expect(asPatch(null)).toEqual({});
    expect(asPatch('projectsHeight')).toEqual({});
    expect(asPatch(undefined)).toEqual({});
  });

  it('keeps an empty model name, which means "use the Claude Code default"', () => {
    // `asString`-style fallback-on-empty would be wrong here: empty is a meaningful value, and it is
    // the only way to unset a model that was pinned.
    expect(asPatch({ claudeWorkModel: '' })).toEqual({ claudeWorkModel: '' });
  });
});

describe('LOCAL_ONLY_KEYS', () => {
  it('covers every geometry key the dashboard writes about itself', () => {
    // A key missing here gets echoed back and rebuilds the table mid-drag; a key wrongly added stops
    // the settings window from reaching the dashboard. Both are silent, hence the list.
    expect([...LOCAL_ONLY_KEYS].sort()).toEqual([
      'activeStrip',
      'gitHeight',
      'gitListWidth',
      'jiraHeight',
      'projectsHeight',
      'pullScope',
      'pullsHeight',
      // Not a geometry, but local for the same reason: it is written by the dashboard the moment the
      // servers window opens, and an echo would reload settings in the middle of that gesture.
      'serversDetached',
      'stripCollapsed',
      'triageHeight',
      'worktreesHeight',
    ]);
  });

  it('lets the dashboard remember that the servers were detached', () => {
    // The whole point of persisting it: a window parked on a second monitor that has to be reopened at
    // every launch is a window you stop using. Same silent-drop trap as the heights above.
    expect(asPatch({ serversDetached: true })).toEqual({ serversDetached: true });
    expect(asPatch({ serversDetached: false })).toEqual({ serversDetached: false });
    expect(asPatch({ serversDetached: 'yes' })).toEqual({});
  });

  it('lets the dashboard persist the Triage tab height', () => {
    // Same trap as `pullsHeight` and `jiraHeight` before it: a height missing from `asPatch` is
    // dropped in total silence, and the tab reopens at the default on every launch.
    expect(asPatch({ triageHeight: 512 })).toEqual({ triageHeight: 512 });
  });

  it('lets the dashboard persist the Worktrees tab height', () => {
    expect(asPatch({ worktreesHeight: 380 })).toEqual({ worktreesHeight: 380 });
  });

  it('lets the dashboard persist the pull request scope', () => {
    // Written from the dashboard on every sub-tab click, so it belongs to the local-only set for the
    // same reason `activeStrip` does: echoed back, it would rebuild the list under the click.
    expect(asPatch({ pullScope: 'all' })).toEqual({ pullScope: 'all' });
    expect(asPatch({ pullScope: 'mine' })).toEqual({ pullScope: 'mine' });
    expect(asPatch({ pullScope: 'theirs' })).toEqual({});
  });

  it('lets the dashboard persist the folded strip', () => {
    expect(asPatch({ stripCollapsed: true })).toEqual({ stripCollapsed: true });
    expect(asPatch({ stripCollapsed: false })).toEqual({ stripCollapsed: false });
    expect(asPatch({ stripCollapsed: 'yes' })).toEqual({});
  });

  it('carries the three model names, which the settings window is the only writer of', () => {
    // The failure this whole file exists for: a key missing here is accepted by the form, saved, and
    // silently discarded on the way to disk. Three fields is three chances to forget one.
    expect(
      asPatch({
        claudeAnalysisModel: 'haiku',
        claudeWorkModel: 'opus',
        claudeCommitModel: 'sonnet',
      }),
    ).toEqual({
      claudeAnalysisModel: 'haiku',
      claudeWorkModel: 'opus',
      claudeCommitModel: 'sonnet',
    });
  });

  it('lets an empty model through, empty being how the default is spelled', () => {
    // Not dropped as falsy: clearing a pinned model has to reach the store, or the field would be the
    // one setting in this app that can be set and never unset.
    expect(asPatch({ claudeWorkModel: '' })).toEqual({ claudeWorkModel: '' });
  });

  it('leaves the validation of a model name to the store, and passes the value on as typed', () => {
    // Two gates answering "is this a model name" would drift, and the one that silently dropped the
    // value would be this one, where nothing can report it. The store normalises; this only filters
    // by type.
    expect(asPatch({ claudeCommitModel: 'sonnet 4' })).toEqual({ claudeCommitModel: 'sonnet 4' });
    expect(asPatch({ claudeCommitModel: 4 })).toEqual({});
  });

  it('does not cover anything the settings window owns', () => {
    // `uiFontSize` in particular: it is born in the settings window and its whole purpose is to reach
    // the dashboard, so listing it as local-only would leave the app's text size stuck.
    for (const key of [
      'terminalFontSize',
      'uiFontSize',
      'defaultShellProfileId',
      'projects',
      'claudeAnalysisModel',
      'claudeWorkModel',
      'claudeCommitModel',
    ]) {
      expect(LOCAL_ONLY_KEYS.has(key)).toBe(false);
    }
  });
});
