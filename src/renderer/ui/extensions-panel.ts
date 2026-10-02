import {
  CLAUDE_HOOK_EVENTS,
  EXTENSION_AGENTS,
  EXTENSION_KINDS,
  countByKind,
  type ExtensionAction,
  type ExtensionAgent,
  type ExtensionItem,
  type ExtensionKind,
  type ExtensionsResult,
  type ExtensionsView,
  type ExtensionVerb,
  type McpTransport,
  type WritableScope,
} from '@shared/extensions.js';
import { showContextMenu, type MenuItem } from './context-menu.js';
import { clearChildren, createElement } from './dom.js';

/**
 * The Extensions tab: hooks, skills, plugins and MCP servers of Claude Code and Codex.
 *
 * A class that owns its state, like the board, rather than a render function fed by `main.ts`:
 * nothing else in the app reads this tab's selection or its forms, and the only outside event is
 * the tab being shown. Every change goes through `actOnExtension`, whose answer carries the list as
 * read again afterwards, so what is on screen is always what is on disk now.
 */

const KIND_LABELS: Record<ExtensionKind, string> = {
  hooks: 'Hooks',
  skills: 'Skills',
  plugins: 'Plugins',
  mcp: 'MCP servers',
  routines: 'Routines',
};

const VERB_LABELS: Record<ExtensionVerb, string> = {
  toggle: 'Enable',
  edit: 'Edit',
  remove: 'Remove',
  open: 'Open file',
  reveal: 'Show in folder',
  run: 'Run now',
};

/** The label of one verb on one item, where the kind changes what the verb means. */
export function verbLabel(item: ExtensionItem, verb: ExtensionVerb): string {
  if (verb === 'toggle') {
    return toggleLabel(item);
  }
  if (item.kind === 'routines') {
    if (verb === 'edit') {
      return 'Change in a terminal';
    }
    if (verb === 'open') {
      return 'Open last run';
    }
  }
  return VERB_LABELS[verb];
}

/** How long ago an ISO date was, in the coarsest unit that is still true. */
export function describeSince(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '';
  }
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

type Form =
  | {
      kind: 'mcp';
      id: string | null;
      agent: ExtensionAgent;
      name: string;
      scope: WritableScope;
      projectId: string | null;
      transport: McpTransport;
      command: string;
      args: string;
      url: string;
      env: { name: string; value: string; stored: boolean }[];
      headers: { name: string; value: string; stored: boolean }[];
      bearerEnv: string;
    }
  | {
      kind: 'hook';
      id: string | null;
      scope: WritableScope;
      projectId: string | null;
      event: string;
      matcher: string;
      command: string;
      timeout: string;
    }
  | {
      kind: 'skill';
      agent: ExtensionAgent;
      scope: 'user' | 'project';
      projectId: string | null;
      name: string;
      description: string;
    }
  | { kind: 'plugin'; plugin: string; scope: WritableScope; projectId: string | null };

/** Whether an item matches the filter typed in the bar: name, description or scope. */
export function matchesFilter(item: ExtensionItem, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return [item.name, item.description, item.scopeLabel].some((text) => text.toLowerCase().includes(needle));
}

/** The label of the toggle verb for an item's current state. */
export function toggleLabel(item: ExtensionItem): string {
  if (item.kind === 'routines') {
    return item.enabled === true ? 'Pause' : 'Resume';
  }
  return item.enabled === true ? 'Disable' : 'Enable';
}

export class ExtensionsPanel {
  private view: ExtensionsView | null = null;
  private agent: ExtensionAgent = 'claude';
  private kind: ExtensionKind = 'mcp';
  private selected: string | null = null;
  private filter = '';
  private form: Form | null = null;
  private formError = '';
  private busy = false;
  private available: { id: string; description: string }[] = [];

  private readonly rail: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly list: HTMLElement;
  private readonly detail: HTMLElement;

