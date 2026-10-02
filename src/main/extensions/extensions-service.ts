import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  addHook,
  claudeMcpJson,
  codexAddArgs,
  draftProblem,
  isValidName,
  isValidPluginId,
  parseMcpList,
  readRoutine,
  readRoutineList,
  removeHook,
  replaceHook,
  resolveDraft,
  routineItems,
  setTomlKey,
  skillSkeleton,
  type AgentStatus,
  type ExtensionAction,
  type ExtensionItem,
  type ExtensionsResult,
  type ExtensionsView,
  type HookShape,
  type RoutineSummary,
  type StoredMcp,
  type WritableScope,
} from '@shared/extensions.js';
import { resolveCommand, runCli, versionOf } from './agent-cli.js';
import { callTrigger } from './routines.js';
import { readExtensions, type ExtensionRef, type ReadOutcome, type ReaderProject } from './extensions-reader.js';

/** A question asked in the main process before anything destructive. */
export type Confirm = (ask: {
  title: string;
  message: string;
  detail: string;
  confirmLabel: string;
}) => Promise<boolean>;

export interface ExtensionsDependencies {
  readonly home: string;
  readonly projects: () => readonly ReaderProject[];
  readonly commands: () => { claude: string; codex: string };
  readonly openPath: (path: string) => Promise<string>;
  readonly showItemInFolder: (path: string) => void;
  readonly trashItem: (path: string) => Promise<void>;
  readonly openExternal: (url: string) => Promise<void>;
  /** Where the last routine list is kept between launches. */
  readonly routinesFile: string;
}

export interface AvailablePlugin {
  readonly id: string;
  readonly description: string;
}

class Refusal extends Error {}

/**
 * The Extensions tab's main-process half: one read of both agents, and every change to them.
 *
 * The last read is kept because it is the only thing an action may act on. The renderer names an
 * item by its id and nothing else, so what gets removed, toggled or rewritten is always what this
 * process itself found on disk, never a path or a command line handed over from the page.
 */
export class ExtensionsService {
  private last: ReadOutcome | null = null;
  private statuses: Record<string, string> | null = null;
  private routines: RoutineSummary[] = [];
  private routinesReadAt: string | null = null;
  private routinesError: string | null = null;
  private routinesLoaded = false;

  constructor(private readonly deps: ExtensionsDependencies) {}

  async read(): Promise<ExtensionsView> {
    const projects = this.deps.projects();
    const [outcome, agents] = await Promise.all([
      readExtensions(this.deps.home, projects, this.statuses),
      this.agentStatuses(),
    ]);
    await this.loadRoutines();
    const routines = routineItems(this.routines);
    for (const routine of this.routines) {
      outcome.refs.set(`claude:routine:${routine.id}`, { type: 'routine', id: routine.id });
    }
    this.last = { ...outcome, items: [...outcome.items, ...routines] };
    return {
      readAt: new Date().toISOString(),
      agents,
      items: this.last.items,
      projects: projects.map((project) => ({ id: project.id, label: project.label })),
      statuses: this.statuses,
      problems: outcome.problems,
      routines: { readAt: this.routinesReadAt, error: this.routinesError },
    };
  }

  /**
   * Reads the routines from claude.ai, on request only.
   *
   * A few seconds and a model call each time, so never on the tab being shown: the last answer is
   * kept on disk with its date, and the tab says how old it is.
   */
  async readRoutines(): Promise<ExtensionsResult> {
    const answer = await callTrigger(this.deps.commands().claude, { action: 'list' });
    if (answer.ok) {
      this.routines = readRoutineList(answer.body);
      this.routinesReadAt = new Date().toISOString();
      this.routinesError = null;
      await this.saveRoutines();
    } else {
      this.routinesError = answer.message;
    }
    return {
      ok: answer.ok,
      message: answer.ok ? `Read ${this.routines.length} routine(s) from claude.ai` : answer.message,
      view: await this.read(),
    };
  }

