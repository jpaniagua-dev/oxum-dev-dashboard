import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../src/shared/contracts.js';
import { sanitizeSettings } from '../src/main/store/settings-store.js';
import { expandHome, homeRelative, planImport, toTeamConfig } from '../src/shared/team-config.js';

const HOME = 'C:\\Users\\dev';

const project = (id: string, path: string): ProjectConfig => ({
  id,
  label: id,
  path,
  actions: [],
  kind: null,
  expectedPort: null,
  enabled: true,
  followPulls: true,
  tags: ['front'],
});

describe('paths under the home folder', () => {
  it('writes them as ~/ and reads them back on another machine', () => {
    expect(homeRelative('C:\\Users\\dev\\code\\web-app', HOME)).toBe('~/code/web-app');
    expect(homeRelative('D:\\shared\\repo', HOME)).toBe('D:/shared/repo');
    expect(expandHome('~/code/web-app', 'C:\\Users\\other')).toBe('C:/Users/other/code/web-app');
    expect(expandHome('D:/shared/repo', 'C:\\Users\\other')).toBe('D:/shared/repo');
  });
});

describe('toTeamConfig', () => {
  it('carries the team settings and nothing personal', () => {
    const settings = sanitizeSettings({
      projects: [project('web-app', 'C:\\Users\\dev\\code\\web-app')],
      jira: { siteUrl: 'https://example.atlassian.net', email: 'dev@example.com', projectKeys: ['PROJ'] },
      handoffAsk: '/my-skill',
      projectsRoot: 'C:\\Users\\dev\\code',
    });
    const config = toTeamConfig(settings, HOME, new Date('2026-10-02T00:00:00Z'));
    expect(config.projects[0]?.path).toBe('~/code/web-app');
    expect(config.projects[0]).not.toHaveProperty('enabled');
    expect(config.projectsRoot).toBe('~/code');
    expect(config.jira).toEqual({ siteUrl: 'https://example.atlassian.net', projectKeys: ['PROJ'] });
    const text = JSON.stringify(config);
    expect(text).not.toContain('dev@example.com');
    expect(text).not.toContain('my-skill');
  });
});

describe('planImport', () => {
  const exported = toTeamConfig(
    sanitizeSettings({
      projects: [project('web-app', 'C:\\Users\\dev\\code\\web-app'), project('admin', 'C:\\Users\\dev\\code\\admin')],
      jira: { siteUrl: 'https://example.atlassian.net', email: 'a@example.com', projectKeys: ['PROJ'] },
    }),
    HOME,
  );

  it('adds what exists here, lists what does not, and keeps the reader own projects and email', () => {
    const current = sanitizeSettings({
      projects: [project('admin', 'C:/Users/other/code/admin')],
      jira: { siteUrl: '', email: 'me@example.com', projectKeys: [] },
    });
    const exists = (path: string): boolean => path === 'C:/Users/other/code/web-app';
    const plan = planImport(JSON.parse(JSON.stringify(exported)), current, 'C:\\Users\\other', exists);
    if (typeof plan === 'string') {
      throw new Error(plan);
    }
    expect(plan.added).toEqual(['web-app']);
    expect(plan.skipped).toEqual(['admin']);
    expect(plan.missing).toEqual([]);
    expect(plan.patch.projects?.map((entry) => entry.path)).toEqual([
      'C:/Users/other/code/admin',
      'C:/Users/other/code/web-app',
    ]);
    expect(plan.patch.jira).toEqual({ siteUrl: 'https://example.atlassian.net', email: 'me@example.com', projectKeys: ['PROJ'] });
  });

  it('names a project whose folder is missing instead of adding a broken row', () => {
    const plan = planImport(exported, sanitizeSettings({}), 'C:\\Users\\other', () => false);
    expect(typeof plan === 'string' ? [] : plan.missing).toEqual(['web-app (~/code/web-app)', 'admin (~/code/admin)']);
  });

  it('refuses a file that is not a team configuration', () => {
    expect(planImport({ projects: [] }, sanitizeSettings({}), HOME, () => true)).toMatch(/not a team configuration/);
    expect(planImport({ ...exported, version: 2 }, sanitizeSettings({}), HOME, () => true)).toMatch(/newer version/);
  });
});
