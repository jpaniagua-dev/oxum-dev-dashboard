import type { AgentProfile } from './agent-profile.js';
import type { AppSettings, ProjectConfig, TagColor } from './contracts.js';

/**
 * A starting configuration one person exports and a colleague imports.
 *
 * Only what is the same for a team: the projects (as paths under each person's home), their
 * actions and tags, the tag colours, the Jira site and project keys, the agent profile and its
 * models. Never a secret, an email, a window size or a personal skill: those belong to whoever
 * runs the app, and a file meant to be passed around must hold nothing that is one person's.
 */

export const TEAM_CONFIG_FORMAT = 'oxum-dev-dashboard/team-config';

export interface TeamConfig {
  readonly format: typeof TEAM_CONFIG_FORMAT;
  readonly version: 1;
  readonly exportedAt: string;
  readonly projectsRoot: string;
  readonly projects: readonly Omit<ProjectConfig, 'enabled'>[];
  readonly tagColors: Readonly<Record<string, TagColor>>;
  readonly jira: { readonly siteUrl: string; readonly projectKeys: readonly string[] };
  readonly agent: {
    readonly profile: AgentProfile;
    readonly models: {
      readonly analysis: string;
      readonly work: string;
      readonly commit: string;
      readonly review: string;
    };
  };
}

function slashes(path: string): string {
  return path.replace(/\\/g, '/');
}

/** `C:\Users\me\code\web` as `~/code/web`, so the same file names the right folder on every machine. */
export function homeRelative(path: string, home: string): string {
  const target = slashes(path);
  const base = slashes(home).replace(/\/+$/, '');
  return target.toLowerCase() === base.toLowerCase()
    ? '~'
    : target.toLowerCase().startsWith(`${base.toLowerCase()}/`)
      ? `~${target.slice(base.length)}`
      : target;
}

/** `~/code/web` back to a path under this machine's home. Anything else is kept as written. */
export function expandHome(path: string, home: string): string {
  if (path === '~') {
    return slashes(home);
  }
  return path.startsWith('~/') ? `${slashes(home).replace(/\/+$/, '')}${path.slice(1)}` : path;
}

export function toTeamConfig(settings: AppSettings, home: string, now: Date = new Date()): TeamConfig {
  return {
    format: TEAM_CONFIG_FORMAT,
    version: 1,
    exportedAt: now.toISOString(),
    projectsRoot: settings.projectsRoot.length > 0 ? homeRelative(settings.projectsRoot, home) : '',
    // Field by field: `enabled` is this person's choice of what to watch, not the team's.
    projects: settings.projects.map((project) => ({
      id: project.id,
      label: project.label,
      path: homeRelative(project.path, home),
      actions: project.actions,
      kind: project.kind,
      expectedPort: project.expectedPort,
      followPulls: project.followPulls,
      tags: project.tags,
    })),
    tagColors: settings.tagColors,
    jira: { siteUrl: settings.jira.siteUrl, projectKeys: settings.jira.projectKeys },
    agent: {
      profile: settings.agentProfile,
      models: {
        analysis: settings.agentAnalysisModel,
        work: settings.agentWorkModel,
        commit: settings.agentCommitModel,
        review: settings.agentReviewModel,
      },
    },
  };
}

export interface ImportPlan {
  /** What to write over the current settings. The store validates every field again. */
  readonly patch: Partial<AppSettings>;
  readonly added: readonly string[];
  /** Projects whose folder is not on this machine, by label and expected path. */
  readonly missing: readonly string[];
  readonly skipped: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What importing a file would change, or why it cannot be imported.
 *
 * Projects are **added**, never replacing the reader's own: one already configured at the same
 * folder or under the same id is skipped, and one whose folder this machine does not have is
 * listed as missing rather than added as a broken row. The Jira site and keys, the agent profile
 * and the models replace the current ones, being team settings. Values go through the store's own
 * validation on the way in, so this only has to get the shape right.
 */
export function planImport(
  raw: unknown,
  current: AppSettings,
  home: string,
  exists: (path: string) => boolean,
): ImportPlan | string {
  if (!isRecord(raw) || raw['format'] !== TEAM_CONFIG_FORMAT) {
    return 'This is not a team configuration exported by this app';
  }
  if (raw['version'] !== 1) {
    return 'This team configuration comes from a newer version of the app: update first';
  }
  const known = new Set(current.projects.map((project) => slashes(project.path).toLowerCase()));
  const ids = new Set(current.projects.map((project) => project.id));
  const added: string[] = [];
  const missing: string[] = [];
  const skipped: string[] = [];
  const projects: ProjectConfig[] = [...current.projects];
  for (const entry of Array.isArray(raw['projects']) ? raw['projects'] : []) {
    if (!isRecord(entry) || typeof entry['path'] !== 'string' || typeof entry['id'] !== 'string') {
      continue;
    }
    const label = typeof entry['label'] === 'string' ? entry['label'] : entry['id'];
    const path = expandHome(entry['path'], home);
    if (known.has(slashes(path).toLowerCase()) || ids.has(entry['id'])) {
      skipped.push(label);
      continue;
    }
    if (!exists(path)) {
      missing.push(`${label} (${entry['path']})`);
      continue;
    }
    known.add(slashes(path).toLowerCase());
    ids.add(entry['id']);
    projects.push({ ...(entry as unknown as ProjectConfig), path, enabled: true });
    added.push(label);
  }

  const patch: Record<string, unknown> = { projects };
  if (isRecord(raw['tagColors'])) {
    patch['tagColors'] = { ...current.tagColors, ...raw['tagColors'] };
  }
  const jira = raw['jira'];
  if (isRecord(jira) && typeof jira['siteUrl'] === 'string' && Array.isArray(jira['projectKeys'])) {
    patch['jira'] = { ...current.jira, siteUrl: jira['siteUrl'], projectKeys: jira['projectKeys'] };
  }
  const agent = raw['agent'];
  if (isRecord(agent)) {
    if (isRecord(agent['profile'])) {
      patch['agentProfile'] = agent['profile'];
    }
    const models = agent['models'];
    if (isRecord(models)) {
      for (const [key, setting] of [
        ['analysis', 'agentAnalysisModel'],
        ['work', 'agentWorkModel'],
        ['commit', 'agentCommitModel'],
        ['review', 'agentReviewModel'],
      ] as const) {
        if (typeof models[key] === 'string') {
          patch[setting] = models[key];
        }
      }
    }
  }
  if (typeof raw['projectsRoot'] === 'string' && raw['projectsRoot'].length > 0 && current.projectsRoot.length === 0) {
    const root = expandHome(raw['projectsRoot'], home);
    if (exists(root)) {
      patch['projectsRoot'] = root;
    }
  }
  return { patch: patch as Partial<AppSettings>, added, missing, skipped };
}