  /** The name of a listed routine, for the `/schedule` prompt of an edit. */
  routineName(id: string): string | null {
    const ref = this.last?.refs.get(id);
    if (ref?.type !== 'routine') {
      return null;
    }
    return this.routines.find((routine) => routine.id === ref.id)?.name ?? null;
  }

  private async loadRoutines(): Promise<void> {
    if (this.routinesLoaded) {
      return;
    }
    this.routinesLoaded = true;
    try {
      const stored = JSON.parse(await readFile(this.deps.routinesFile, 'utf8')) as unknown;
      if (typeof stored === 'object' && stored !== null) {
        const record = stored as Record<string, unknown>;
        // Through the same whitelist as a fresh answer, so a hand-edited file cannot add a field.
        this.routines = Array.isArray(record['routines'])
          ? record['routines'].flatMap((entry: unknown) => {
              const routine = readRoutine(entry);
              return routine === null ? [] : [routine];
            })
          : [];
        this.routinesReadAt = typeof record['readAt'] === 'string' ? record['readAt'] : null;
      }
    } catch {
      this.routines = [];
    }
  }

  private async saveRoutines(): Promise<void> {
    await mkdir(dirname(this.deps.routinesFile), { recursive: true });
    const temp = `${this.deps.routinesFile}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ readAt: this.routinesReadAt, routines: this.routines }, null, 2), 'utf8');
    await rename(temp, this.deps.routinesFile);
  }

  /** Replaces one routine in the kept list with what the server answered about it. */
  private async storeRoutine(routine: RoutineSummary): Promise<void> {
    this.routines = this.routines.map((entry) => (entry.id === routine.id ? routine : entry));
    await this.saveRoutines();
  }

  /**
   * Asks Claude Code for the status of every server, claude.ai connectors included.
   *
   * On request only: `claude mcp list` starts every server to check it, which takes seconds and
   * launches processes, and the claude.ai connectors exist nowhere else on this machine.
   */
  async check(): Promise<ExtensionsResult> {
    const result = await runCli(this.deps.commands().claude, ['mcp', 'list'], { timeout: 120_000 });
    if (result.ok) {
      this.statuses = Object.fromEntries(parseMcpList(result.stdout).map((entry) => [entry.name, entry.status]));
    }
    return {
      ok: result.ok,
      message: result.ok ? 'Status checked' : result.message,
      view: await this.read(),
    };
  }

  /** The plugins the configured marketplaces offer, most installed first. */
  async available(): Promise<AvailablePlugin[]> {
    const result = await runCli(this.deps.commands().claude, ['plugin', 'list', '--json', '--available'], {
      timeout: 120_000,
    });
    if (!result.ok) {
      return [];
    }
    try {
      const parsed = JSON.parse(result.stdout) as { available?: unknown };
      const list = Array.isArray(parsed.available) ? parsed.available : [];
      return list
        .flatMap((entry: unknown) => {
          if (typeof entry !== 'object' || entry === null) {
            return [];
          }
          const record = entry as Record<string, unknown>;
          return typeof record['pluginId'] === 'string'
            ? [
                {
                  id: record['pluginId'],
                  description: typeof record['description'] === 'string' ? record['description'] : '',
                  count: typeof record['installCount'] === 'number' ? record['installCount'] : 0,
                },
              ]
            : [];
        })
        .sort((left, right) => right.count - left.count)
        .map(({ id, description }) => ({ id, description }));
    } catch {
      return [];
    }
  }

  async act(action: ExtensionAction, confirm: Confirm): Promise<ExtensionsResult> {
    let message: string;
    let ok = true;
    try {
      message = await this.perform(action, confirm);
    } catch (error) {
      ok = false;
      message = error instanceof Error ? error.message : String(error);
    }
    return { ok, message, view: await this.read() };
  }

  /* -------------------------------------------------------------- dispatch */

  private async perform(action: ExtensionAction, confirm: Confirm): Promise<string> {
    switch (action.type) {
      case 'open':
      case 'reveal':
      case 'toggle':
      case 'run':
      case 'remove': {
        const { item, ref } = this.lookup(action.id);
        if (action.type === 'open') {
          return this.open(item);
        }
        if (action.type === 'run') {
          return this.runRoutine(item, ref, confirm);
        }
        if (action.type === 'reveal') {
          const target = item.file ?? item.folder;
          if (target === null) {
            throw new Refusal('Nothing on disk to show for this entry');
          }
          this.deps.showItemInFolder(target);
          return '';
        }
        if (item.readOnly !== null) {
          throw new Refusal(item.readOnly);
        }
        return action.type === 'toggle' ? this.toggle(item, ref) : this.remove(item, ref, confirm);
      }
      case 'save-mcp':
        return this.saveMcp(action);
      case 'save-hook':
        return this.saveHook(action);
      case 'add-skill':
        return this.addSkill(action);
      case 'install-plugin':
        return this.installPlugin(action);
      case 'schedule-session':
        // Opened by the IPC layer, which owns the terminals. Reaching here is a wiring mistake.
        throw new Refusal('A schedule session is opened by the window, not by this service');
    }
  }

  private lookup(id: string): { item: ExtensionItem; ref: ExtensionRef } {
    const item = this.last?.items.find((entry) => entry.id === id);
    const ref = this.last?.refs.get(id);
    if (item === undefined || ref === undefined) {
      throw new Refusal('That entry is no longer there. The list has been read again');
    }
    return { item, ref };
  }

  private projectPath(projectId: string | null): string {
    const project = this.deps.projects().find((entry) => entry.id === projectId);
    if (project === undefined) {
      throw new Refusal('Pick a project for that scope');
    }
    return project.path;
  }

  private async open(item: ExtensionItem): Promise<string> {
    if (item.link !== null) {
      await this.deps.openExternal(item.link);
      return '';
    }
    const target = item.file ?? item.folder;
    if (target === null) {
      throw new Refusal('Nothing on disk to open for this entry');
    }
    const problem = await this.deps.openPath(target);
    if (problem.length > 0) {
      throw new Refusal(problem);
    }
    return '';
  }

  /* -------------------------------------------------------------- toggling */

  private async toggle(item: ExtensionItem, ref: ExtensionRef): Promise<string> {
    if (ref.type === 'claude-plugin') {
      const verb = item.enabled === true ? 'disable' : 'enable';
      await this.claude(['plugin', verb, ref.plugin, '-s', ref.scope], ref.cwd);
      return `${verb === 'enable' ? 'Enabled' : 'Disabled'} ${ref.plugin}. Restart the agent to apply it`;
    }
    if (ref.type === 'codex-mcp') {
      const next = item.enabled !== true;
      await this.rewrite(ref.file, (text) => {
        const edited = setTomlKey(text, ['mcp_servers', ref.name], 'enabled', next);
        if (edited === null) {
          throw new Refusal(`[mcp_servers.${ref.name}] is no longer in ${ref.file}`);
        }
        return edited;
      });
      return `${next ? 'Enabled' : 'Disabled'} ${ref.name} for Codex`;
    }
    if (ref.type === 'routine') {
      const next = item.enabled !== true;
      const answer = await callTrigger(this.deps.commands().claude, { action: 'update', id: ref.id, enabled: next });
      if (!answer.ok) {
        throw new Refusal(answer.message);
      }
      // Checked on the server's answer rather than assumed from the request: a model sat between
      // the click and the call, and the state shown has to be the one claude.ai holds.
      const routine = readRoutine(answer.body);
      if (routine === null || routine.enabled !== next) {
        throw new Refusal('claude.ai did not confirm the change. Read the routines again to see where it stands');
      }
      await this.storeRoutine(routine);
      return `${next ? 'Resumed' : 'Paused'} ${routine.name}`;
    }
    throw new Refusal('This entry has no on/off switch');
  }

  private async runRoutine(item: ExtensionItem, ref: ExtensionRef, confirm: Confirm): Promise<string> {
    if (ref.type !== 'routine') {
      throw new Refusal('Only a routine can be run from here');
    }
    const ok = await confirm({
      title: 'Run this routine now',
      message: `Run ${item.name} now?`,
      detail: 'It runs on claude.ai as on a scheduled fire, with everything it does: messages it sends, branches it pushes.',
      confirmLabel: 'Run',
    });
    if (!ok) {
      return 'Nothing was run';
    }
    const answer = await callTrigger(this.deps.commands().claude, { action: 'run', id: ref.id });
    if (!answer.ok) {
      throw new Refusal(answer.message);
    }
    return `Started ${item.name} on claude.ai. Read the routines again for its result`;
  }

  /* -------------------------------------------------------------- removing */

  private async remove(item: ExtensionItem, ref: ExtensionRef, confirm: Confirm): Promise<string> {
    switch (ref.type) {
      case 'claude-hook': {
        const ok = await confirm({
          title: 'Remove this hook',
          message: `Remove the ${ref.location.event} hook?`,
          detail: `${item.name}\n\nFrom ${ref.file}. Sessions started afterwards no longer run it.`,
          confirmLabel: 'Remove',
        });
        if (!ok) {
          return 'Nothing was removed';
        }
        await this.rewriteJson(ref.file, (settings) => removeHook(settings, ref.location));
        return `Removed the ${ref.location.event} hook`;
      }
      case 'skill': {
        const ok = await confirm({
          title: 'Remove this skill',
          message: `Remove the ${item.name} skill?`,
          detail: ref.link
            ? `Only the link ${ref.dir} is removed. The folder it points to is kept.`
            : `The folder ${ref.dir} goes to the Recycle Bin.`,
          confirmLabel: 'Remove',
        });
        if (!ok) {
          return 'Nothing was removed';
        }
        if (ref.link) {
          // `unlink` on a junction removes the link and never follows it; a recursive delete would
          // empty the folder it points to, which is the source the link exists to share.
          await unlink(ref.dir);
        } else {
          await this.deps.trashItem(ref.dir);
        }
        return `Removed ${item.name}`;
      }
      case 'claude-plugin': {
        const ok = await confirm({
          title: 'Uninstall this plugin',
          message: `Uninstall ${ref.plugin}?`,
          detail: `Runs claude plugin uninstall in the ${ref.scope} scope. Its data folder is kept.`,
          confirmLabel: 'Uninstall',
        });
        if (!ok) {
          return 'Nothing was uninstalled';
        }
        await this.claude(['plugin', 'uninstall', ref.plugin, '-s', ref.scope, '--keep-data'], ref.cwd);
        return `Uninstalled ${ref.plugin}`;
      }
      case 'claude-mcp': {
        const ok = await confirm({
          title: 'Remove this MCP server',
          message: `Remove ${ref.name} from Claude Code?`,
          detail: `Runs claude mcp remove in the ${ref.scope} scope.`,
          confirmLabel: 'Remove',
        });
        if (!ok) {
          return 'Nothing was removed';
        }
        await this.claude(['mcp', 'remove', ref.name, '-s', ref.scope], ref.cwd);
        return `Removed ${ref.name}`;
      }
      case 'codex-mcp': {
        const ok = await confirm({
          title: 'Remove this MCP server',
          message: `Remove ${ref.name} from Codex?`,
          detail: 'Runs codex mcp remove, which edits ~/.codex/config.toml.',
          confirmLabel: 'Remove',
        });
        if (!ok) {
          return 'Nothing was removed';
        }
        await this.codex(['mcp', 'remove', ref.name]);
        return `Removed ${ref.name}`;
      }
      case 'routine':
        throw new Refusal('A routine is deleted on claude.ai: the API offers no removal');
      case 'read-only':
        throw new Refusal(item.readOnly ?? 'This entry cannot be removed from here');
    }
  }

  /* ------------------------------------------------------------------- mcp */

  private async saveMcp(action: Extract<ExtensionAction, { type: 'save-mcp' }>): Promise<string> {
    if (!isValidName(action.name)) {
      throw new Refusal('A server name is letters, digits, dot, dash and underscore');
    }
    const previous = action.id === null ? null : this.lookup(action.id).ref;
    if (previous !== null && previous.type !== 'claude-mcp' && previous.type !== 'codex-mcp') {
      throw new Refusal('That entry is not an MCP server');
    }
    const stored: StoredMcp | null = previous?.server ?? null;
    const server = resolveDraft(action.draft, stored);
    const problem = draftProblem(server, action.agent);
    if (problem !== null) {
      throw new Refusal(problem);
    }

    if (action.agent === 'codex') {
      const bearer = action.draft.bearerEnv.trim();
      if (bearer.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearer)) {
        throw new Refusal('The token variable is a plain environment variable name');
      }
      if (previous?.type === 'codex-mcp') {
        await this.codex(['mcp', 'remove', previous.name]);
        try {
          await this.codex(codexAddArgs(action.name, server, bearer));
        } catch (error) {
          await this.codex(codexAddArgs(previous.name, previous.server, previous.bearerEnv)).catch(() => undefined);
          throw error;
        }
        return `Saved ${action.name} for Codex`;
      }
      await this.codex(codexAddArgs(action.name, server, bearer));
      return `Added ${action.name} to Codex`;
    }

    const cwd = action.scope === 'user' ? null : this.projectPath(action.projectId);
    if (previous?.type === 'claude-mcp') {
      await this.claude(['mcp', 'remove', previous.name, '-s', previous.scope], previous.cwd);
      try {
        await this.claude(['mcp', 'add-json', action.name, claudeMcpJson(server), '-s', action.scope], cwd);
      } catch (error) {
        // Put the old one back: an edit that fails halfway must not lose the server it was editing.
        await this.claude(
          ['mcp', 'add-json', previous.name, claudeMcpJson(previous.server), '-s', previous.scope],
          previous.cwd,
        ).catch(() => undefined);
        throw error;
      }
      return `Saved ${action.name}`;
    }
    await this.claude(['mcp', 'add-json', action.name, claudeMcpJson(server), '-s', action.scope], cwd);
    return `Added ${action.name}`;
  }

  /* ----------------------------------------------------------------- hooks */

  private settingsFile(scope: WritableScope, projectId: string | null): string {
    if (scope === 'user') {
      return join(this.deps.home, '.claude', 'settings.json');
    }
    return join(
      this.projectPath(projectId),
      '.claude',
      scope === 'project' ? 'settings.json' : 'settings.local.json',
    );
  }

  private async saveHook(action: Extract<ExtensionAction, { type: 'save-hook' }>): Promise<string> {
    const hook: HookShape = {
      event: action.hook.event.trim(),
      matcher: action.hook.matcher.trim(),
      command: action.hook.command.trim(),
      timeout: action.hook.timeout,
    };
    if (!/^[A-Za-z]+$/.test(hook.event)) {
      throw new Refusal('Pick the event the hook runs on');
    }
    if (hook.command.length === 0) {
      throw new Refusal('A hook needs a command');
    }
    if (hook.timeout !== null && (!Number.isInteger(hook.timeout) || hook.timeout <= 0)) {
      throw new Refusal('The timeout is a whole number of seconds');
    }
    const file = this.settingsFile(action.scope, action.projectId);
    if (action.id === null) {
      await this.rewriteJson(file, (settings) => addHook(settings, hook));
      return `Added a ${hook.event} hook`;
    }
    const { ref } = this.lookup(action.id);
    if (ref.type !== 'claude-hook') {
      throw new Refusal('That entry is not a Claude Code hook');
    }
    if (ref.file === file) {
      await this.rewriteJson(file, (settings) => replaceHook(settings, ref.location, hook));
    } else {
      // Moved to another scope: written to its new file first, so a failure there leaves the old one.
      await this.rewriteJson(file, (settings) => addHook(settings, hook));
      await this.rewriteJson(ref.file, (settings) => removeHook(settings, ref.location));
    }
    return `Saved the ${hook.event} hook`;
  }

  /* ---------------------------------------------------------------- skills */

  private async addSkill(action: Extract<ExtensionAction, { type: 'add-skill' }>): Promise<string> {
    if (!isValidName(action.name)) {
      throw new Refusal('A skill name is letters, digits, dot, dash and underscore');
    }
    const root =
      action.agent === 'codex'
        ? join(this.deps.home, '.codex', 'skills')
        : action.scope === 'user'
          ? join(this.deps.home, '.claude', 'skills')
          : join(this.projectPath(action.projectId), '.claude', 'skills');
    const dir = join(root, action.name);
    const exists = await stat(dir).then(
      () => true,
      () => false,
    );
    if (exists) {
      throw new Refusal(`${dir} already exists`);
    }
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    await writeFile(file, skillSkeleton(action.name, action.description), { flag: 'wx' });
    await this.deps.openPath(file);
    return `Created ${action.name}. Its SKILL.md is open in your editor`;
  }

  /* --------------------------------------------------------------- plugins */

  private async installPlugin(action: Extract<ExtensionAction, { type: 'install-plugin' }>): Promise<string> {
    if (!isValidPluginId(action.plugin)) {
      throw new Refusal('A plugin is named name@marketplace');
    }
    const cwd = action.scope === 'user' ? null : this.projectPath(action.projectId);
    await this.claude(['plugin', 'install', action.plugin, '-s', action.scope], cwd, 300_000);
    return `Installed ${action.plugin}. Restart the agent to load it`;
  }

  /* ----------------------------------------------------------------- tools */

  private async claude(args: readonly string[], cwd: string | null, timeout = 90_000): Promise<string> {
    const result = await runCli(this.deps.commands().claude, args, {
      timeout,
      ...(cwd === null ? {} : { cwd }),
    });
    if (!result.ok) {
      throw new Refusal(result.message);
    }
    return result.stdout;
  }

  private async codex(args: readonly string[]): Promise<string> {
    const result = await runCli(this.deps.commands().codex, args, { timeout: 90_000 });
    if (!result.ok) {
      throw new Refusal(result.message);
    }
    return result.stdout;
  }

  /**
   * Rewrites a file the agents also write, refusing if it moved since the list was read.
   *
   * The modification time recorded at the read is the version the reader was looking at. A file
   * changed since then, by a running session or by hand, is refused rather than overwritten with a
   * change computed on its old content. Written to a sibling and renamed over, so a crash midway
   * leaves the old file and never half of the new one.
   */
  private async rewrite(file: string, edit: (text: string) => string): Promise<void> {
    const seen = this.last?.mtimes.get(file);
    const now = await stat(file).then(
      (info) => info.mtimeMs,
      () => undefined,
    );
    if (seen !== now) {
      throw new Refusal(`${file} changed since it was read. The list has been read again: try once more`);
    }
    const text = now === undefined ? '' : await readFile(file, 'utf8');
    const next = edit(text);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, next, 'utf8');
    await rename(temp, file);
  }

  private async rewriteJson(file: string, edit: (settings: unknown) => Record<string, unknown>): Promise<void> {
    await this.rewrite(file, (text) => {
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      let parsed: unknown = {};
      if (text.trim().length > 0) {
        try {
          parsed = JSON.parse(text.replace(/^﻿/, '')) as unknown;
        } catch {
          throw new Refusal(`${file} is not valid JSON, so it is left alone`);
        }
      }
      return `${JSON.stringify(edit(parsed), null, 2).replace(/\n/g, eol)}${eol}`;
    });
  }

  private async agentStatuses(): Promise<AgentStatus[]> {
    const commands = this.deps.commands();
    const one = async (agent: 'claude' | 'codex', label: string, command: string): Promise<AgentStatus> => {
      const target = await resolveCommand(command);
      const version = target === null ? null : await versionOf(command);
      return {
        agent,
        label,
        command,
        resolved: target?.file ?? null,
        version,
        problem:
          target === null
            ? `${command} was not found. Reading works, changes need its path in Settings`
            : version === null
              ? `${command} did not answer --version`
              : null,
      };
    };
    return Promise.all([
      one('claude', 'Claude Code', commands.claude),
      one('codex', 'Codex', commands.codex),
    ]);
  }
}
