import {
  TERMINAL_FONT_SIZE,
  UI_FONT_SIZE,
  type AppSettings,
  type JiraConfig,
  type ProjectAction,
  type ProjectCandidate,
  type ProjectConfig,
  type ProjectValidation,
  type ShellProfile,
} from '@shared/contracts.js';
import { isValidModel } from '@shared/claude-model.js';
import {
  MAX_TAGS_PER_PROJECT,
  addTag,
  parseTagInput,
  removeTag,
  tagSuggestions,
} from '@shared/project-tags.js';
import { clearChildren, createElement } from './dom.js';

/**
 * Mutable working copies of the two configuration shapes.
 *
 * The shared contracts are deeply readonly so nothing can mutate state the dashboard renders from.
 * A form, by nature, edits in place, so the page strips the modifiers on its own drafts and only
 * hands validated data back across the bridge on save.
 */
type ActionDraft = { -readonly [K in keyof ProjectAction]: ProjectAction[K] };
/*
 * `actions` is replaced rather than intersected: an intersection keeps both declarations, so the
 * element type would still carry the readonly `role` from `ProjectAction` and the form could not edit
 * it. `Omit` drops the original member outright.
 */
type ProjectDraft = Omit<{ -readonly [K in keyof ProjectConfig]: ProjectConfig[K] }, 'actions'> & {
  actions: ActionDraft[];
};
type ProfileDraft = { -readonly [K in keyof ShellProfile]: ShellProfile[K] } & { args: string[] };

/**
 * A free action id within one project.
 *
 * Mirrors the main process's rule rather than importing it: the renderer is sandboxed and shares only
 * `contracts.ts` with it. The store re-derives ids on save anyway, so a collision here would be
 * corrected rather than persisted; this only keeps the draft coherent while it is being edited.
 */