  constructor(
    host: HTMLElement,
    private readonly stamp: (message: string) => void,
  ) {
    this.rail = createElement('div', { className: 'pulls__repos extensions__rail' });
    const main = createElement('div', { className: 'pulls__main' });
    this.bar = createElement('div', { className: 'pulls__bar' });
    this.list = createElement('div', { className: 'pulls__list' });
    main.append(this.bar, this.list);
    this.detail = createElement('div', { className: 'pulls__overview extensions__detail' });
    host.append(this.rail, main, this.detail);
    this.render();
  }

  /** Reads both agents again. Called when the tab is shown. */
  async load(): Promise<void> {
    this.view = await window.api.readExtensions();
    this.render();
  }

  /* ----------------------------------------------------------------- state */

  private items(): ExtensionItem[] {
    return (this.view?.items ?? []).filter(
      (item) => item.agent === this.agent && item.kind === this.kind && matchesFilter(item, this.filter),
    );
  }

  private current(): ExtensionItem | undefined {
    const items = this.items();
    return items.find((item) => item.id === this.selected) ?? items[0];
  }

  private async run(work: () => Promise<ExtensionsResult>): Promise<boolean> {
    if (this.busy) {
      return false;
    }
    this.busy = true;
    this.render();
    try {
      const result = await work();
      this.view = result.view;
      if (result.message.length > 0) {
        this.stamp(result.message);
      }
      if (!result.ok && this.form !== null) {
        this.formError = result.message;
      }
      return result.ok;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private act(action: ExtensionAction): Promise<boolean> {
    return this.run(() => window.api.actOnExtension(action));
  }

  /* ---------------------------------------------------------------- render */

  private render(): void {
    this.renderRail();
    this.renderBar();
    this.renderList();
    this.renderDetail();
  }

  private renderRail(): void {
    clearChildren(this.rail);
    for (const agent of EXTENSION_AGENTS) {
      const status = this.view?.agents.find((entry) => entry.agent === agent);
      const head = createElement('div', { className: 'extensions__agent' });
      head.append(
        createElement('span', {
          className: 'extensions__agent-name',
          text: status?.label ?? (agent === 'claude' ? 'Claude Code' : 'Codex'),
        }),
      );
      if (status?.version != null) {
        head.append(createElement('span', { className: 'extensions__agent-version', text: status.version }));
      }
      this.rail.append(head);
      if (status?.problem != null) {
        this.rail.append(createElement('p', { className: 'extensions__agent-problem', text: status.problem }));
      }
      const counts = countByKind(this.view?.items ?? [], agent);
      for (const kind of EXTENSION_KINDS) {
        if (agent === 'codex' && (kind === 'plugins' || kind === 'routines')) {
          continue;
        }
        const active = agent === this.agent && kind === this.kind;
        const row = createElement('button', {
          className: `pulls__repo${active ? ' pulls__repo--active' : ''}`,
        });
        row.type = 'button';
        row.append(createElement('span', { className: 'pulls__repo-name', text: KIND_LABELS[kind] }));
        row.append(createElement('span', { className: 'pulls__repo-count', text: String(counts[kind]) }));
        row.addEventListener('click', () => {
          this.agent = agent;
          this.kind = kind;
          this.selected = null;
          this.form = null;
          this.render();
        });
        this.rail.append(row);
      }
      if (agent === 'codex') {
        this.rail.append(
          createElement('p', { className: 'extensions__agent-problem', text: 'Codex has no plugins and no routines' }),
        );
      }
    }
  }

  private renderBar(): void {
    clearChildren(this.bar);
    const filter = createElement('input', { className: 'extensions__filter' });
    filter.type = 'search';
    filter.placeholder = `Filter ${KIND_LABELS[this.kind].toLowerCase()}`;
    filter.value = this.filter;
    filter.addEventListener('input', () => {
      this.filter = filter.value;
      this.renderList();
      this.renderDetail();
    });
    this.bar.append(filter);

    const add = this.addLabel();
    if (add !== null) {
      this.bar.append(
        this.button(add, () => {
          this.openAddForm();
        }),
      );
    }
    if (this.kind === 'routines') {
      const read = this.button(this.busy ? 'Reading…' : 'Read from claude.ai', () => {
        void this.run(() => window.api.readRoutines());
      });
      read.disabled = this.busy;
      read.title =
        'Routines live on claude.ai. Reading them runs Claude Code once, headless, allowed one tool: a few seconds and a small model call.';
      this.bar.append(read);
    }
    if (this.agent === 'claude' && this.kind === 'mcp') {
      const check = this.button(this.busy ? 'Checking…' : 'Check status', () => {
        void this.run(() => window.api.checkExtensions());
      });
      check.title =
        'Runs claude mcp list: starts every server to check it, and lists the claude.ai connectors. Takes a few seconds.';
      this.bar.append(check);
    }
    this.bar.append(this.button('Refresh', () => void this.load(), 'button--quiet'));
  }

  private addLabel(): string | null {
    if (this.kind === 'hooks') {
      return this.agent === 'claude' ? 'Add hook' : null;
    }
    if (this.kind === 'skills') {
      return 'New skill';
    }
    if (this.kind === 'plugins') {
      return this.agent === 'claude' ? 'Install plugin' : null;
    }
    if (this.kind === 'routines') {
      return 'New routine';
    }
    return 'Add server';
  }

  private renderList(): void {
    clearChildren(this.list);
    if (this.view === null) {
      this.list.append(createElement('p', { className: 'pulls__empty', text: 'Reading…' }));
      return;
    }
    for (const problem of this.view.problems) {
      this.list.append(createElement('p', { className: 'pulls__error', text: problem }));
    }
    if (this.kind === 'routines') {
      const state = this.view.routines;
      if (state.error !== null) {
        this.list.append(createElement('p', { className: 'pulls__error', text: state.error }));
      }
      this.list.append(
        createElement('p', {
          className: 'pulls__empty',
          text:
            state.readAt === null
              ? 'Never read. Routines live on claude.ai: press Read from claude.ai.'
              : `Read from claude.ai ${describeSince(state.readAt, Date.now())}.`,
        }),
      );
    }
    const items = this.items();
    if (items.length === 0) {
      this.list.append(
        createElement('p', {
          className: 'pulls__empty',
          text:
            this.filter.length > 0
              ? 'Nothing matches the filter.'
              : this.agent === 'claude' && this.kind === 'mcp' && this.view.statuses === null
                ? 'No server here. claude.ai connectors appear after Check status.'
                : `No ${KIND_LABELS[this.kind].toLowerCase()} for ${this.agent === 'claude' ? 'Claude Code' : 'Codex'}.`,
        }),
      );
      return;
    }
    const active = this.current();
    for (const item of items) {
      const row = createElement('button', {
        className: `extensions__row${item.id === active?.id && this.form === null ? ' extensions__row--active' : ''}`,
      });
      row.type = 'button';
      const head = createElement('div', { className: 'extensions__row-head' });
      if (item.enabled !== null) {
        const dot = createElement('span', {
          className: `extensions__dot${item.enabled ? ' extensions__dot--on' : ''}`,
        });
        dot.title = item.enabled ? 'Enabled' : 'Disabled';
        head.append(dot);
      }
      head.append(createElement('span', { className: 'extensions__row-name', text: item.name }));
      head.append(createElement('span', { className: 'pill pill--neutral', text: item.scopeLabel }));
      if (item.duplicates.length > 0) {
        const dup = createElement('span', {
          className: 'pill pill--info',
          text: `also in ${item.duplicates.join(', ')}`,
        });
        dup.title = 'Declared in more than one place';
        head.append(dup);
      }
      row.append(head);
      if (item.description.length > 0) {
        row.append(createElement('span', { className: 'extensions__row-description', text: item.description }));
      }
      row.title = item.name;
      row.addEventListener('click', () => {
        this.selected = item.id;
        this.form = null;
        this.renderList();
        this.renderDetail();
      });
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.selected = item.id;
        this.form = null;
        this.renderList();
        this.renderDetail();
        showContextMenu(event.clientX, event.clientY, this.menu(item));
      });
      this.list.append(row);
    }
  }

