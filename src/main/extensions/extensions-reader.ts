import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectId } from '@shared/contracts.js';
import {
  codexHooks,
  codexMcpServers,
  listHooks,
  markDuplicates,
  mcpShape,
  normalizePathKey,
  parseFrontmatter,
  readClaudeMcpMap,
  readToml,
  type ExtensionAgent,
  type ExtensionFact,
  type ExtensionItem,
  type ExtensionScope,
  type ExtensionVerb,
  type StoredMcp,
  type WritableScope,
} from '@shared/extensions.js';

/**
 * Reads what both coding agents have installed, from their own files.
 *
 * Files and not the CLIs, for the reason the Performance section of CLAUDE.md gives first: a read
 * here is a dozen small files, while `claude mcp list` health-checks every server and takes seconds.
 * The CLIs are kept for the writes, where they are the authority on their own formats.
 *
 * `home` and the projects are passed in so the tests run on a fixture tree and never on the disk of
 * whoever runs them.
 */

export interface ReaderProject {
  readonly id: ProjectId;
  readonly label: string;
  readonly path: string;
}

/** What an action needs, kept in the main process. The renderer only ever sends the id. */
export type ExtensionRef =
  | {
      readonly type: 'claude-hook';
      readonly file: string;
      readonly location: { event: string; group: number; index: number };
    }
  | { readonly type: 'skill'; readonly dir: string; readonly link: boolean }
  | {
      readonly type: 'claude-plugin';
      readonly plugin: string;
      readonly scope: WritableScope;
      readonly cwd: string | null;
    }
  | {
      readonly type: 'claude-mcp';
      readonly name: string;
      readonly scope: WritableScope;
      readonly cwd: string | null;
      readonly server: StoredMcp;
    }
  | {
      readonly type: 'codex-mcp';
      readonly name: string;
      readonly file: string;
      readonly server: StoredMcp;
      readonly bearerEnv: string;
    }
  | { readonly type: 'routine'; readonly id: string }
  | { readonly type: 'read-only' };

export interface ReadOutcome {
  readonly items: ExtensionItem[];
  readonly refs: Map<string, ExtensionRef>;
  /** Modification time of each settings file read, so a write can tell it changed underneath. */
  readonly mtimes: Map<string, number>;
  readonly problems: string[];
}

interface Scope {
  readonly scope: ExtensionScope;
  readonly label: string;
  readonly projectId: ProjectId | null;
}

const USER: Scope = { scope: 'user', label: 'user', projectId: null };

/** Widest first: what applies everywhere, then one project, then what someone else manages. */
const SCOPE_ORDER: Record<ExtensionScope, number> = {
  user: 0,
  org: 1,
  system: 1,
  project: 2,
  local: 3,
  plugin: 4,
  'claude.ai': 5,
};

function fact(label: string, value: string, mono = false): ExtensionFact {
  return { label, value, mono };
}

class Collector {
  readonly items: ExtensionItem[] = [];
  readonly refs = new Map<string, ExtensionRef>();
  readonly mtimes = new Map<string, number>();
  readonly problems: string[] = [];

  add(
    item: Omit<ExtensionItem, 'scope' | 'scopeLabel' | 'projectId' | 'duplicates' | 'link'>,
    scope: Scope,
    ref: ExtensionRef,
  ): void {
    if (this.refs.has(item.id)) {
      return;
    }
    this.items.push({
      ...item,
      scope: scope.scope,
      scopeLabel: scope.label,
      projectId: scope.projectId,
      duplicates: [],
      link: null,
    });
    this.refs.set(item.id, ref);
  }

