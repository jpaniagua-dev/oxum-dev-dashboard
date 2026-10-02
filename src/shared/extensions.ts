import type { ProjectId } from './contracts.js';

/**
 * What the coding agents on this machine have installed: hooks, skills, plugins and MCP servers.
 *
 * Two agents and not "the configured one", unlike the rest of the app: the point of the Extensions
 * tab is the inventory of the machine, and both Claude Code and Codex read their own files whichever
 * one the profile drives. Everything here is pure, so the parsing and the edits are pinned by tests
 * on fixtures and never on the author's disk.
 */

export type ExtensionAgent = 'claude' | 'codex';
export type ExtensionKind = 'hooks' | 'skills' | 'plugins' | 'mcp' | 'routines';
export const EXTENSION_KINDS: readonly ExtensionKind[] = ['hooks', 'skills', 'plugins', 'mcp', 'routines'];
export const EXTENSION_AGENTS: readonly ExtensionAgent[] = ['claude', 'codex'];

/** Where an entry is declared. `org` is a claude.ai synced skill, `system` one bundled by Codex. */
export type ExtensionScope = 'user' | 'project' | 'local' | 'plugin' | 'org' | 'system' | 'claude.ai';

/** The three scopes the agents' own CLIs accept for a write. */
export type WritableScope = 'user' | 'project' | 'local';

/** What a row offers. The detail column and the context menu draw the same list. */
export type ExtensionVerb = 'toggle' | 'edit' | 'remove' | 'open' | 'reveal' | 'run';

export interface ExtensionFact {
  readonly label: string;
  readonly value: string;
  /** A value something else has to read back exactly: a path, a command, a URL. */
  readonly mono: boolean;
}

export type McpTransport = 'stdio' | 'http' | 'sse';

/** An MCP server as the renderer may see it: variable and header NAMES, never their values. */
export interface McpShape {
  readonly transport: McpTransport;
  readonly command: string;
  readonly args: readonly string[];
  readonly url: string;
  readonly envNames: readonly string[];
  readonly headerNames: readonly string[];
  /** Codex only: the variable its bearer token is read from. */
  readonly bearerEnv: string;
}

export interface HookShape {
  readonly event: string;
  readonly matcher: string;
  readonly command: string;
  readonly timeout: number | null;
}

export interface ExtensionItem {
  /** Stable for one read. The main process resolves every action from it, never from the renderer. */
  readonly id: string;
  readonly agent: ExtensionAgent;
  readonly kind: ExtensionKind;
  readonly name: string;
  readonly description: string;
  readonly scope: ExtensionScope;
  /** `user`, `project: web-app`, `plugin: context7`. */
  readonly scopeLabel: string;
  readonly projectId: ProjectId | null;
  /** Null for a kind that has no on/off state. */
  readonly enabled: boolean | null;
  readonly facts: readonly ExtensionFact[];
  readonly file: string | null;
  readonly folder: string | null;
  /** A web page for the entry, opened in the browser. */
  readonly link: string | null;
  /** Why nothing can be changed from here, or null when something can. */
  readonly readOnly: string | null;
  readonly verbs: readonly ExtensionVerb[];
  /** The other scopes declaring the same thing. */
  readonly duplicates: readonly string[];
  /** Used by `markDuplicates`: two entries with the same key are the same thing twice. */
  readonly identity: string;
  readonly mcp: McpShape | null;
  readonly hook: HookShape | null;
}

export interface AgentStatus {
  readonly agent: ExtensionAgent;
  readonly label: string;
  /** The command as configured. */
  readonly command: string;
  /** The executable it resolved to, or null when nothing was found. */
  readonly resolved: string | null;
  readonly version: string | null;
  readonly problem: string | null;
}

export interface ExtensionsView {
  readonly readAt: string;
  readonly agents: readonly AgentStatus[];
  readonly items: readonly ExtensionItem[];
  readonly projects: readonly { id: ProjectId; label: string }[];
  /** MCP server name to the status `claude mcp list` printed, after an explicit check. */
  readonly statuses: Readonly<Record<string, string>> | null;
  /** Files that exist and could not be read. Shown, never swallowed. */
  readonly problems: readonly string[];
  /** When the routines were last read from claude.ai, and why the last attempt failed. */
  readonly routines: { readonly readAt: string | null; readonly error: string | null };
}

export interface ExtensionsResult {
  readonly ok: boolean;
  readonly message: string;
  readonly view: ExtensionsView;
}

/** A server typed in the form. An empty value on an existing name keeps the stored one. */
export interface McpDraft {
  readonly transport: McpTransport;
  readonly command: string;
  readonly args: readonly string[];
  readonly url: string;
  readonly env: readonly { name: string; value: string }[];
  readonly headers: readonly { name: string; value: string }[];
  readonly bearerEnv: string;
}