  private menu(item: ExtensionItem): MenuItem[] {
    return item.verbs.map((verb) => ({
      label: verbLabel(item, verb),
      disabled: this.busy,
      run: () => this.verb(item, verb),
    }));
  }

  private verb(item: ExtensionItem, verb: ExtensionVerb): void {
    if (verb === 'edit' && item.kind === 'routines') {
      void this.act({ type: 'schedule-session', id: item.id });
      return;
    }
    if (verb === 'edit') {
      this.openEditForm(item);
      return;
    }
    void this.act({ type: verb, id: item.id });
  }

  private renderDetail(): void {
    clearChildren(this.detail);
    if (this.form !== null) {
      this.renderForm(this.form);
      return;
    }
    const item = this.current();
    if (item === undefined) {
      this.detail.append(this.footer());
      return;
    }
    this.detail.append(createElement('div', { className: 'pulls__overview-title', text: item.name }));
    if (item.description.length > 0) {
      this.detail.append(createElement('p', { className: 'extensions__description', text: item.description }));
    }
    const facts = createElement('dl', { className: 'extensions__facts' });
    facts.append(createElement('dt', { text: 'Scope' }), createElement('dd', { text: item.scopeLabel }));
    if (item.enabled !== null) {
      facts.append(
        createElement('dt', { text: 'State' }),
        createElement('dd', { text: item.enabled ? 'enabled' : 'disabled' }),
      );
    }
    for (const fact of item.facts) {
      facts.append(
        createElement('dt', { text: fact.label }),
        createElement('dd', { className: fact.mono ? 'extensions__mono' : '', text: fact.value }),
      );
    }
    this.detail.append(facts);
    if (item.duplicates.length > 0) {
      this.detail.append(
        createElement('p', {
          className: 'extensions__note',
          text: `Also declared in ${item.duplicates.join(', ')}.`,
        }),
      );
    }
    if (item.readOnly !== null) {
      this.detail.append(createElement('p', { className: 'extensions__note', text: item.readOnly }));
    }
    if (item.verbs.length > 0) {
      const actions = createElement('div', { className: 'extensions__actions' });
      for (const verb of item.verbs) {
        const label = verbLabel(item, verb);
        const button = this.button(label, () => this.verb(item, verb), verb === 'remove' ? 'extensions__remove' : '');
        button.disabled = this.busy;
        actions.append(button);
      }
      this.detail.append(actions);
    }
    this.detail.append(this.footer());
  }