  /** The JSON in a file, `undefined` when it does not exist, a problem when it cannot be read. */
  async json(file: string, track = false): Promise<unknown> {
    try {
      const text = await readFile(file, 'utf8');
      if (track) {
        this.mtimes.set(file, (await stat(file)).mtimeMs);
      }
      return JSON.parse(text.replace(/^﻿/, '')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.problems.push(`${file}: ${(error as Error).message}`);
      }
      return undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectScope(project: ReaderProject, scope: 'project' | 'local'): Scope {
  return { scope, label: `${scope}: ${project.label}`, projectId: project.id };
}

/* ------------------------------------------------------------------ hooks */

function hookItems(
  collector: Collector,
  agent: ExtensionAgent,
  settings: unknown,
  file: string,
  scope: Scope,
  readOnly: string | null,
): void {
  for (const hook of listHooks(settings)) {
    const id = `${agent}:hook:${file}:${hook.event}:${hook.group}:${hook.index}`;
    const verbs: ExtensionVerb[] = readOnly === null ? ['edit', 'remove', 'open', 'reveal'] : ['open', 'reveal'];
    collector.add(
      {
        id,
        agent,
        kind: 'hooks',
        name: hook.command,
        description: hook.matcher.length > 0 ? `${hook.event} · ${hook.matcher}` : hook.event,
        enabled: null,
        facts: [
          fact('Event', hook.event),
          fact('Matcher', hook.matcher.length > 0 ? hook.matcher : 'every call'),
          fact('Command', hook.command, true),
          fact('Timeout', hook.timeout === null ? 'default' : `${hook.timeout} s`),
          fact('File', file, true),
        ],
        file,
        folder: null,
        readOnly,
        verbs,
        identity: `${hook.event}|${hook.matcher}|${hook.command}`,
        mcp: null,
        hook: { event: hook.event, matcher: hook.matcher, command: hook.command, timeout: hook.timeout },
      },
      scope,
      readOnly === null ? { type: 'claude-hook', file, location: hook } : { type: 'read-only' },
    );
  }
}

/* ----------------------------------------------------------------- skills */

async function skillItems(
  collector: Collector,
  agent: ExtensionAgent,
  root: string,
  scope: Scope,
  readOnly: string | null,
  skip: readonly string[] = [],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    if (skip.includes(name)) {
      continue;
    }
    const dir = join(root, name);
    let link = false;
    let real = dir;
    try {
      link = (await lstat(dir)).isSymbolicLink();
      real = await realpath(dir);
    } catch {
      continue;
    }
    const file = join(dir, 'SKILL.md');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const meta = parseFrontmatter(text);
    const facts = [fact('Folder', dir, true)];
    if (link) {
      facts.push(fact('Links to', real, true));
    }
    collector.add(
      {
        id: `${agent}:skill:${dir}`,
        agent,
        kind: 'skills',
        name: meta.name ?? name,
        description: meta.description ?? '',
        enabled: null,
        facts,
        file,
        folder: dir,
        readOnly,
        verbs: readOnly === null ? ['open', 'reveal', 'remove'] : ['open', 'reveal'],
        identity: normalizePathKey(real),
        mcp: null,
        hook: null,
      },
      scope,
      readOnly === null ? { type: 'skill', dir, link } : { type: 'read-only' },
    );
  }
}

/* -------------------------------------------------------------------- mcp */

function mcpFacts(server: StoredMcp, status: string | undefined, bearerEnv = ''): ExtensionFact[] {
  const facts = [fact('Transport', server.transport)];
  if (server.transport === 'stdio') {
    facts.push(fact('Command', [server.command, ...server.args].join(' '), true));
  } else {
    facts.push(fact('URL', server.url, true));
  }
  if (Object.keys(server.env).length > 0) {
    facts.push(fact('Environment', Object.keys(server.env).join(', '), true));
  }
  if (Object.keys(server.headers).length > 0) {
    facts.push(fact('Headers', Object.keys(server.headers).join(', '), true));
  }
  if (bearerEnv.length > 0) {
    facts.push(fact('Token variable', bearerEnv, true));
  }
  if (status !== undefined) {
    facts.push(fact('Status', status));
  }
  return facts;
}

function claudeMcpItems(
  collector: Collector,
  servers: { name: string; server: StoredMcp }[],
  scope: Scope,
  file: string,
  write: { scope: WritableScope; cwd: string | null } | null,
  statuses: Readonly<Record<string, string>> | null,
  readOnly: string | null,
  prefix = '',
): void {
  for (const { name, server } of servers) {
    const shown = `${prefix}${name}`;
    collector.add(
      {
        id: `claude:mcp:${scope.label}:${name}`,
        agent: 'claude',
        kind: 'mcp',
        name,
        description: server.transport === 'stdio' ? server.command : server.url,
        enabled: null,
        facts: [...mcpFacts(server, statuses?.[shown] ?? statuses?.[name]), fact('File', file, true)],
        file,
        folder: null,
        readOnly,
        verbs: readOnly === null && write !== null ? ['edit', 'remove', 'open'] : ['open'],
        identity: name,
        mcp: mcpShape(server),
        hook: null,
      },
      scope,
      readOnly === null && write !== null
        ? { type: 'claude-mcp', name, scope: write.scope, cwd: write.cwd, server }
        : { type: 'read-only' },
    );
  }
}

/* ---------------------------------------------------------------- plugins */

async function pluginContributions(
  collector: Collector,
  plugin: string,
  installPath: string,
  manifest: Record<string, unknown> | null,
  statuses: Readonly<Record<string, string>> | null,
): Promise<void> {
  const short = plugin.split('@')[0] ?? plugin;
  const scope: Scope = { scope: 'plugin', label: `plugin: ${short}`, projectId: null };
  const why = `Provided by the ${short} plugin: disable or uninstall the plugin instead`;
  await skillItems(collector, 'claude', join(installPath, 'skills'), scope, why);

  const hooksFile = join(installPath, 'hooks', 'hooks.json');
  const hooks = await collector.json(hooksFile);
  if (hooks !== undefined) {
    hookItems(collector, 'claude', isRecord(hooks) && 'hooks' in hooks ? hooks : { hooks }, hooksFile, scope, why);
  }

  const mcpFile = join(installPath, '.mcp.json');
  const mcp = await collector.json(mcpFile);
  const fromFile = isRecord(mcp) && isRecord(mcp['mcpServers']) ? mcp['mcpServers'] : mcp;
  const fromManifest = manifest !== null && isRecord(manifest['mcpServers']) ? manifest['mcpServers'] : undefined;
  const servers = [...readClaudeMcpMap(fromFile), ...readClaudeMcpMap(fromManifest)];
  claudeMcpItems(
    collector,
    servers.filter((entry, at) => servers.findIndex((other) => other.name === entry.name) === at),
    scope,
    fromManifest !== undefined ? join(installPath, '.claude-plugin', 'plugin.json') : mcpFile,
    null,
    statuses,
    why,
    `plugin:${short}:`,
  );
}

async function pluginItems(
  collector: Collector,
  home: string,
  projects: readonly ReaderProject[],
  enabled: (scope: WritableScope, projectPath: string | null) => Record<string, unknown>,
  statuses: Readonly<Record<string, string>> | null,
): Promise<void> {
  const file = join(home, '.claude', 'plugins', 'installed_plugins.json');
  const installed = await collector.json(file);
  const plugins = isRecord(installed) && isRecord(installed['plugins']) ? installed['plugins'] : {};
  for (const [plugin, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry['installPath'] !== 'string') {
        continue;
      }
      const writable: WritableScope =
        entry['scope'] === 'project' || entry['scope'] === 'local' ? entry['scope'] : 'user';
      const projectPath = typeof entry['projectPath'] === 'string' ? entry['projectPath'] : null;
      let scope: Scope = USER;
      if (writable !== 'user') {
        const project = projects.find(
          (candidate) => projectPath !== null && normalizePathKey(candidate.path) === normalizePathKey(projectPath),
        );
        if (project === undefined) {
          continue;
        }
        scope = projectScope(project, writable);
      }
      const installPath = entry['installPath'];
      const manifest = await collector.json(join(installPath, '.claude-plugin', 'plugin.json'));
      const meta = isRecord(manifest) ? manifest : null;
      const on = enabled(writable, projectPath)[plugin] === true;
      const version = typeof entry['version'] === 'string' ? entry['version'] : '';
      collector.add(
        {
          id: `claude:plugin:${plugin}:${scope.label}`,
          agent: 'claude',
          kind: 'plugins',
          name: plugin,
          description: typeof meta?.['description'] === 'string' ? meta['description'] : '',
          enabled: on,
          facts: [
            fact('Version', version.length > 0 ? version : 'unknown'),
            fact('Installed in', installPath, true),
            ...(typeof entry['lastUpdated'] === 'string' ? [fact('Updated', entry['lastUpdated'])] : []),
          ],
          file: null,
          folder: installPath,
          readOnly: null,
          verbs: ['toggle', 'remove', 'reveal'],
          identity: plugin,
          mcp: null,
          hook: null,
        },
        scope,
        { type: 'claude-plugin', plugin, scope: writable, cwd: writable === 'user' ? null : projectPath },
      );
      if (on) {
        await pluginContributions(collector, plugin, installPath, meta, statuses);
      }
    }
  }
}

/* ----------------------------------------------------------------- claude */

async function readClaude(
  collector: Collector,
  home: string,
  projects: readonly ReaderProject[],
  statuses: Readonly<Record<string, string>> | null,
): Promise<void> {
  const userSettingsFile = join(home, '.claude', 'settings.json');
  const userSettings = await collector.json(userSettingsFile, true);
  hookItems(collector, 'claude', userSettings, userSettingsFile, USER, null);

  const projectSettings = new Map<string, { project: unknown; local: unknown }>();
  for (const project of projects) {
    const shared = join(project.path, '.claude', 'settings.json');
    const local = join(project.path, '.claude', 'settings.local.json');
    const sharedValue = await collector.json(shared, true);
    const localValue = await collector.json(local, true);
    projectSettings.set(normalizePathKey(project.path), { project: sharedValue, local: localValue });
    hookItems(collector, 'claude', sharedValue, shared, projectScope(project, 'project'), null);
    hookItems(collector, 'claude', localValue, local, projectScope(project, 'local'), null);
  }

  const skillsRoot = join(home, '.claude', 'skills');
  await skillItems(collector, 'claude', skillsRoot, USER, null, ['synced']);
  let orgs: string[] = [];
  try {
    orgs = await readdir(join(skillsRoot, 'synced'));
  } catch {
    orgs = [];
  }
  for (const org of orgs) {
    await skillItems(
      collector,
      'claude',
      join(skillsRoot, 'synced', org),
      { scope: 'org', label: 'org', projectId: null },
      'Synced from claude.ai: managed in the organisation settings there',
    );
  }
  for (const project of projects) {
    await skillItems(collector, 'claude', join(project.path, '.claude', 'skills'), projectScope(project, 'project'), null);
  }

  const enabledIn = (scope: WritableScope, projectPath: string | null): Record<string, unknown> => {
    const source =
      scope === 'user'
        ? userSettings
        : projectSettings.get(normalizePathKey(projectPath ?? ''))?.[scope === 'project' ? 'project' : 'local'];
    return isRecord(source) && isRecord(source['enabledPlugins']) ? source['enabledPlugins'] : {};
  };
  await pluginItems(collector, home, projects, enabledIn, statuses);

  const stateFile = join(home, '.claude.json');
  const state = await collector.json(stateFile);
  const root = isRecord(state) ? state : {};
  claudeMcpItems(
    collector,
    readClaudeMcpMap(root['mcpServers']),
    USER,
    stateFile,
    { scope: 'user', cwd: null },
    statuses,
    null,
  );
  const known = isRecord(root['projects']) ? root['projects'] : {};
  for (const project of projects) {
    const key = Object.keys(known).find((path) => normalizePathKey(path) === normalizePathKey(project.path));
    const entry = key === undefined ? undefined : known[key];
    claudeMcpItems(
      collector,
      readClaudeMcpMap(isRecord(entry) ? entry['mcpServers'] : undefined),
      projectScope(project, 'local'),
      stateFile,
      { scope: 'local', cwd: project.path },
      statuses,
      null,
    );
    const mcpFile = join(project.path, '.mcp.json');
    const shared = await collector.json(mcpFile);
    claudeMcpItems(
      collector,
      readClaudeMcpMap(isRecord(shared) ? shared['mcpServers'] : undefined),
      projectScope(project, 'project'),
      mcpFile,
      { scope: 'project', cwd: project.path },
      statuses,
      null,
    );
  }

  if (statuses !== null) {
    const connectors: Scope = { scope: 'claude.ai', label: 'claude.ai', projectId: null };
    for (const [name, status] of Object.entries(statuses)) {
      if (!name.startsWith('claude.ai ')) {
        continue;
      }
      collector.add(
        {
          id: `claude:connector:${name}`,
          agent: 'claude',
          kind: 'mcp',
          name: name.slice('claude.ai '.length),
          description: 'claude.ai connector',
          enabled: null,
          facts: [fact('Status', status)],
          file: null,
          folder: null,
          readOnly: 'A claude.ai connector: connect or remove it in the claude.ai settings',
          verbs: [],
          identity: name,
          mcp: null,
          hook: null,
        },
        connectors,
        { type: 'read-only' },
      );
    }
  }
}

/* ------------------------------------------------------------------ codex */

async function readCodex(collector: Collector, home: string): Promise<void> {
  const file = join(home, '.codex', 'config.toml');
  let text: string | null = null;
  try {
    text = await readFile(file, 'utf8');
    collector.mtimes.set(file, (await stat(file)).mtimeMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      collector.problems.push(`${file}: ${(error as Error).message}`);
    }
  }
  if (text !== null) {
    const tables = readToml(text);
    for (const entry of codexMcpServers(tables)) {
      collector.add(
        {
          id: `codex:mcp:${entry.name}`,
          agent: 'codex',
          kind: 'mcp',
          name: entry.name,
          description: entry.server.transport === 'stdio' ? entry.server.command : entry.server.url,
          enabled: entry.enabled,
          facts: [...mcpFacts(entry.server, undefined, entry.bearerEnv), fact('File', file, true)],
          file,
          folder: null,
          readOnly: null,
          verbs: ['toggle', 'edit', 'remove', 'open'],
          identity: entry.name,
          mcp: mcpShape(entry.server, entry.bearerEnv),
          hook: null,
        },
        USER,
        { type: 'codex-mcp', name: entry.name, file, server: entry.server, bearerEnv: entry.bearerEnv },
      );
    }
    for (const [at, entry] of codexHooks(tables).entries()) {
      collector.add(
        {
          id: `codex:hook:${at}`,
          agent: 'codex',
          kind: 'hooks',
          name: entry.hook.command,
          description: entry.hook.matcher.length > 0 ? `${entry.hook.event} · ${entry.hook.matcher}` : entry.hook.event,
          enabled: null,
          facts: [
            fact('Event', entry.hook.event),
            fact('Matcher', entry.hook.matcher.length > 0 ? entry.hook.matcher : 'every call'),
            fact('Command', entry.hook.command, true),
            fact('File', file, true),
          ],
          file,
          folder: null,
          readOnly:
            'Edited in config.toml: Codex has no command for hooks. Whether this version runs them is not checked here',
          verbs: ['open', 'reveal'],
          identity: `${entry.hook.event}|${entry.hook.matcher}|${entry.hook.command}`,
          mcp: null,
          hook: entry.hook,
        },
        USER,
        { type: 'read-only' },
      );
    }
  }

  const skills = join(home, '.codex', 'skills');
  await skillItems(collector, 'codex', skills, USER, null, ['.system']);
  await skillItems(
    collector,
    'codex',
    join(skills, '.system'),
    { scope: 'system', label: 'system', projectId: null },
    'Bundled with Codex, which restores it on update',
  );
}

/** Everything both agents have installed, for the user and for the given projects. */
export async function readExtensions(
  home: string,
  projects: readonly ReaderProject[],
  statuses: Readonly<Record<string, string>> | null,
): Promise<ReadOutcome> {
  const collector = new Collector();
  await readClaude(collector, home, projects, statuses);
  await readCodex(collector, home);
  // Stable, so the order a source was read in survives inside each scope.
  const ordered = [...collector.items].sort((left, right) => SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope]);
  return {
    items: markDuplicates(ordered),
    refs: collector.refs,
    mtimes: collector.mtimes,
    problems: collector.problems,
  };
}