export type ExtensionAction =
  | { readonly type: 'toggle' | 'remove' | 'open' | 'reveal' | 'run'; readonly id: string }
  /** Opens Claude Code on `/schedule` in a terminal tab, about one routine or a new one. */
  | { readonly type: 'schedule-session'; readonly id: string | null }
  | {
      readonly type: 'save-mcp';
      /** The entry being edited, or null for a new one. */
      readonly id: string | null;
      readonly agent: ExtensionAgent;
      readonly scope: WritableScope;
      readonly projectId: ProjectId | null;
      readonly name: string;
      readonly draft: McpDraft;
    }
  | {
      readonly type: 'save-hook';
      readonly id: string | null;
      readonly scope: WritableScope;
      readonly projectId: ProjectId | null;
      readonly hook: HookShape;
    }
  | {
      readonly type: 'add-skill';
      readonly agent: ExtensionAgent;
      readonly scope: 'user' | 'project';
      readonly projectId: ProjectId | null;
      readonly name: string;
      readonly description: string;
    }
  | {
      readonly type: 'install-plugin';
      readonly plugin: string;
      readonly scope: WritableScope;
      readonly projectId: ProjectId | null;
    };

/** The events Claude Code fires hooks on, offered by the form. A stored unknown one is still shown. */
export const CLAUDE_HOOK_EVENTS: readonly string[] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'SessionStart',
  'SessionEnd',
];

/* ------------------------------------------------------------------ names */

/**
 * A server or skill name both CLIs accept, and one that is safe as a folder and as an argument.
 *
 * Narrower than either CLI on purpose: the name goes on a command line and, for a skill, becomes a
 * directory, so anything that needs quoting is refused rather than quoted.
 */
export function isValidName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

/** `name@marketplace`, the only form `claude plugin install` resolves without asking. */
export function isValidPluginId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(id);
}

/**
 * The key a project is stored under in `~/.claude.json`, for comparison only.
 *
 * The same folder appears there as `C:/x` and as `C:\x`, sometimes with a different drive case, so
 * a lookup by the exact string misses half of them.
 */
export function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/* ------------------------------------------------------------ frontmatter */

