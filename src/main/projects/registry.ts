import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Project, ProjectId } from '@shared/contracts.js';

/** Where the watched repositories live. Overridable so the app is not tied to one machine. */
const DEFAULT_ROOT = join(homedir(), 'oxum', 'projects');

/**
 * The three front-end projects, with the facts that decide how each is observed.
 *
 * The ports are not guesses: they come from each repository's `start` script.
 * `web-app` runs a bare `ng serve` (Angular's default 4200),
 * `admin-front` passes `--port 4201`, and `design-system` runs
 * `ng build --watch`, which starts no server at all, hence `kind: 'watch'` and no port.
 */
function buildProjects(root: string): Project[] {
  return [
    {
      id: 'web-app',
      label: 'shared-front',
      path: join(root, 'web-app'),
      startScript: 'start',
      kind: 'server',
      expectedPort: 4200,
    },
    {
      id: 'admin-front',
      label: 'rating-acquisition',
      path: join(root, 'admin-front'),
      startScript: 'start',
      kind: 'server',
      expectedPort: 4201,
    },
    {
      id: 'design-system',
      label: 'design',
      path: join(root, 'design-system'),
      startScript: 'start',
      // `ng build --watch`: no HTTP server, so nothing to probe. Its state can only come from
      // the process output, which is why the dashboard spawns it rather than watching a port.
      kind: 'watch',
      expectedPort: null,
    },
  ];
}

/** Resolves the project list, honouring an override for the repositories root. */
export function loadProjects(rootOverride?: string): Project[] {
  const root = rootOverride !== undefined && rootOverride.length > 0 ? rootOverride : DEFAULT_ROOT;
  return buildProjects(root);
}

/** Projects whose directory actually exists, so a missing clone degrades instead of erroring. */
export function loadExistingProjects(rootOverride?: string): Project[] {
  return loadProjects(rootOverride).filter((project) => existsSync(project.path));
}

/** Looks a project up by id. */
export function findProject(projects: readonly Project[], id: ProjectId): Project | undefined {
  return projects.find((project) => project.id === id);
}