  private footer(): HTMLElement {
    return createElement('p', {
      className: 'extensions__footer',
      text: 'Changes apply to sessions started afterwards. A plugin change needs the agent restarted.',
    });
  }

  /* ----------------------------------------------------------------- forms */

  private firstProject(): string | null {
    return this.view?.projects[0]?.id ?? null;
  }

  private openAddForm(): void {
    this.formError = '';
    if (this.kind === 'routines') {
      void this.act({ type: 'schedule-session', id: null });
      return;
    }
    if (this.kind === 'mcp') {
      this.form = {
        kind: 'mcp',
        id: null,
        agent: this.agent,
        name: '',
        scope: 'user',
        projectId: this.firstProject(),
        transport: 'stdio',
        command: '',
        args: '',
        url: '',
        env: [],
        headers: [],
        bearerEnv: '',
      };
    } else if (this.kind === 'hooks') {
      this.form = {
        kind: 'hook',
        id: null,
        scope: 'user',
        projectId: this.firstProject(),
        event: 'PreToolUse',
        matcher: '',
        command: '',
        timeout: '',
      };
    } else if (this.kind === 'skills') {
      this.form = { kind: 'skill', agent: this.agent, scope: 'user', projectId: this.firstProject(), name: '', description: '' };
    } else {
      this.form = { kind: 'plugin', plugin: '', scope: 'user', projectId: this.firstProject() };
      if (this.available.length === 0) {
        void window.api.availablePlugins().then((list) => {
          this.available = list;
          if (this.form?.kind === 'plugin') {
            this.renderDetail();
          }
        });
      }
    }
    this.renderList();
    this.renderDetail();
  }