/** `name` and `description` from a SKILL.md, the only two fields the list needs. */
export function parseFrontmatter(text: string): { name: string | null; description: string | null } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) {
    return { name: null, description: null };
  }
  const read = (key: string): string | null => {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(match[1] ?? '');
    if (line === null) {
      return null;
    }
    const raw = (line[1] ?? '').trim();
    const unquoted = /^(["'])(.*)\1$/.exec(raw);
    const value = unquoted === null ? raw : (unquoted[2] ?? '');
    return value.length === 0 ? null : value;
  };
  return { name: read('name'), description: read('description') };
}

/** The skeleton a new skill starts from. The reader writes the rest in their editor. */
export function skillSkeleton(name: string, description: string): string {
  const safe = description.replace(/\r?\n/g, ' ').trim();
  return `---\nname: ${name}\ndescription: ${safe.length > 0 ? safe : 'What this skill does and when to use it.'}\n---\n\n# ${name}\n`;
}

/* ------------------------------------------------------------ claude hooks */

export interface HookEntry extends HookShape {
  readonly group: number;
  readonly index: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every command hook in a settings object, flattened.
 *
 * Settings nest them three deep (`hooks.<Event>[group].hooks[index]`), and a group's matcher applies
 * to every command in it. A row per command is what a reader means by "a hook"; the location is
 * kept so an edit lands back in the same place.
 */
export function listHooks(settings: unknown): HookEntry[] {
  const hooks = isRecord(settings) ? settings['hooks'] : undefined;
  if (!isRecord(hooks)) {
    return [];
  }
  const entries: HookEntry[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    groups.forEach((group: unknown, groupIndex) => {
      if (!isRecord(group) || !Array.isArray(group['hooks'])) {
        return;
      }
      const matcher = typeof group['matcher'] === 'string' ? group['matcher'] : '';
      (group['hooks'] as unknown[]).forEach((hook, index) => {
        if (!isRecord(hook) || typeof hook['command'] !== 'string') {
          return;
        }
        entries.push({
          event,
          matcher,
          command: hook['command'],
          timeout: typeof hook['timeout'] === 'number' ? hook['timeout'] : null,
          group: groupIndex,
          index,
        });
      });
    });
  }
  return entries;
}

function cloneSettings(settings: unknown): Record<string, unknown> {
  return isRecord(settings) ? (JSON.parse(JSON.stringify(settings)) as Record<string, unknown>) : {};
}

/**
 * The settings without one hook, tidying what it leaves empty.
 *
 * An empty group, an empty event and an empty `hooks` object are each removed, so deleting the last
 * hook leaves the file as it would be had it never had one.
 */
export function removeHook(
  settings: unknown,
  location: { event: string; group: number; index: number },
): Record<string, unknown> {
  const next = cloneSettings(settings);
  const hooks = next['hooks'];
  if (!isRecord(hooks)) {
    return next;
  }
  const groups = hooks[location.event];
  if (!Array.isArray(groups)) {
    return next;
  }
  const group: unknown = groups[location.group];
  if (!isRecord(group) || !Array.isArray(group['hooks'])) {
    return next;
  }
  (group['hooks'] as unknown[]).splice(location.index, 1);
  if ((group['hooks'] as unknown[]).length === 0) {
    groups.splice(location.group, 1);
  }
  if (groups.length === 0) {
    delete hooks[location.event];
  }
  if (Object.keys(hooks).length === 0) {
    delete next['hooks'];
  }
  return next;
}

/** The settings with one more command hook, joining the group that already has its matcher. */
export function addHook(settings: unknown, hook: HookShape): Record<string, unknown> {
  const next = cloneSettings(settings);
  const hooks = isRecord(next['hooks']) ? next['hooks'] : {};
  next['hooks'] = hooks;
  const groups: unknown[] = Array.isArray(hooks[hook.event]) ? (hooks[hook.event] as unknown[]) : [];
  hooks[hook.event] = groups;
  const entry: Record<string, unknown> = { type: 'command', command: hook.command };
  if (hook.timeout !== null) {
    entry['timeout'] = hook.timeout;
  }
  const existing = groups.find(
    (group) =>
      isRecord(group) &&
      Array.isArray(group['hooks']) &&
      (typeof group['matcher'] === 'string' ? group['matcher'] : '') === hook.matcher,
  );
  if (isRecord(existing)) {
    (existing['hooks'] as unknown[]).push(entry);
  } else {
    groups.push(hook.matcher.length > 0 ? { matcher: hook.matcher, hooks: [entry] } : { hooks: [entry] });
  }
  return next;
}

/**
 * Replaces one hook.
 *
 * In place when the event and matcher are unchanged, so its position among its siblings survives;
 * otherwise removed and added again, because a matcher belongs to the group and changing it on the
 * group would change it for every other command sharing that group.
 */
export function replaceHook(
  settings: unknown,
  location: { event: string; group: number; index: number },
  hook: HookShape,
): Record<string, unknown> {
  const current = listHooks(settings).find(
    (entry) =>
      entry.event === location.event && entry.group === location.group && entry.index === location.index,
  );
  if (current !== undefined && current.event === hook.event && current.matcher === hook.matcher) {
    const next = cloneSettings(settings);
    const groups = (next['hooks'] as Record<string, unknown>)[hook.event] as unknown[];
    const group = groups[location.group] as Record<string, unknown>;
    const entry = (group['hooks'] as Record<string, unknown>[])[location.index] ?? {};
    entry['command'] = hook.command;
    if (hook.timeout === null) {
      delete entry['timeout'];
    } else {
      entry['timeout'] = hook.timeout;
    }
    return next;
  }
  return addHook(removeHook(settings, location), hook);
}

/* -------------------------------------------------------------- claude MCP */

export interface StoredMcp {
  readonly transport: McpTransport;
  readonly command: string;
  readonly args: readonly string[];
  readonly url: string;
  readonly env: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }
  return out;
}

/** One server definition, as Claude Code writes it. A missing `type` with a command is stdio. */
export function readClaudeMcp(value: unknown): StoredMcp | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = value['type'];
  const url = typeof value['url'] === 'string' ? value['url'] : '';
  const command = typeof value['command'] === 'string' ? value['command'] : '';
  const transport: McpTransport =
    type === 'http' || type === 'sse' ? type : command.length === 0 && url.length > 0 ? 'http' : 'stdio';
  return {
    transport,
    command,
    args: Array.isArray(value['args'])
      ? value['args'].filter((arg): arg is string => typeof arg === 'string')
      : [],
    url,
    env: stringRecord(value['env']),
    headers: stringRecord(value['headers']),
  };
}

/** The servers of a `mcpServers` map, in file order. */
export function readClaudeMcpMap(value: unknown): { name: string; server: StoredMcp }[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([name, entry]) => {
    const server = readClaudeMcp(entry);
    return server === null ? [] : [{ name, server }];
  });
}