function nextActionId(base: string, taken: readonly { id: string }[]): string {
  const ids = taken.map((entry) => entry.id);
  if (!ids.includes(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    if (!ids.includes(`${base}-${suffix}`)) {
      return `${base}-${suffix}`;
    }
  }
}

/**
 * Compares configurations by value.
 *
 * Fields are listed explicitly rather than stringifying the objects: a project added by the form and
 * the same project read back from the store hold identical values in a different key order, and
 * `JSON.stringify` would call those two different. Profiles are left out because only this window
 * edits them, so they cannot change behind its back.
 */
function signatureOf(projects: readonly ProjectConfig[], defaultProfileId: string): string {
  return JSON.stringify({
    projects: projects.map((project) => [
      project.id,
      project.label,
      project.path,
      project.kind,
      project.expectedPort,
      project.enabled,
      project.followPulls,
      // Listed like every other field, and for the reason this function exists rather than a
      // `JSON.stringify`: a tag edited here has to count as a change, or the footer would report the
      // form clean while holding an unsaved one.
      [...project.tags],
      project.actions.map((action) => [
        action.id,
        action.label,
        action.command,
        action.role,
        action.profileId,
      ]),
    ]),
    defaultProfileId,
  });
}

/**
 * The three model fields, as one object rather than three properties.
 *
 * Named so the render loop can be keyed (`keyof ClaudeModelDrafts`) instead of repeating the same
 * field three times with a different property each.
 */
interface ClaudeModelDrafts {
  analysis: string;
  work: string;
  commit: string;
}

export interface SettingsFormHosts {
  readonly rail: HTMLElement;
  readonly interface: HTMLElement;
  readonly projects: HTMLElement;
  readonly terminal: HTMLElement;
  readonly claude: HTMLElement;
  readonly jira: HTMLElement;
  readonly footer: HTMLElement;
}

export interface SettingsFormActions {
  /** Reported so the window can warn before closing on unsaved edits. */
  readonly onDirtyChange: (dirty: boolean) => void;
  /** Asks the host to close the window. */
  readonly onRequestClose: () => void;
  /** Asks the host to bring a section into view. Scrolling belongs to the window, not to the form. */
  readonly onNavigate: (sectionId: string) => void;
}

/**
 * How a rail readout reads: neutral is a plain fact and takes no colour, while `warn` and `error` are
 * claims that the section will not do what it says. Colour is spent on those two and on nothing else,
 * which is what keeps them findable in a column of five lines.
 */
type RailTone = 'neutral' | 'warn' | 'error';

interface RailEntry {
  /** Id of the `<section>` in `settings.html` this entry scrolls to. */
  readonly id: string;
  readonly name: string;
  /** One line saying what the section is set to right now. */
  readonly state: string;
  readonly tone: RailTone;
}

/** `1 project` / `4 projects`, so the readout never says "1 projects". */
function count(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? '' : 's'}`;
}

/**
 * The host of a Jira site, which is what identifies it at a glance.
 *
 * The field is edited character by character, so it is a malformed URL most of the time it is read:
 * anything `URL` refuses comes back as typed rather than as an empty readout.
 */
function jiraHost(siteUrl: string): string {
  const trimmed = siteUrl.trim();
  if (trimmed.length === 0) {
    return '';
  }
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return trimmed;
  }
}

/**
 * The settings form.
 *
 * Edits a working copy and only writes on save, so an abandoned edit changes nothing. Validation runs
 * as the user types, because the two mistakes that matter here (a wrong path, a start script that does
 * not exist) are invisible until something fails to launch.
 *
 * Saving keeps the form open. It lives in its own window now, so the useful gesture is "apply and see
 * the dashboard update behind", not "apply and disappear".
 */
export class SettingsForm {
  /** Working copies, discarded unless the user saves. */
  private projects: ProjectDraft[] = [];
  private profiles: ProfileDraft[] = [];
  private defaultProfileId = '';
  private fontSize: number = TERMINAL_FONT_SIZE.default;
  /** Interface font size draft, separate from the terminal's: see `renderInterface`. */
  private uiFontSize: number = UI_FONT_SIZE.default;
  /** Empty means "the default folder", so it is never coerced to the resolved path. */
  /** The three model drafts. Empty is a real value: it means "let Claude Code decide". */
  private claudeModels: ClaudeModelDrafts = { analysis: '', work: '', commit: '' };
  private jira: JiraConfig = { siteUrl: '', email: '', projectKeys: [], hasToken: false };
  /** Typed token, held only until the save. Never read back from the main process. */
  private jiraToken = '';
  private jiraStatus = '';
  private validations: ProjectValidation[] = [];
  private candidates: ProjectCandidate[] = [];
  private showCandidates = false;
  private dirty = false;
  /** Set after a successful save, so the footer confirms it instead of going blank. */
  private saved = false;
  /**
   * Signature of the configuration as last loaded or saved.
   *
   * Saving makes the main process broadcast the new settings to every window, including this one, so
   * the form would immediately reload its own write and wipe the confirmation it had just shown. The
   * signature is how an echo of our own save is told from a real external change, such as a project
   * renamed in the dashboard table.
   */
  private baseline = '';
  /** Section the rail marks as current. Driven by the window's scroll, not by the last click. */
  private activeSection = 'section-interface';

  constructor(
    private readonly hosts: SettingsFormHosts,
    private readonly actions: SettingsFormActions,
  ) {}

  /** Loads a fresh draft from the stored settings. */
  async load(
    settings: AppSettings,
    profiles: readonly ShellProfile[],
    jira: JiraConfig,
  ): Promise<void> {
    this.claudeModels = {
      analysis: settings.claudeAnalysisModel,
      work: settings.claudeWorkModel,
      commit: settings.claudeCommitModel,
    };
    this.jira = { ...jira, projectKeys: [...jira.projectKeys] };
    this.jiraToken = '';
    this.jiraStatus = '';
    // Deep copies down to the actions: the form must not mutate the state the dashboard renders from.
    this.projects = settings.projects.map((project) => ({
      ...project,
      actions: project.actions.map((action) => ({ ...action })),
    }));
    this.profiles = profiles.map((profile) => ({ ...profile, args: [...profile.args] }));
    this.defaultProfileId = settings.defaultShellProfileId;
    this.fontSize = settings.terminalFontSize;
    this.uiFontSize = settings.uiFontSize;
    this.setDirty(false);
    this.saved = false;
    this.showCandidates = false;
    this.candidates = [];
    this.baseline = this.signature();

    await this.revalidate();
    this.render();
  }

  get hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  /**
   * True when incoming settings say something this form does not already know.
   *
   * Lets the host drop the echo of its own save instead of reloading and losing the confirmation.
   */
  matchesLoadedState(settings: AppSettings): boolean {
    return signatureOf(settings.projects, settings.defaultShellProfileId) === this.baseline;
  }

  /* ------------------------------------------------------------- rendering */

  private render(): void {
    this.renderInterface();
    this.renderProjects();
    this.renderTerminal();
    this.renderClaude();
    this.renderJira();
    this.renderFooter();
    this.renderRail();
  }

  /**
   * Marks the section the window is currently looking at.
   *
   * Attributes are patched in place rather than rebuilding the rail: this is called on every scroll
   * event the observer reports, and rebuilding five buttons at that rate would fight the pointer.
   */
  setActiveSection(sectionId: string): void {
    if (this.activeSection === sectionId) {
      return;
    }
    this.activeSection = sectionId;
    this.applyRailCurrent();
  }

  /**
   * The rail.
   *
   * Each entry names a section and says what that section is set to right now. That readout is the
   * reason the rail is worth its width: "is Jira connected", "how many projects", "which shell" are
   * the questions this window is opened to answer, and answering them in the navigation means not
   * scrolling through the whole form to find out.
   */
  private renderRail(): void {
    clearChildren(this.hosts.rail);

    for (const entry of this.railEntries()) {
      const item = createElement('li');
      const link = createElement('button', { className: 'settings-rail__link' });
      link.type = 'button';
      link.dataset.section = entry.id;
      link.setAttribute('aria-current', entry.id === this.activeSection ? 'true' : 'false');
      link.append(createElement('span', { className: 'settings-rail__name', text: entry.name }));
      link.append(
        createElement('span', {
          className:
            entry.tone === 'neutral'
              ? 'settings-rail__state'
              : `settings-rail__state settings-rail__state--${entry.tone}`,
          text: entry.state,
        }),
      );
      link.addEventListener('click', () => this.actions.onNavigate(entry.id));
      item.append(link);
      this.hosts.rail.append(item);
    }
  }

  private applyRailCurrent(): void {
    for (const link of this.hosts.rail.querySelectorAll('button')) {
      link.setAttribute(
        'aria-current',
        link.dataset.section === this.activeSection ? 'true' : 'false',
      );
    }
  }

  /** The five readouts, each computed from the draft rather than from what was last saved. */
  private railEntries(): readonly RailEntry[] {
    const failing = this.validations.filter((entry) =>
      entry.issues.some((issue) => issue.level === 'error'),
    ).length;
    const profile = this.profiles.find((entry) => entry.id === this.defaultProfileId);
    const models = [this.claudeModels.analysis, this.claudeModels.work, this.claudeModels.commit];
    const invalid = models.filter((model) => !isValidModel(model)).length;
    const pinned = models.filter((model) => model.trim().length > 0).length;
    const host = jiraHost(this.jira.siteUrl);

    return [
      {
        id: 'section-interface',
        name: 'Interface',
        state: `${this.uiFontSize} px`,
        tone: 'neutral',
      },
      {
        id: 'section-projects',
        name: 'Projects',
        state:
          this.projects.length === 0
            ? 'no project'
            : failing > 0
              ? `${count(this.projects.length, 'project')} · ${count(failing, 'error')}`
              : count(this.projects.length, 'project'),
        tone: this.projects.length === 0 ? 'warn' : failing > 0 ? 'error' : 'neutral',
      },
      {
        id: 'section-terminal',
        name: 'Terminal',
        state:
          profile === undefined ? 'no default profile' : `${profile.label} · ${this.fontSize} px`,
        tone: profile === undefined ? 'warn' : 'neutral',
      },
      {
        id: 'section-claude',
        name: 'Claude Code',
        state:
          invalid > 0
            ? count(invalid, 'invalid model')
            : pinned === 0
              ? 'Claude Code default'
              : `${pinned} of 3 pinned`,
        tone: invalid > 0 ? 'error' : 'neutral',
      },
      {
        id: 'section-jira',
        name: 'Jira',
        // A connected site is stated, not coloured: naming the host already says it is configured, and
        // green at this size does not hold its contrast against the rail.
        state:
          host.length === 0 ? 'not configured' : this.jira.hasToken ? host : `${host} · no token`,
        tone: host.length === 0 || this.jira.hasToken ? 'neutral' : 'warn',
      },
    ];
  }

  /**
   * The interface font size.
   *
   * Its own section rather than a second field in "Terminal", because the two sizes are not variants of
   * one setting: this one decides whether the app is comfortable to read, the terminal's decides how
   * much output fits in a pane. Someone whose interface is too small looks for the interface.
   *
   * The value only takes effect on save, like the terminal's, and it resizes this very window when it
   * does — which is the clearest possible confirmation that it worked.
   */
  private renderInterface(): void {
    clearChildren(this.hosts.interface);

    const row = createElement('div', { className: 'settings-entry__row' });
    // "Font size" and not "Interface font size": the section it sits in is called Interface, and the
    // longer label wrapped onto two lines above a field two digits wide.
    const size = this.field(
      'Font size',
      String(this.uiFontSize),
      (value) => {
        const parsed = Number.parseInt(value, 10);
        // Same rule as the terminal's field: an unusable value falls back to the default instead of
        // being kept, since this is the field that would become unreadable.
        this.uiFontSize = Number.isFinite(parsed) ? parsed : UI_FONT_SIZE.default;
        this.touch();
      },
      `${UI_FONT_SIZE.min} to ${UI_FONT_SIZE.max}`,
    );
    // Two digits wide, so it is given the width of two digits rather than the width of the window.
    size.classList.add('settings-field--narrow');
    row.append(size);
    row.append(
      createElement('span', {
        className: 'settings-aside',
        text: `Default ${UI_FONT_SIZE.default} px. Takes effect on save, and resizes this window with it.`,
      }),
    );
    this.hosts.interface.append(row);
  }

  /**
   * The model each Claude Code run is pinned to.
   *
   * Three fields and not one, because the three runs are three jobs: classifying a sprint is bulk
   * reading where speed and cost dominate, implementing a ticket wants the strongest model there is,
   * and writing a commit message from a diff is short and frequent. One setting would be wrong for two
   * of them.
   *
   * **Validated as you type, and that is not decoration.** One of these three ends up on a shell
   * command line, so the store normalises anything that is not a model name to empty. Without a mark
   * here, typing `sonnet 4` would look accepted, save, and come back as the default with nothing said:
   * a setting failing in complete silence, which is the failure `asPatch` already records. The mark is
   * on the field rather than a message beside it, since there is nothing to explain beyond "not this".
   */
  private renderClaude(): void {
    clearChildren(this.hosts.claude);

    const fields: readonly { key: keyof ClaudeModelDrafts; label: string; hint: string }[] = [
      {
        key: 'analysis',
        label: 'Triage analysis',
        hint: 'Reads a whole sprint: the run where speed and cost show most',
      },
      {
        key: 'work',
        label: 'Work on this',
        hint: 'Implements a ticket in a terminal tab: the run that writes code',
      },
      {
        key: 'commit',
        label: 'Commit message',
        hint: 'Reads a staged diff and writes the message: short and frequent',
      },
    ];

    const grid = createElement('div', { className: 'settings-entry__grid' });
    for (const entry of fields) {
      // A model id is a string the machine has to match exactly, so it is set in the mono face.
      const field = this.field(
        entry.label,
        this.claudeModels[entry.key],
        (value) => {
          this.claudeModels[entry.key] = value;
          this.markModelField(field, value);
          this.touch();
        },
        'default',
        true,
      );
      // The hint on hover rather than in the placeholder: a placeholder long enough to explain the run
      // is one that hides the value as soon as there is one.
      field.title = entry.hint;
      this.markModelField(field, this.claudeModels[entry.key]);
      grid.append(field);
    }
    this.hosts.claude.append(grid);
  }

  /** Flags a model field whose value the store would drop, so the silence is broken before the save. */
  private markModelField(field: HTMLElement, value: string): void {
    const input = field.querySelector('input');
    if (input === null) {
      return;
    }
    const invalid = !isValidModel(value);
    input.classList.toggle('settings-field__input--invalid', invalid);
    input.title = invalid
      ? 'Not a model name: letters, digits, dot, dash, underscore and brackets. This would be ignored.'
      : '';
  }

  /**
   * The Jira connection.
   *
   * The token field starts empty every time, on purpose: the form is never told the stored one, so it
   * cannot leak it back and an empty field means "leave it alone" rather than "erase it". The test button
   * runs one real query, because only that proves the credentials and the project keys together.
   */
  private renderJira(): void {
    clearChildren(this.hosts.jira);

    const grid = createElement('div', {
      className: 'settings-entry__grid settings-entry__grid--jira',
    });
    // No example placeholders here: a greyed example reads as a value already saved, and the question
    // "is this configured or not" has to be answerable at a glance. An empty field means empty.
    // All three are identifiers something else has to match exactly, so all three are mono.
    grid.append(
      this.field(
        'Site',
        this.jira.siteUrl,
        (value) => {
          this.jira = { ...this.jira, siteUrl: value };
          this.touch();
        },
        '',
        true,
      ),
    );
    grid.append(
      this.field(
        'Account email',
        this.jira.email,
        (value) => {
          this.jira = { ...this.jira, email: value };
          this.touch();
        },
        '',
        true,
      ),
    );
    grid.append(
      this.field(
        'Project keys',
        this.jira.projectKeys.join(', '),
        (value) => {
          this.jira = {
            ...this.jira,
            projectKeys: value
              .split(',')
              .map((key) => key.trim())
              .filter((key) => key.length > 0),
          };
          this.touch();
        },
        '',
        true,
      ),
    );
    this.hosts.jira.append(grid);

    const secret = createElement('div', { className: 'settings-inline' });
    /*
     * The state is in the placeholder, not in the label.
     *
     * It used to be the label, which meant the label read "Token saved, enter a new one to replace it"
     * — a label doing two jobs, and changing text under the field it names. The placeholder is where
     * this window already says what happens if a field is left alone, which is exactly what a stored
     * token means. The field itself is still always empty: it is never told the saved value.
     */
    const token = this.field(
      'API token',
      '',
      (value) => {
        this.jiraToken = value;
        this.touch();
      },
      this.jira.hasToken ? 'a token is saved — type a new one to replace it' : '',
      true,
    );
    const input = token.querySelector('input');
    if (input !== null) {
      // Masked, and never prefilled: there is nothing to prefill it with.
      input.type = 'password';
      input.autocomplete = 'off';
    }
    secret.append(token);

    const test = createElement('button', { className: 'button', text: 'Test' });
    test.type = 'button';
    test.title = 'Runs a real search to check the token and the project keys';
    test.addEventListener('click', () => {
      test.disabled = true;
      void window.api
        .testJira()
        .then((result) => {
          this.jiraStatus = result.message;
        })
        .catch((error: unknown) => {
          this.jiraStatus = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          test.disabled = false;
          this.renderJira();
        });
    });
    secret.append(test);
    this.hosts.jira.append(secret);

    if (this.jiraStatus.length > 0) {
      this.hosts.jira.append(
        createElement('p', { className: 'settings-entry__hint', text: this.jiraStatus }),
      );
    }
  }

  private renderProjects(): void {
    clearChildren(this.hosts.projects);

    if (this.projects.length === 0) {
      this.hosts.projects.append(
        createElement('p', {
          className: 'settings__empty',
          text: 'No project. Use "Detect" to find repositories, or "Add" to choose a folder.',
        }),
      );
    }

    for (const project of this.projects) {
      this.hosts.projects.append(this.buildProjectEntry(project));
    }

    const actions = createElement('div', { className: 'settings__row-actions' });

    const add = createElement('button', { className: 'button', text: '+ Add a folder' });
    add.type = 'button';
    add.addEventListener('click', () => void this.addByPicker());
    actions.append(add);

    const detect = createElement('button', { className: 'button', text: 'Detect repositories' });
    detect.type = 'button';
    detect.addEventListener('click', () => void this.detect());
    actions.append(detect);

    this.hosts.projects.append(actions);

    if (this.showCandidates) {
      this.hosts.projects.append(this.buildCandidates());
    }
  }

  private buildProjectEntry(project: ProjectDraft): HTMLElement {
    const validation = this.validations.find((entry) => entry.id === project.id);
    const hasError = validation?.issues.some((issue) => issue.level === 'error') ?? false;

    const card = createElement('div', {
      className: `settings-entry${hasError ? ' settings-entry--error' : ''}`,
    });

    const header = createElement('div', { className: 'settings-entry__header' });
    // The name is a word the user chose, so it is set in the interface face, not in the mono one.
    header.append(
      this.field('Name', project.label, (value) => {
        project.label = value;
        this.touch();
      }),
    );

    const remove = createElement('button', { className: 'button button--quiet', text: 'Delete' });
    remove.type = 'button';
    remove.title = 'Remove this project from the table';
    remove.addEventListener('click', () => {
      this.projects = this.projects.filter((entry) => entry !== project);
      this.touch();
      void this.revalidate().then(() => this.render());
    });
    header.append(remove);
    card.append(header);

    const pathRow = createElement('div', { className: 'settings-inline' });
    pathRow.append(
      this.field(
        'Folder',
        project.path,
        (value) => {
          project.path = value;
          this.touch();
        },
        '',
        true,
      ),
    );
    const browse = createElement('button', { className: 'button', text: '…' });
    browse.type = 'button';
    browse.title = 'Choose a folder';
    browse.addEventListener('click', () => {
      void window.api.pickFolder('Project folder').then((picked) => {
        if (picked !== null) {
          project.path = picked;
          this.touch();
          void this.revalidate().then(() => this.render());
        }
      });
    });
    pathRow.append(browse);
    card.append(pathRow);

    /*
     * The three settings that describe the row rather than the repository, on one line: what kind of
     * process it runs, on which port, and whether it follows pull requests. They were a grid and a
     * checkbox on separate lines, which spread three short answers over the width of the window.
     */
    const row = createElement('div', { className: 'settings-entry__row' });

    // Both of these are inferred from the repository, so the placeholder states what will be used
    // when the field is left alone rather than pretending the value is unset.
    const kind = this.select(
      'Type',
      [
        { value: '', label: `inferred (${validation?.inferredKind ?? '?'})` },
        { value: 'server', label: 'server' },
        { value: 'watch', label: 'watch' },
      ],
      project.kind ?? '',
      (value) => {
        project.kind = value === 'server' || value === 'watch' ? value : null;
        this.touch();
      },
    );
    kind.classList.add('settings-field--kind');
    row.append(kind);

    const port = this.field(
      'Port',
      project.expectedPort === null ? '' : String(project.expectedPort),
      (value) => {
        const parsed = Number.parseInt(value, 10);
        project.expectedPort = Number.isFinite(parsed) ? parsed : null;
        this.touch();
      },
      validation?.inferredPort === null || validation?.inferredPort === undefined
        ? 'none'
        : `inferred ${validation.inferredPort}`,
      true,
    );
    port.classList.add('settings-field--narrow');
    row.append(port);

    row.append(
      this.checkbox('Follow pull requests', project.followPulls, (checked) => {
        project.followPulls = checked;
        this.touch();
      }),
    );

    card.append(row);
    card.append(this.buildTagsEditor(project));
    card.append(this.buildActionsEditor(project, validation));

    if (validation !== undefined && validation.issues.length > 0) {
      const issues = createElement('ul', { className: 'settings-entry__issues' });
      for (const issue of validation.issues) {
        issues.append(
          createElement('li', {
            className: issue.level === 'error' ? 'issue issue--error' : 'issue issue--warning',
            text: issue.message,
          }),
        );
      }
      card.append(issues);
    }

    if (validation !== undefined && validation.scripts.length > 0) {
      card.append(
        createElement('p', {
          className: 'settings-entry__hint',
          text: `Scripts available: ${validation.scripts.slice(0, 8).join(', ')}`,
        }),
      );
    }

    return card;
  }

  /**
   * The tags of one project: the chips it carries, and one field to add more.
   *
   * **This block repaints itself and never calls `render()`.** Every other edit in this form is a
   * keystroke in a field that survives its own handler, whereas adding a tag replaces a list of
   * elements: a full render would destroy the input mid-sentence and take the focus with it, and
   * tagging twenty projects is a dozen tags typed one after another. So `paint` rebuilds the chips and
   * the suggestion list in place, `touch()` still reports the change, and the caret never leaves the
   * field.
   *
   * The suggestions are a native `<datalist>`, not a popup: the vocabulary is the handful of words
   * already in use, the browser already knows how to filter and place that list, and a widget of our
   * own would need a keyboard model for it. Same judgement that keeps this app on context menus rather
   * than modals.
   */
  private buildTagsEditor(project: ProjectDraft): HTMLElement {
    const box = createElement('div', { className: 'settings-tags' });
    box.append(createElement('span', { className: 'settings-tags__title', text: 'Tags' }));

    const chips = createElement('div', { className: 'settings-tags__chips' });
    box.append(chips);

    const input = createElement('input', { className: 'settings-tags__input' });
    input.type = 'text';
    input.setAttribute('aria-label', `Add a tag to ${project.label}`);
    // Sanitised rather than trusted: an id straight out of `makeId` is `[a-z0-9-]`, but a hand-edited
    // `settings.json` may carry anything, and an id holding a space silently detaches the datalist.
    const list = createElement('datalist');
    list.id = `tags-${project.id.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
    input.setAttribute('list', list.id);
    box.append(list);

    const paint = (): void => {
      clearChildren(chips);
      for (const tag of project.tags) {
        const chip = createElement('span', { className: 'tag tag--editable', text: tag });
        const drop = createElement('button', { className: 'tag__remove', text: '×' });
        drop.type = 'button';
        drop.title = `Remove the tag ${tag}`;
        drop.setAttribute('aria-label', `Remove the tag ${tag}`);
        drop.addEventListener('click', () => {
          project.tags = removeTag(project.tags, tag);
          this.touch();
          paint();
          input.focus();
        });
        chip.append(drop);
        chips.append(chip);
      }

      clearChildren(list);
      for (const suggestion of tagSuggestions(this.projects, project.tags)) {
        const option = createElement('option');
        option.value = suggestion;
        list.append(option);
      }

      const full = project.tags.length >= MAX_TAGS_PER_PROJECT;
      input.disabled = full;
      // The cap is stated in the field rather than only enforced, or a field that silently stops
      // accepting words reads as a broken one.
      input.placeholder = full ? `${MAX_TAGS_PER_PROJECT} tags maximum` : 'backend, dotnet';
    };

    const commit = (): void => {
      const parsed = parseTagInput(input.value);
      if (parsed.length === 0) {
        input.value = '';
        return;
      }
      for (const tag of parsed) {
        project.tags = addTag(project.tags, tag);
      }
      input.value = '';
      this.touch();
      paint();
    };

    input.addEventListener('keydown', (event) => {
      // The comma commits as well as separating, so a list typed in one go lands tag by tag instead of
      // waiting for Enter. `preventDefault` on it, or the character stays in the field just cleared.
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        commit();
        return;
      }
      // Backspace on an empty field removes the last chip, the gesture every tag field has. Guarded on
      // an empty value, or it would eat a chip while the user is correcting a word.
      if (event.key === 'Backspace' && input.value.length === 0 && project.tags.length > 0) {
        event.preventDefault();
        project.tags = project.tags.slice(0, -1);
        this.touch();
        paint();
      }
    });
    // Committed on blur too: a word typed and left behind by a click on Save is a tag the user thinks
    // they added, and losing it would be silent.
    input.addEventListener('blur', () => commit());

    paint();
    box.append(input);
    return box;
  }

  /**
   * The action list of one project.
   *
   * Order matters and is preserved: it is the order of the buttons in the table. The role selector is
   * where the one structural rule lives, so it explains itself rather than only failing validation:
   * exactly one action can drive the server state.
   */
  private buildActionsEditor(
    project: ProjectDraft,
    validation: ProjectValidation | undefined,
  ): HTMLElement {
    const box = createElement('div', { className: 'settings-actions' });
    box.append(createElement('span', { className: 'settings-actions__title', text: 'Actions' }));

    if (project.actions.length === 0) {
      box.append(
        createElement('p', {
          className: 'settings-actions__empty',
          text: 'No action: the row will have no button.',
        }),
      );
    }

    // Only the first row is labelled: the four eyebrows are column headings, and a list of actions is
    // a table, not four independent forms stacked on top of each other.
    project.actions.forEach((action, index) => {
      box.append(this.buildActionRow(project, action, validation, index === 0));
    });

    const add = createElement('button', { className: 'button', text: '+ Action' });
    add.type = 'button';
    add.title = 'Add a command to run on this project';
    add.addEventListener('click', () => {
      project.actions.push({
        id: nextActionId('action', project.actions),
        label: 'Action',
        command: '',
        // A new action is a task: promoting it to `server` is a deliberate choice, and defaulting to
        // it would silently steal the row's server state from the action that already has it.
        role: 'task',
        profileId: null,
      });
      this.touch();
      void this.revalidate().then(() => this.render());
    });
    box.append(add);

    return box;
  }

  private buildActionRow(
    project: ProjectDraft,
    action: ActionDraft,
    validation: ProjectValidation | undefined,
    showLabels: boolean,
  ): HTMLElement {
    const row = createElement('div', { className: 'settings-action' });

    // The button's text is a word the user chose; the command is a line a shell has to run. One face
    // each, which is the whole rule.
    row.append(
      this.field('Button', action.label, (value) => {
        // Only the label changes: the id keys the terminal tab, so re-deriving it here would orphan a
        // process the user started from this very button.
        action.label = value;
        this.touch();
      }),
    );

    row.append(
      this.field(
        'Command',
        action.command,
        (value) => {
          action.command = value;
          this.touch();
        },
        action.role === 'server' && validation?.serverCommand !== undefined
          ? 'npm run start'
          : 'command to run',
        true,
      ),
    );

    row.append(
      this.select(
        'Shell',
        [
          { value: '', label: 'default profile' },
          ...this.profiles.map((profile) => ({ value: profile.id, label: profile.label })),
        ],
        action.profileId ?? '',
        (value) => {
          action.profileId = value.length > 0 ? value : null;
          this.touch();
        },
      ),
    );

    row.append(
      this.select(
        'Role',
        [
          { value: 'task', label: 'task' },
          { value: 'server', label: 'server' },
        ],
        action.role,
        (value) => {
          const nextRole = value === 'server' ? 'server' : 'task';
          if (nextRole === 'server') {
            // Enforced here rather than only reported: two server actions cannot both own one row, and
            // demoting the previous holder is what the user means by promoting this one.
            for (const other of project.actions) {
              if (other !== action && other.role === 'server') {
                other.role = 'task';
              }
            }
          }
          action.role = nextRole;
          this.touch();
          void this.revalidate().then(() => this.render());
        },
      ),
    );

    const remove = createElement('button', { className: 'button button--quiet', text: '×' });
    remove.type = 'button';
    remove.title = `Delete "${action.label}"`;
    remove.addEventListener('click', () => {
      project.actions = project.actions.filter((entry) => entry !== action);
      this.touch();
      void this.revalidate().then(() => this.render());
    });
    row.append(remove);

    if (!showLabels) {
      // Hidden from view, kept for the accessible name: each input sits inside this `<label>`.
      for (const label of row.querySelectorAll('.settings-field__label')) {
        label.classList.add('visually-hidden');
      }
    }

    return row;
  }

  private buildCandidates(): HTMLElement {
    const box = createElement('div', { className: 'settings-candidates' });
    if (this.candidates.length === 0) {
      box.append(
        createElement('p', {
          className: 'settings__empty',
          text: 'No candidate repository found.',
        }),
      );
      return box;
    }

    for (const candidate of this.candidates) {
      const row = createElement('div', { className: 'settings-candidate' });
      row.append(
        createElement('span', { className: 'settings-candidate__label', text: candidate.label }),
        createElement('span', {
          className: 'settings-candidate__meta',
          text:
            candidate.kind === 'server'
              ? `server${candidate.expectedPort === null ? '' : ` :${candidate.expectedPort}`}`
              : 'watch',
        }),
      );

      const add = createElement('button', {
        className: 'button',
        text: candidate.alreadyAdded ? 'already added' : 'Add',
      });
      add.type = 'button';
      add.disabled = candidate.alreadyAdded;
      add.addEventListener('click', () => void this.addPath(candidate.path));
      row.append(add);
      box.append(row);
    }
    return box;
  }

  private renderTerminal(): void {
    clearChildren(this.hosts.terminal);

    const defaults = this.select(
      'Default profile',
      this.profiles.map((profile) => ({ value: profile.id, label: profile.label })),
      this.defaultProfileId,
      (value) => {
        this.defaultProfileId = value;
        this.touch();
      },
    );
    // These two are section-level controls sitting on top of the profile cards, not fields inside one,
    // so they need their own breathing room: the cards space themselves and the row was left flush
    // against the first of them.
    const row = createElement('div', { className: 'settings-terminal-row' });
    row.append(defaults);
    row.append(
      this.field(
        'Font size',
        String(this.fontSize),
        (value) => {
          const parsed = Number.parseInt(value, 10);
          // An unparseable or out-of-range value falls back to the default rather than being stored:
          // the field would otherwise be able to make the terminal unreadable while you type in it.
          this.fontSize = Number.isFinite(parsed) ? parsed : TERMINAL_FONT_SIZE.default;
          this.touch();
        },
        `${TERMINAL_FONT_SIZE.min} to ${TERMINAL_FONT_SIZE.max}`,
        true,
      ),
    );
    this.hosts.terminal.append(row);

    for (const profile of this.profiles) {
      const card = createElement('div', { className: 'settings-entry' });
      const header = createElement('div', { className: 'settings-entry__header' });
      // The name is editable like any other field: "Git Bash" is only what detection guessed, and a
      // profile the user points elsewhere deserves a name that says so.
      header.append(
        this.field('Name', profile.label, (value) => {
          profile.label = value;
          profile.detected = false;
          this.touch();
        }),
        createElement('span', {
          className: 'settings-entry__badge',
          // Says where the value came from, so an overridden profile is obviously deliberate.
          text: profile.detected ? 'detected' : 'custom',
        }),
      );
      card.append(header);

      const row = createElement('div', { className: 'settings-inline' });
      row.append(
        this.field(
          'Binary path',
          profile.file,
          (value) => {
            profile.file = value;
            profile.detected = false;
            this.touch();
          },
          '',
          true,
        ),
      );
      const browse = createElement('button', { className: 'button', text: '…' });
      browse.type = 'button';
      browse.addEventListener('click', () => {
        void window.api.pickFolder(`${profile.label} binary`).then((picked) => {
          if (picked !== null) {
            profile.file = picked;
            profile.detected = false;
            this.touch();
            this.render();
          }
        });
      });
      row.append(browse);
      card.append(row);

      const grid = createElement('div', { className: 'settings-entry__grid' });
      grid.append(
        this.field(
          'Arguments',
          profile.args.join(' '),
          (value) => {
            profile.args = value.split(/\s+/).filter((arg) => arg.length > 0);
            this.touch();
          },
          '',
          true,
        ),
      );
      grid.append(
        this.field(
          'Starting folder',
          profile.cwd,
          (value) => {
            profile.cwd = value;
            this.touch();
          },
          '',
          true,
        ),
      );
      card.append(grid);
      this.hosts.terminal.append(card);
    }
  }

  private renderFooter(): void {
    clearChildren(this.hosts.footer);

    const status = createElement('span', {
      className: this.dirty ? 'settings__status' : 'settings__status settings__status--ok',
      text: this.dirty ? 'unsaved changes' : this.saved ? 'changes saved' : '',
    });
    this.hosts.footer.append(status);

    const close = createElement('button', { className: 'button', text: 'Close' });
    close.type = 'button';
    close.addEventListener('click', () => this.actions.onRequestClose());
    this.hosts.footer.append(close);

    const save = createElement('button', { className: 'button button--primary', text: 'Save' });
    save.type = 'button';
    // Saving a configuration with a broken path would produce a row that can never run.
    const blocked = this.validations.some((entry) =>
      entry.issues.some((issue) => issue.level === 'error'),
    );
    save.disabled = blocked;
    if (blocked) {
      save.title = 'Fix the reported errors before saving';
    }
    save.addEventListener('click', () => void this.save());
    this.hosts.footer.append(save);
  }

  /* --------------------------------------------------------------- actions */

  private async addByPicker(): Promise<void> {
    const picked = await window.api.pickFolder('Project folder');
    if (picked !== null) {
      await this.addPath(picked);
    }
  }

  /**
   * Adds a folder to the draft.
   *
   * The entry is built by the main process so a project added here is identical to one added from the
   * table: same id derivation, same label, same default actions, one definition.
   */
  private async addPath(path: string): Promise<void> {
    const config = await window.api.buildProjectConfig(path);
    if (this.projects.some((project) => project.id === config.id)) {
      return;
    }
    this.projects.push({ ...config, actions: config.actions.map((action) => ({ ...action })) });
    this.touch();
    await this.revalidate();
    this.render();
  }

  private async detect(): Promise<void> {
    this.candidates = await window.api.detectProjects();
    this.showCandidates = true;
    this.render();
  }

  private async save(): Promise<void> {
    // Recorded before the writes: each one broadcasts, and the handler must already recognise the
    // state it is about to be told about.
    this.baseline = this.signature();
    await window.api.saveProjects(this.projects);
    await window.api.saveProfiles(this.profiles, this.defaultProfileId);
    // Clamped by the store, so a value typed outside the bounds comes back corrected rather than being
    // applied. The draft is realigned on it for the same reason.
    const saved = await window.api.updateSettings({
      terminalFontSize: this.fontSize,
      uiFontSize: this.uiFontSize,
      claudeAnalysisModel: this.claudeModels.analysis,
      claudeWorkModel: this.claudeModels.work,
      claudeCommitModel: this.claudeModels.commit,
    });
    this.fontSize = saved.terminalFontSize;
    this.uiFontSize = saved.uiFontSize;
    // Read back like the clamped sizes above, and for the same reason: the store normalises a value it
    // will not use to empty, so realigning the draft on what was actually stored is what makes the
    // field agree with the setting. Without it, a rejected value stays on screen looking saved.
    this.claudeModels = {
      analysis: saved.claudeAnalysisModel,
      work: saved.claudeWorkModel,
      commit: saved.claudeCommitModel,
    };

    // The token travels only when one was actually typed: an empty field means "keep the stored one".
    const jira = await window.api.saveJira(
      {
        siteUrl: this.jira.siteUrl,
        email: this.jira.email,
        projectKeys: [...this.jira.projectKeys],
      },
      this.jiraToken.length > 0 ? this.jiraToken : undefined,
    );
    this.jira = jira.config;
    this.jiraToken = '';
    this.jiraStatus = jira.message;
    this.saved = true;
    this.setDirty(false);
    // Re-rendered rather than just the footer: a font size the store clamped must show its corrected
    // value in the field, otherwise the form claims something the app is not doing.
    this.renderTerminal();
    this.renderJira();
    this.renderFooter();
    this.renderRail();
  }

  private signature(): string {
    return signatureOf(this.projects, this.defaultProfileId);
  }

  private touch(): void {
    this.saved = false;
    this.setDirty(true);
    // The rail reports the draft, not the saved file, so it follows every keystroke the footer does.
    void this.revalidate().then(() => {
      this.renderFooter();
      this.renderRail();
    });
  }

  /** Single place where the dirty flag changes, so the window is always told. */
  private setDirty(dirty: boolean): void {
    this.dirty = dirty;
    this.actions.onDirtyChange(dirty);
  }

  private async revalidate(): Promise<void> {
    this.validations = await window.api.validateProjects(this.projects);
  }

  /* ---------------------------------------------------------------- fields */

  /**
   * A labelled text field.
   *
   * `mono` is the one typographic decision this window makes and it is made here rather than in the
   * stylesheet: the mono face is reserved for values something else has to read back exactly — a path,
   * a command, a port, a model id, a project key. A name and a button label are words a person chose,
   * and they are set in the interface face like the rest of the app.
   */
  private field(
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder = '',
    mono = false,
  ): HTMLElement {
    const wrapper = createElement('label', {
      className: mono ? 'settings-field settings-field--mono' : 'settings-field',
    });
    wrapper.append(createElement('span', { className: 'settings-field__label', text: label }));
    const input = createElement('input', { className: 'settings-field__input' });
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    // `input` rather than `change`, so validation follows typing instead of waiting for blur.
    input.addEventListener('input', () => onChange(input.value));
    wrapper.append(input);
    return wrapper;
  }

  /** A labelled checkbox, laid out on one line unlike the stacked text fields. */
  private checkbox(
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
  ): HTMLElement {
    const wrapper = createElement('label', { className: 'settings-check' });
    const input = createElement('input', { className: 'settings-check__input' });
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    wrapper.append(input);
    wrapper.append(createElement('span', { className: 'settings-check__label', text: label }));
    return wrapper;
  }

  private select(
    label: string,
    options: readonly { value: string; label: string }[],
    value: string,
    onChange: (value: string) => void,
  ): HTMLElement {
    const wrapper = createElement('label', { className: 'settings-field' });
    wrapper.append(createElement('span', { className: 'settings-field__label', text: label }));
    // Never mono: the options are picked, not typed, and one of these lists holds profile names.
    const select = createElement('select', { className: 'settings-field__select' });
    for (const option of options) {
      const element = createElement('option', { text: option.label });
      element.value = option.value;
      select.append(element);
    }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    wrapper.append(select);
    return wrapper;
  }
}