  private openEditForm(item: ExtensionItem): void {
    this.formError = '';
    const scope: WritableScope = item.scope === 'project' || item.scope === 'local' ? item.scope : 'user';
    if (item.kind === 'mcp' && item.mcp !== null) {
      this.form = {
        kind: 'mcp',
        id: item.id,
        agent: item.agent,
        name: item.name,
        scope,
        projectId: item.projectId ?? this.firstProject(),
        transport: item.mcp.transport,
        command: item.mcp.command,
        args: item.mcp.args.join('\n'),
        url: item.mcp.url,
        env: item.mcp.envNames.map((name) => ({ name, value: '', stored: true })),
        headers: item.mcp.headerNames.map((name) => ({ name, value: '', stored: true })),
        bearerEnv: item.mcp.bearerEnv,
      };
    } else if (item.kind === 'hooks' && item.hook !== null) {
      this.form = {
        kind: 'hook',
        id: item.id,
        scope,
        projectId: item.projectId ?? this.firstProject(),
        event: item.hook.event,
        matcher: item.hook.matcher,
        command: item.hook.command,
        timeout: item.hook.timeout === null ? '' : String(item.hook.timeout),
      };
    } else {
      return;
    }
    this.renderList();
    this.renderDetail();
  }

  private renderForm(form: Form): void {
    const title =
      form.kind === 'mcp'
        ? form.id === null
          ? `New ${form.agent === 'claude' ? 'Claude Code' : 'Codex'} MCP server`
          : `Edit ${form.name}`
        : form.kind === 'hook'
          ? form.id === null
            ? 'New Claude Code hook'
            : 'Edit hook'
          : form.kind === 'skill'
            ? `New ${form.agent === 'claude' ? 'Claude Code' : 'Codex'} skill`
            : 'Install a Claude Code plugin';
    this.detail.append(createElement('div', { className: 'pulls__overview-title', text: title }));
    const box = createElement('div', { className: 'extensions__form' });

    if (form.kind === 'mcp') {
      box.append(this.text('Name', form.name, (value) => (form.name = value), { mono: true }));
      if (form.agent === 'claude') {
        this.scopeFields(box, form, ['user', 'local', 'project']);
      }
      const transports: McpTransport[] = form.agent === 'claude' ? ['stdio', 'http', 'sse'] : ['stdio', 'http'];
      box.append(
        this.choice('Transport', transports.map((value) => ({ value, label: value })), form.transport, (value) => {
          form.transport = value as McpTransport;
          this.renderDetail();
        }),
      );
      if (form.transport === 'stdio') {
        box.append(this.text('Command', form.command, (value) => (form.command = value), { mono: true }));
        box.append(
          this.text('Arguments, one per line', form.args, (value) => (form.args = value), { mono: true, area: true }),
        );
        this.pairFields(box, 'Environment', form.env);
      } else {
        box.append(this.text('URL', form.url, (value) => (form.url = value), { mono: true }));
        if (form.agent === 'claude') {
          this.pairFields(box, 'Headers', form.headers);
        } else {
          box.append(
            this.text('Token variable', form.bearerEnv, (value) => (form.bearerEnv = value), {
              mono: true,
              placeholder: 'MY_SERVER_TOKEN',
            }),
          );
        }
      }
    } else if (form.kind === 'hook') {
      this.scopeFields(box, form, ['user', 'project', 'local']);
      const events = CLAUDE_HOOK_EVENTS.includes(form.event) ? CLAUDE_HOOK_EVENTS : [form.event, ...CLAUDE_HOOK_EVENTS];
      box.append(
        this.choice('Event', events.map((value) => ({ value, label: value })), form.event, (value) => {
          form.event = value;
        }),
      );
      box.append(
        this.text('Matcher', form.matcher, (value) => (form.matcher = value), {
          mono: true,
          placeholder: 'Bash|Edit, empty for every call',
        }),
      );
      box.append(this.text('Command', form.command, (value) => (form.command = value), { mono: true }));
      box.append(
        this.text('Timeout in seconds', form.timeout, (value) => (form.timeout = value), { placeholder: 'default' }),
      );
    } else if (form.kind === 'skill') {
      box.append(this.text('Name', form.name, (value) => (form.name = value), { mono: true }));
      box.append(
        this.text('Description', form.description, (value) => (form.description = value), {
          placeholder: 'What it does and when the agent should use it',
        }),
      );
      if (form.agent === 'claude') {
        this.scopeFields(box, form, ['user', 'project']);
      }
    } else {
      const field = this.text('Plugin', form.plugin, (value) => (form.plugin = value), {
        mono: true,
        placeholder: 'name@marketplace',
      });
      const input = field.querySelector('input');
      if (input !== null && this.available.length > 0) {
        const list = createElement('datalist');
        list.id = 'extensions-available-plugins';
        for (const plugin of this.available) {
          const option = createElement('option');
          option.value = plugin.id;
          option.label = plugin.description;
          list.append(option);
        }
        input.setAttribute('list', list.id);
        box.append(list);
      }
      box.append(field);
      this.scopeFields(box, form, ['user', 'project', 'local']);
    }

    if (this.formError.length > 0) {
      box.append(createElement('p', { className: 'pulls__error', text: this.formError }));
    }
    const actions = createElement('div', { className: 'extensions__actions' });
    const save = this.button(this.busy ? 'Saving…' : form.kind === 'plugin' ? 'Install' : 'Save', () => {
      void this.submit(form);
    });
    save.disabled = this.busy;
    actions.append(save);
    actions.append(
      this.button(
        'Cancel',
        () => {
          this.form = null;
          this.formError = '';
          this.renderList();
          this.renderDetail();
        },
        'button--quiet',
      ),
    );
    box.append(actions);
    this.detail.append(box);
  }