export function mcpShape(server: StoredMcp, bearerEnv = ''): McpShape {
  return {
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    envNames: Object.keys(server.env),
    headerNames: Object.keys(server.headers),
    bearerEnv,
  };
}

/**
 * What a draft means once the blanks are filled from the stored server.
 *
 * The renderer never holds a value it did not type, so an edit sends empty values for everything it
 * left alone, and those are taken back from what is stored under the same name.
 */
export function resolveDraft(draft: McpDraft, previous: StoredMcp | null): StoredMcp {
  const fill = (
    entries: readonly { name: string; value: string }[],
    stored: Readonly<Record<string, string>>,
  ): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const entry of entries) {
      const name = entry.name.trim();
      if (name.length === 0) {
        continue;
      }
      out[name] = entry.value.length > 0 ? entry.value : (stored[name] ?? '');
    }
    return out;
  };
  return {
    transport: draft.transport,
    command: draft.command.trim(),
    args: draft.args.filter((arg) => arg.length > 0),
    url: draft.url.trim(),
    env: fill(draft.env, previous?.env ?? {}),
    headers: fill(draft.headers, previous?.headers ?? {}),
  };
}

/** Why a resolved server cannot be saved, or null. */
export function draftProblem(server: StoredMcp, agent: ExtensionAgent): string | null {
  if (server.transport === 'stdio') {
    return server.command.length === 0 ? 'A stdio server needs a command' : null;
  }
  if (!/^https?:\/\/\S+$/.test(server.url)) {
    return 'An HTTP server needs a URL starting with http:// or https://';
  }
  if (agent === 'codex' && server.transport === 'sse') {
    return 'Codex only speaks stdio and streamable HTTP';
  }
  if (agent === 'codex' && Object.keys(server.headers).length > 0) {
    return 'Codex takes no headers: put the token in an environment variable instead';
  }
  return null;
}

/** The JSON `claude mcp add-json` takes. */
export function claudeMcpJson(server: StoredMcp): string {
  if (server.transport === 'stdio') {
    const body: Record<string, unknown> = { type: 'stdio', command: server.command, args: server.args };
    if (Object.keys(server.env).length > 0) {
      body['env'] = server.env;
    }
    return JSON.stringify(body);
  }
  const body: Record<string, unknown> = { type: server.transport, url: server.url };
  if (Object.keys(server.headers).length > 0) {
    body['headers'] = server.headers;
  }
  return JSON.stringify(body);
}

/** The arguments of `codex mcp add`, after `codex`. */
export function codexAddArgs(name: string, server: StoredMcp, bearerEnv: string): string[] {
  if (server.transport === 'stdio') {
    return [
      'mcp',
      'add',
      name,
      ...Object.entries(server.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      '--',
      server.command,
      ...server.args,
    ];
  }
  return [
    'mcp',
    'add',
    name,
    '--url',
    server.url,
    ...(bearerEnv.length > 0 ? ['--bearer-token-env-var', bearerEnv] : []),
  ];
}

/**
 * The servers and their status from `claude mcp list`.
 *
 * Text, since the command has no JSON output: one `<name>: <target> - <status>` line per server
 * after a header. Split on the LAST ` - ` because a URL or a command can contain one.
 */
export function parseMcpList(text: string): { name: string; target: string; status: string }[] {
  const servers: { name: string; target: string; status: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(': ');
    const dash = line.lastIndexOf(' - ');
    if (colon <= 0 || dash <= colon) {
      continue;
    }
    servers.push({
      name: line.slice(0, colon).trim(),
      target: line.slice(colon + 2, dash).trim(),
      status: line
        .slice(dash + 3)
        .replace(/^[^A-Za-z]+/, '')
        .trim(),
    });
  }
  return servers;
}

/* -------------------------------------------------------------- codex TOML */

export type TomlValue = string | number | boolean | readonly TomlValue[];

export interface TomlTable {
  /** The dotted path, quotes removed: `mcp_servers.web`. */
  readonly path: readonly string[];
  /** True for `[[x]]`. */
  readonly array: boolean;
  /** The header's line index, or -1 for the root table. */
  readonly line: number;
  /** The line index after the table's last line. */
  readonly end: number;
  readonly values: Readonly<Record<string, TomlValue>>;
}

function splitDotted(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of text.trim()) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '.') {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts;
}

