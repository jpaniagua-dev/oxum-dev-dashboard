import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Project,
  ProjectAction,
  ProjectCandidate,
  ProjectConfig,
  ProjectId,
  ProjectValidation,
} from '@shared/contracts.js';
import { inferProject, validateActions, validateProjectPath } from './project-inference.js';
import {
  DEFAULT_PROJECTS_ROOT,
  defaultActions,
  makeActionId,
  makeId,
  shortLabel,
} from './project-id.js';

// Re-exported so existing importers and tests keep one obvious entry point.
export { DEFAULT_PROJECTS_ROOT, defaultActions, makeActionId, makeId, shortLabel };

/**
 * The command a project's server action runs, or an empty string when it has none.
 *
 * Single place that answers "what does this project start", used both by inference and by the table.
 * A project can legitimately have no server action: a folder with only a `commit` button is a valid
 * row, it simply has nothing to say about a server.
 */
export function serverAction(actions: readonly ProjectAction[]): ProjectAction | undefined {
  return actions.find((action) => action.role === 'server');
}

/**
 * Folder names seeded on a fresh install.
 *
 * Only a starting point, not a hardcoded list: everything about a project is editable afterwards and
 * new ones are added from the settings dialog. The seed exists so the app is useful on first launch
 * without asking the user to configure anything.
 */
const SEED_FOLDERS: readonly { folder: string; label: string }[] = [
  { folder: 'web-app', label: 'Web' },
  // A short label reads better in a column than a long folder name.
  { folder: 'admin-front', label: 'Admin' },
  { folder: 'design-system', label: 'Design' },
];

/**
 * Turns stored configuration into the runtime project list.
 *
 * `kind` and `expectedPort` fall back to what the repository's own `package.json` says, so a project
 * the user never fine-tuned still behaves correctly, and a project whose start script changes follows
 * along without an edit.
 */
export function resolveProjects(configs: readonly ProjectConfig[]): Project[] {
  return configs
    .filter((config) => config.enabled && existsSync(config.path))
    .map((config) => {
      const inferred = inferProject(config.path, serverAction(config.actions)?.command);
      return {
        id: config.id,
        label: config.label,
        path: config.path,
        actions: config.actions,
        kind: config.kind ?? inferred.kind,
        expectedPort: config.expectedPort ?? inferred.port,
      };
    });
}

/** Looks a project up by id. */
export function findProject(projects: readonly Project[], id: ProjectId): Project | undefined {
  return projects.find((project) => project.id === id);
}

/**
 * Builds the initial configuration for a fresh install.
 *
 * Seed folders that are missing are simply skipped, so a machine with a different layout starts with
 * whatever it actually has rather than three broken rows.
 */
export function seedProjects(root: string): ProjectConfig[] {
  return SEED_FOLDERS.filter((seed) => existsSync(join(root, seed.folder))).map((seed) => ({
    ...configFromPath(join(root, seed.folder)),
    // The seed carries the short working names rather than the folder names, which is how these
    // projects are actually referred to day to day. Still editable afterwards.
    label: seed.label,
  }));
}

/**
 * Scans a root for repositories worth offering.
 *
 * A candidate needs a `package.json` with the requested start script: the point is to offer things
 * the dashboard can actually run, not every folder on disk.
 */
export function detectCandidates(
  root: string,
  existing: readonly ProjectConfig[],
): ProjectCandidate[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const taken = new Set(existing.map((config) => normalise(config.path)));
  const candidates: ProjectCandidate[] = [];

  for (const name of entries) {
    const path = join(root, name);
    try {
      if (!statSync(path).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const inferred = inferProject(path);
    if (!inferred.found || !inferred.scripts.includes('start')) {
      continue;
    }

    candidates.push({
      label: name,
      path,
      kind: inferred.kind,
      expectedPort: inferred.port,
      alreadyAdded: taken.has(normalise(path)),
    });
  }

  return candidates.sort((a, b) => a.label.localeCompare(b.label));
}

/** Builds a configuration entry for a freshly picked folder. */
export function configFromPath(path: string): ProjectConfig {
  const label = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'projet';
  return {
    id: makeId(label),
    label: shortLabel(label),
    path,
    actions: defaultActions(),
    // Left null so the values follow the repository's own manifest until the user overrides them.
    kind: null,
    expectedPort: null,
    enabled: true,
  };
}


/** Validates a whole configuration list, for the settings dialog. */
export function validateProjects(configs: readonly ProjectConfig[]): ProjectValidation[] {
  const seenPaths = new Map<string, number>();
  for (const config of configs) {
    const key = normalise(config.path);
    seenPaths.set(key, (seenPaths.get(key) ?? 0) + 1);
  }

  return configs.map((config) => {
    const server = serverAction(config.actions);
    const issues = validateProjectPath(config.path);
    if (config.label.trim().length === 0) {
      issues.push({ level: 'error', message: 'Le nom est vide' });
    }
    if ((seenPaths.get(normalise(config.path)) ?? 0) > 1) {
      // Two rows on one repository would fight over the same terminal and the same server state.
      issues.push({ level: 'error', message: 'Ce dossier est déjà utilisé par un autre projet' });
    }
    issues.push(...validateActions(config.path, config.actions));

    const inferred = inferProject(config.path, server?.command);
    return {
      id: config.id,
      issues,
      serverCommand: server?.command ?? '',
      scripts: [...inferred.scripts],
      inferredKind: inferred.found ? inferred.kind : null,
      inferredPort: inferred.found ? inferred.port : null,
    };
  });
}

function normalise(value: string): string {
  return value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}