  private async submit(form: Form): Promise<void> {
    this.formError = '';
    let action: ExtensionAction;
    if (form.kind === 'mcp') {
      action = {
        type: 'save-mcp',
        id: form.id,
        agent: form.agent,
        scope: form.agent === 'codex' ? 'user' : form.scope,
        projectId: form.scope === 'user' ? null : form.projectId,
        name: form.name,
        draft: {
          transport: form.transport,
          command: form.command,
          args: form.args
            .split(/\r?\n/)
            .map((arg) => arg.trim())
            .filter((arg) => arg.length > 0),
          url: form.url,
          env: form.env.map(({ name, value }) => ({ name, value })),
          headers: form.headers.map(({ name, value }) => ({ name, value })),
          bearerEnv: form.bearerEnv,
        },
      };
    } else if (form.kind === 'hook') {
      const timeout = form.timeout.trim();
      if (timeout.length > 0 && !/^\d+$/.test(timeout)) {
        this.formError = 'The timeout is a whole number of seconds';
        this.renderDetail();
        return;
      }
      action = {
        type: 'save-hook',
        id: form.id,
        scope: form.scope,
        projectId: form.scope === 'user' ? null : form.projectId,
        hook: { event: form.event, matcher: form.matcher, command: form.command, timeout: timeout.length > 0 ? Number(timeout) : null },
      };
    } else if (form.kind === 'skill') {
      action = {
        type: 'add-skill',
        agent: form.agent,
        scope: form.agent === 'codex' ? 'user' : form.scope,
        projectId: form.scope === 'user' ? null : form.projectId,
        name: form.name,
        description: form.description,
      };
    } else {
      action = {
        type: 'install-plugin',
        plugin: form.plugin,
        scope: form.scope,
        projectId: form.scope === 'user' ? null : form.projectId,
      };
    }
    const ok = await this.act(action);
    if (ok) {
      this.form = null;
      this.render();
    }
  }

  /* ---------------------------------------------------------------- fields */