/** The text of a line up to a comment, ignoring `#` inside strings. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (quote !== null) {
      if (char === '\\' && quote === '"') {
        at += 1;
      } else if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#') {
      return line.slice(0, at);
    }
  }
  return line;
}

function parseValue(raw: string): TomlValue | undefined {
  const text = raw.trim();
  if (text === 'true' || text === 'false') {
    return text === 'true';
  }
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) {
    return Number(text);
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1);
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    const items: TomlValue[] = [];
    let current = '';
    let quote: string | null = null;
    for (const char of text.slice(1, -1)) {
      if (quote !== null) {
        current += char;
        if (char === quote) {
          quote = null;
        }
      } else if (char === '"' || char === "'") {
        quote = char;
        current += char;
      } else if (char === ',') {
        if (current.trim().length > 0) {
          const value = parseValue(current);
          if (value !== undefined) {
            items.push(value);
          }
        }
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim().length > 0) {
      const value = parseValue(current);
      if (value !== undefined) {
        items.push(value);
      }
    }
    return items;
  }
  return undefined;
}

/**
 * The tables of a TOML file, enough of the format to read what Codex keeps there.
 *
 * Deliberately partial: strings, numbers, booleans and arrays of them, including an array spread
 * over several lines. No inline tables and no multi-line strings, which `config.toml` does not use
 * for the keys read here; a value this cannot parse is skipped, never guessed. It reads only:
 * writes go through `codex mcp` or through `setTomlKey`, which edits one line in place so the
 * comments and the marker blocks other tools leave in the file survive.
 */
export function readToml(text: string): TomlTable[] {
  const lines = text.split(/\r?\n/);
  const tables: { path: string[]; array: boolean; line: number; end: number; values: Record<string, TomlValue> }[] = [
    { path: [], array: false, line: -1, end: lines.length, values: {} },
  ];
  let pending: { key: string; text: string } | null = null;
  lines.forEach((rawLine, index) => {
    const line = stripComment(rawLine);
    const current = tables[tables.length - 1];
    if (current === undefined) {
      return;
    }
    if (pending !== null) {
      pending.text += ` ${line.trim()}`;
      const opens = (pending.text.match(/\[/g) ?? []).length;
      const closes = (pending.text.match(/\]/g) ?? []).length;
      if (closes >= opens) {
        const value = parseValue(pending.text);
        if (value !== undefined) {
          current.values[pending.key] = value;
        }
        pending = null;
      }
      return;
    }
    const header = /^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*$/.exec(line);
    if (header !== null) {
      current.end = index;
      tables.push({
        path: splitDotted(header[2] ?? ''),
        array: header[1] === '[[',
        line: index,
        end: lines.length,
        values: {},
      });
      return;
    }
    const pair = /^\s*("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (pair === null) {
      return;
    }
    const key = (pair[1] ?? '').replace(/^["']|["']$/g, '');
    const valueText = (pair[2] ?? '').trim();
    if (valueText.startsWith('[') && (valueText.match(/\[/g) ?? []).length > (valueText.match(/\]/g) ?? []).length) {
      pending = { key, text: valueText };
      return;
    }
    const value = parseValue(valueText);
    if (value !== undefined) {
      current.values[key] = value;
    }
  });
  return tables;
}

function isTomlString(value: TomlValue | undefined): value is string {
  return typeof value === 'string';
}

/** The MCP servers declared in a Codex `config.toml`, with their env values for the main process. */
export function codexMcpServers(
  tables: readonly TomlTable[],
): { name: string; server: StoredMcp; enabled: boolean; bearerEnv: string; line: number }[] {
  const servers = tables.filter((table) => table.path[0] === 'mcp_servers' && table.path.length === 2);
  return servers.map((table) => {
    const name = table.path[1] ?? '';
    const env = tables.find(
      (entry) => entry.path.length === 3 && entry.path[0] === 'mcp_servers' && entry.path[1] === name && entry.path[2] === 'env',
    );
    const envValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(env?.values ?? {})) {
      if (isTomlString(value)) {
        envValues[key] = value;
      }
    }
    const args = table.values['args'];
    const url = table.values['url'];
    const command = table.values['command'];
    return {
      name,
      line: table.line,
      enabled: table.values['enabled'] !== false,
      bearerEnv: isTomlString(table.values['bearer_token_env_var']) ? table.values['bearer_token_env_var'] : '',
      server: {
        transport: isTomlString(url) && !isTomlString(command) ? 'http' : 'stdio',
        command: isTomlString(command) ? command : '',
        args: Array.isArray(args) ? args.filter(isTomlString) : [],
        url: isTomlString(url) ? url : '',
        env: envValues,
        headers: {},
      },
    };
  });
}

/** The hooks of a Codex `config.toml`: `[[hooks.<Event>]]` groups and their `[[…hooks]]` commands. */
export function codexHooks(tables: readonly TomlTable[]): { hook: HookShape; line: number }[] {
  const out: { hook: HookShape; line: number }[] = [];
  const matchers = new Map<string, string>();
  for (const table of tables) {
    if (table.path[0] !== 'hooks' || !table.array) {
      continue;
    }
    const event = table.path[1] ?? '';
    if (table.path.length === 2) {
      matchers.set(event, isTomlString(table.values['matcher']) ? table.values['matcher'] : '');
      const command = table.values['command'];
      if (isTomlString(command)) {
        out.push({ hook: { event, matcher: matchers.get(event) ?? '', command, timeout: null }, line: table.line });
      }
    } else if (table.path.length === 3 && table.path[2] === 'hooks') {
      const command = table.values['command'];
      const timeout = table.values['timeout'];
      if (isTomlString(command)) {
        out.push({
          hook: {
            event,
            matcher: matchers.get(event) ?? '',
            command,
            timeout: typeof timeout === 'number' ? timeout : null,
          },
          line: table.line,
        });
      }
    }
  }
  const root = tables.find((table) => table.path.length === 0);
  const notify = root?.values['notify'];
  if (Array.isArray(notify) && notify.length > 0) {
    out.push({
      hook: { event: 'notify', matcher: '', command: notify.filter(isTomlString).join(' '), timeout: null },
      line: -1,
    });
  }
  return out;
}

function tomlLiteral(value: boolean | number | string): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * Sets one key in one table, touching that line only.
 *
 * Replaces the key's line when the table has it, or inserts it right after the header. Every other
 * byte of the file, comments and line endings included, stays where it was. Answers null when the
 * table is not in the file, rather than appending a table nobody asked for.
 */
export function setTomlKey(
  text: string,
  path: readonly string[],
  key: string,
  value: boolean | number | string,
): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const table = readToml(text).find(
    (entry) => !entry.array && entry.path.length === path.length && entry.path.every((part, at) => part === path[at]),
  );
  if (table === undefined || table.line < 0) {
    return null;
  }
  const keyPattern = new RegExp(`^(\\s*)("${key}"|'${key}'|${key})(\\s*=\\s*)`);
  for (let at = table.line + 1; at < table.end; at += 1) {
    const match = keyPattern.exec(lines[at] ?? '');
    if (match !== null) {
      lines[at] = `${match[1] ?? ''}${key}${match[3] ?? ' = '}${tomlLiteral(value)}`;
      return lines.join(eol);
    }
  }
  lines.splice(table.line + 1, 0, `${key} = ${tomlLiteral(value)}`);
  return lines.join(eol);
}