  private scopeFields(
    box: HTMLElement,
    form: { scope: WritableScope | 'user' | 'project'; projectId: string | null },
    scopes: readonly WritableScope[],
  ): void {
    const labels: Record<WritableScope, string> = {
      user: 'user (every project)',
      project: 'project (shared, committed)',
      local: 'local (this machine, this project)',
    };
    box.append(
      this.choice('Scope', scopes.map((value) => ({ value, label: labels[value] })), form.scope, (value) => {
        form.scope = value as WritableScope;
        this.renderDetail();
      }),
    );
    if (form.scope !== 'user') {
      const projects = this.view?.projects ?? [];
      if (projects.length === 0) {
        box.append(
          createElement('p', { className: 'pulls__error', text: 'No project is configured in the settings.' }),
        );
        return;
      }
      box.append(
        this.choice(
          'Project',
          projects.map((project) => ({ value: project.id, label: project.label })),
          form.projectId ?? projects[0]?.id ?? '',
          (value) => {
            form.projectId = value;
          },
        ),
      );
    }
  }

  private pairFields(
    box: HTMLElement,
    label: string,
    pairs: { name: string; value: string; stored: boolean }[],
  ): void {
    const group = createElement('div', { className: 'extensions__pairs' });
    group.append(createElement('span', { className: 'extensions__label', text: label }));
    pairs.forEach((pair, at) => {
      const row = createElement('div', { className: 'extensions__pair' });
      const name = createElement('input', { className: 'extensions__input extensions__mono' });
      name.value = pair.name;
      name.placeholder = 'NAME';
      name.addEventListener('input', () => (pair.name = name.value));
      const value = createElement('input', { className: 'extensions__input extensions__mono' });
      value.type = 'password';
      value.value = pair.value;
      value.placeholder = pair.stored ? 'unchanged' : 'value';
      value.addEventListener('input', () => (pair.value = value.value));
      const remove = this.button(
        '×',
        () => {
          pairs.splice(at, 1);
          this.renderDetail();
        },
        'button--quiet',
      );
      remove.title = `Remove this ${label.toLowerCase()} entry`;
      row.append(name, value, remove);
      group.append(row);
    });
    group.append(
      this.button(
        `Add ${label.toLowerCase()} entry`,
        () => {
          pairs.push({ name: '', value: '', stored: false });
          this.renderDetail();
        },
        'button--quiet',
      ),
    );
    box.append(group);
  }

  private text(
    label: string,
    value: string,
    onInput: (value: string) => void,
    options: { mono?: boolean; area?: boolean; placeholder?: string } = {},
  ): HTMLElement {
    const wrapper = createElement('label', { className: 'extensions__field' });
    wrapper.append(createElement('span', { className: 'extensions__label', text: label }));
    const input = options.area === true ? createElement('textarea') : createElement('input');
    input.className = `extensions__input${options.mono === true ? ' extensions__mono' : ''}`;
    input.value = value;
    input.placeholder = options.placeholder ?? '';
    if (input instanceof HTMLTextAreaElement) {
      input.rows = 3;
    }
    input.addEventListener('input', () => onInput(input.value));
    wrapper.append(input);
    return wrapper;
  }

  private choice(
    label: string,
    options: readonly { value: string; label: string }[],
    value: string,
    onChange: (value: string) => void,
  ): HTMLElement {
    const wrapper = createElement('label', { className: 'extensions__field' });
    wrapper.append(createElement('span', { className: 'extensions__label', text: label }));
    const select = createElement('select', { className: 'extensions__input' });
    for (const entry of options) {
      const option = createElement('option', { text: entry.label });
      option.value = entry.value;
      option.selected = entry.value === value;
      select.append(option);
    }
    select.addEventListener('change', () => onChange(select.value));
    wrapper.append(select);
    return wrapper;
  }

  private button(label: string, run: () => void, modifier = ''): HTMLButtonElement {
    const button = createElement('button', {
      className: `button${modifier.length > 0 ? ` ${modifier}` : ''}`,
      text: label,
    });
    button.type = 'button';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      run();
    });
    return button;
  }
}