/* ------------------------------------------------------------- duplicates */

/**
 * Fills `duplicates` on every item whose identity another item of the same agent and kind shares.
 *
 * The same skill reached through a junction and through its project folder, the same hook pasted
 * into two settings files, the same server name in two scopes: each is shown once per place it is
 * declared, which is the truth, with the other places named so the reader sees it is one thing.
 */
export function markDuplicates(items: readonly ExtensionItem[]): ExtensionItem[] {
  const groups = new Map<string, ExtensionItem[]>();
  for (const item of items) {
    const key = `${item.agent}|${item.kind}|${item.identity}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return items.map((item) => {
    const same = groups.get(`${item.agent}|${item.kind}|${item.identity}`) ?? [];
    const others = same.filter((entry) => entry.id !== item.id).map((entry) => entry.scopeLabel);
    return others.length === 0 ? item : { ...item, duplicates: [...new Set(others)] };
  });
}

/** How many items of a kind, for the rail. */
export function countByKind(
  items: readonly ExtensionItem[],
  agent: ExtensionAgent,
): Record<ExtensionKind, number> {
  const counts: Record<ExtensionKind, number> = { hooks: 0, skills: 0, plugins: 0, mcp: 0, routines: 0 };
  for (const item of items) {
    if (item.agent === agent) {
      counts[item.kind] += 1;
    }
  }
  return counts;
}

/* ------------------------------------------------------------ validation */

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function scopeOf(value: unknown): WritableScope | null {
  return value === 'user' || value === 'project' || value === 'local' ? value : null;
}

function pairs(value: unknown): { name: string; value: string }[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: { name: string; value: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry['name'] !== 'string' || typeof entry['value'] !== 'string') {
      return null;
    }
    out.push({ name: entry['name'], value: entry['value'] });
  }
  return out;
}

function readDraft(value: unknown): McpDraft | null {
  if (!isRecord(value)) {
    return null;
  }
  const transport = value['transport'];
  const env = pairs(value['env']);
  const headers = pairs(value['headers']);
  const args = Array.isArray(value['args']) && value['args'].every((arg) => typeof arg === 'string')
    ? (value['args'] as string[])
    : null;
  const command = str(value['command']);
  const url = str(value['url']);
  const bearerEnv = str(value['bearerEnv']);
  if (
    (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') ||
    env === null ||
    headers === null ||
    args === null ||
    command === null ||
    url === null ||
    bearerEnv === null
  ) {
    return null;
  }
  return { transport, command, args, url, env, headers, bearerEnv };
}

/**
 * An action as the renderer sent it, or null.
 *
 * The IPC boundary is untyped at runtime, so every field is checked here once and the service only
 * ever sees a well-formed action.
 */
export function readExtensionAction(value: unknown): ExtensionAction | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = value['type'];
  const projectId = value['projectId'] === null ? null : str(value['projectId']);
  if (type === 'toggle' || type === 'remove' || type === 'open' || type === 'reveal' || type === 'run') {
    const id = str(value['id']);
    return id === null ? null : { type, id };
  }
  if (type === 'schedule-session') {
    const id = value['id'] === null ? null : str(value['id']);
    return value['id'] !== null && id === null ? null : { type, id };
  }
  if (type === 'save-mcp') {
    const agent = value['agent'];
    const scope = scopeOf(value['scope']);
    const name = str(value['name']);
    const draft = readDraft(value['draft']);
    const id = value['id'] === null ? null : str(value['id']);
    if ((agent !== 'claude' && agent !== 'codex') || scope === null || name === null || draft === null) {
      return null;
    }
    if (value['id'] !== null && id === null) {
      return null;
    }
    return { type, id, agent, scope, projectId, name: name.trim(), draft };
  }
  if (type === 'save-hook') {
    const scope = scopeOf(value['scope']);
    const hook = value['hook'];
    const id = value['id'] === null ? null : str(value['id']);
    if (scope === null || !isRecord(hook) || (value['id'] !== null && id === null)) {
      return null;
    }
    const event = str(hook['event']);
    const matcher = str(hook['matcher']);
    const command = str(hook['command']);
    const timeout = hook['timeout'] === null ? null : typeof hook['timeout'] === 'number' ? hook['timeout'] : undefined;
    if (event === null || matcher === null || command === null || timeout === undefined) {
      return null;
    }
    return { type, id, scope, projectId, hook: { event, matcher, command, timeout } };
  }
  if (type === 'add-skill') {
    const agent = value['agent'];
    const scope = value['scope'];
    const name = str(value['name']);
    const description = str(value['description']);
    if (
      (agent !== 'claude' && agent !== 'codex') ||
      (scope !== 'user' && scope !== 'project') ||
      name === null ||
      description === null
    ) {
      return null;
    }
    return { type, agent, scope, projectId, name: name.trim(), description };
  }
  if (type === 'install-plugin') {
    const plugin = str(value['plugin']);
    const scope = scopeOf(value['scope']);
    return plugin === null || scope === null ? null : { type, plugin: plugin.trim(), scope, projectId };
  }
  return null;
}

/* --------------------------------------------------------------- routines */

/**
 * A routine as this app keeps it: a whitelist of the API's fields, and nothing else.
 *
 * ⚠️ Never the prompt, the job configuration or the session request. Those are the routine's
 * instructions, and the API returns them verbatim, which means whatever the author pasted into
 * them: a webhook URL, a token, a private address. They stay inside the one response that carried
 * them, are never written to disk and never reach the renderer.
 */
export interface RoutineSummary {
  readonly id: string;
  readonly name: string;
  readonly cron: string;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  readonly lastFiredAt: string | null;
  readonly lastStatus: string | null;
  readonly lastFailure: string | null;
  readonly lastSessionId: string | null;
  readonly model: string | null;
  /** Why the server stopped it, when it did. */
  readonly stopped: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * An API enum as words: `ROUTINE_RUN_STATUS_SUCCEEDED` reads `succeeded`.
 *
 * `…_UNSPECIFIED` is the enum's way of saying there is nothing, so it answers null rather than
 * putting "unspecified" on screen as if a failure had a reason.
 */
export function presentEnum(value: unknown): string | null {
  const raw = text(value);
  if (raw === null || !/^[A-Z0-9_]+$/.test(raw)) {
    return raw;
  }
  const tail = raw.replace(/^.*?_(STATUS|REASON|STATE)_/, '');
  return tail === 'UNSPECIFIED' ? null : tail.toLowerCase().replace(/_/g, ' ');
}

/** One trigger object of the API, reduced to the whitelist. Null without a usable id. */
export function readRoutine(value: unknown): RoutineSummary | null {
  if (!isRecord(value) || typeof value['id'] !== 'string' || !/^[\w-]+$/.test(value['id'])) {
    return null;
  }
  const last = isRecord(value['last_run']) ? value['last_run'] : {};
  const state = isRecord(value['derived_state']) ? value['derived_state'] : {};
  return {
    id: value['id'],
    name: text(value['name']) ?? value['id'],
    cron: text(value['cron_expression']) ?? '',
    enabled: value['enabled'] === true,
    nextRunAt: text(value['next_run_at']),
    lastFiredAt: text(value['last_fired_at']),
    lastStatus: presentEnum(last['status']),
    lastFailure: presentEnum(last['failure_reason']),
    lastSessionId: text(last['session_id']),
    model: text(state['model']),
    stopped: presentEnum(value['suspension_reason']) ?? presentEnum(value['ended_reason']),
  };
}

/** The routines of a `list` answer. */
export function readRoutineList(body: unknown): RoutineSummary[] {
  const data = isRecord(body) && Array.isArray(body['data']) ? body['data'] : [];
  return data.flatMap((entry: unknown) => {
    const routine = readRoutine(entry);
    return routine === null ? [] : [routine];
  });
}

/**
 * The status and body of a RemoteTrigger tool result: `HTTP 200` on the first line, JSON after.
 *
 * Null for anything else, so a tool that changed its output is a visible failure rather than a
 * list read as empty.
 */
export function parseTriggerResult(result: string): { status: number; body: unknown } | null {
  const match = /^\s*HTTP (\d{3})\s*\r?\n([\s\S]*)$/.exec(result);
  if (match === null) {
    return null;
  }
  try {
    return { status: Number(match[1]), body: JSON.parse(match[2] ?? '') as unknown };
  } catch {
    return { status: Number(match[1]), body: null };
  }
}

/**
 * The text of every tool result in a `stream-json` transcript.
 *
 * Read from the transcript and not from the model's answer: the model is asked to call the tool and
 * say OK, so the data is the API's own bytes rather than a copy a model typed out, which was ten
 * times slower and a chance for it to get a field wrong.
 */
export function toolResults(transcript: string): string[] {
  const out: string[] = [];
  for (const line of transcript.split(/\r?\n/)) {
    if (!line.startsWith('{')) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event) || event['type'] !== 'user' || !isRecord(event['message'])) {
      continue;
    }
    const content = event['message']['content'];
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!isRecord(part) || part['type'] !== 'tool_result') {
        continue;
      }
      const value = part['content'];
      if (typeof value === 'string') {
        out.push(value);
      } else if (Array.isArray(value)) {
        out.push(
          value.map((piece) => (isRecord(piece) && typeof piece['text'] === 'string' ? piece['text'] : '')).join(''),
        );
      }
    }
  }
  return out;
}

/**
 * The browser link of a routine's last run.
 *
 * Only for a `session_` id, the form claude.ai/code addresses; any other id gets no link rather
 * than one that might lead nowhere.
 */
export function routineRunLink(sessionId: string | null): string | null {
  return sessionId !== null && /^session_[\w-]+$/.test(sessionId) ? `https://claude.ai/code/${sessionId}` : null;
}

/** The routines as rows of the tab. */
export function routineItems(routines: readonly RoutineSummary[]): ExtensionItem[] {
  return routines.map((routine) => {
    const facts: ExtensionFact[] = [
      { label: 'Schedule', value: routine.cron.length > 0 ? `${routine.cron} (UTC)` : 'none', mono: true },
    ];
    const add = (label: string, value: string | null, mono = false): void => {
      if (value !== null) {
        facts.push({ label, value, mono });
      }
    };
    add('Next run', routine.nextRunAt);
    add('Last run', routine.lastFiredAt);
    add('Last result', routine.lastStatus);
    add('Last failure', routine.lastFailure);
    add('Model', routine.model, true);
    add('Stopped', routine.stopped);
    const link = routineRunLink(routine.lastSessionId);
    const verbs: ExtensionVerb[] = ['toggle', 'run', 'edit'];
    if (link !== null) {
      verbs.push('open');
    }
    return {
      id: `claude:routine:${routine.id}`,
      agent: 'claude',
      kind: 'routines',
      name: routine.name,
      description: routine.cron,
      scope: 'claude.ai',
      scopeLabel: 'claude.ai',
      projectId: null,
      enabled: routine.enabled,
      facts,
      file: null,
      folder: null,
      link,
      readOnly: null,
      verbs,
      duplicates: [],
      identity: routine.id,
      mcp: null,
      hook: null,
    };
  });
}

/**
 * A line safe inside double quotes in bash, PowerShell and cmd alike.
 *
 * A routine name rides into the `/schedule` prompt of a terminal tab, through whichever shell
 * profile runs it, so whatever those three expand inside quotes is dropped rather than escaped
 * three different ways.
 */
export function shellSafeText(value: string): string {
  return value.replace(/["`$%!\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}
