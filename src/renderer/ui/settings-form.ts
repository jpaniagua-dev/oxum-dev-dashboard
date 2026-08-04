import {
  TERMINAL_FONT_SIZE,
  type AppSettings,
  type ProjectAction,
  type ProjectCandidate,
  type ProjectConfig,
  type ProjectValidation,
  type ShellProfile,
} from '@shared/contracts.js';
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
type ProjectDraft = Omit<
  { -readonly [K in keyof ProjectConfig]: ProjectConfig[K] },
  'actions'
> & { actions: ActionDraft[] };
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

export interface SettingsFormHosts {
  readonly projects: HTMLElement;
  readonly terminal: HTMLElement;
  readonly footer: HTMLElement;
}

export interface SettingsFormActions {
  /** Reported so the window can warn before closing on unsaved edits. */
  readonly onDirtyChange: (dirty: boolean) => void;
  /** Asks the host to close the window. */
  readonly onRequestClose: () => void;
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

  constructor(
    private readonly hosts: SettingsFormHosts,
    private readonly actions: SettingsFormActions,
  ) {}

  /** Loads a fresh draft from the stored settings. */
  async load(settings: AppSettings, profiles: readonly ShellProfile[]): Promise<void> {
    // Deep copies down to the actions: the form must not mutate the state the dashboard renders from.
    this.projects = settings.projects.map((project) => ({
      ...project,
      actions: project.actions.map((action) => ({ ...action })),
    }));
    this.profiles = profiles.map((profile) => ({ ...profile, args: [...profile.args] }));
    this.defaultProfileId = settings.defaultShellProfileId;
    this.fontSize = settings.terminalFontSize;
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
    this.renderProjects();
    this.renderTerminal();
    this.renderFooter();
  }

  private renderProjects(): void {
    clearChildren(this.hosts.projects);

    if (this.projects.length === 0) {
      this.hosts.projects.append(
        createElement('p', {
          className: 'settings__empty',
          text: 'Aucun projet. Utilise « Détecter » pour trouver les dépôts, ou « Ajouter » pour choisir un dossier.',
        }),
      );
    }

    for (const project of this.projects) {
      this.hosts.projects.append(this.buildProjectCard(project));
    }

    const actions = createElement('div', { className: 'settings__row-actions' });

    const add = createElement('button', { className: 'button', text: '+ Ajouter un dossier' });
    add.type = 'button';
    add.addEventListener('click', () => void this.addByPicker());
    actions.append(add);

    const detect = createElement('button', { className: 'button', text: 'Détecter les dépôts' });
    detect.type = 'button';
    detect.addEventListener('click', () => void this.detect());
    actions.append(detect);

    this.hosts.projects.append(actions);

    if (this.showCandidates) {
      this.hosts.projects.append(this.buildCandidates());
    }
  }

  private buildProjectCard(project: ProjectDraft): HTMLElement {
    const validation = this.validations.find((entry) => entry.id === project.id);
    const hasError = validation?.issues.some((issue) => issue.level === 'error') ?? false;

    const card = createElement('div', {
      className: `settings-card${hasError ? ' settings-card--error' : ''}`,
    });

    const header = createElement('div', { className: 'settings-card__header' });
    header.append(
      this.field('Nom', project.label, (value) => {
        project.label = value;
        this.touch();
      }),
    );

    const remove = createElement('button', { className: 'button button--quiet', text: 'Supprimer' });
    remove.type = 'button';
    remove.title = 'Retirer ce projet du tableau';
    remove.addEventListener('click', () => {
      this.projects = this.projects.filter((entry) => entry !== project);
      this.touch();
      void this.revalidate().then(() => this.render());
    });
    header.append(remove);
    card.append(header);

    const pathRow = createElement('div', { className: 'settings-card__path' });
    pathRow.append(
      this.field('Dossier', project.path, (value) => {
        project.path = value;
        this.touch();
      }),
    );
    const browse = createElement('button', { className: 'button', text: '…' });
    browse.type = 'button';
    browse.title = 'Choisir un dossier';
    browse.addEventListener('click', () => {
      void window.api.pickFolder('Dossier du projet').then((picked) => {
        if (picked !== null) {
          project.path = picked;
          this.touch();
          void this.revalidate().then(() => this.render());
        }
      });
    });
    pathRow.append(browse);
    card.append(pathRow);

    const grid = createElement('div', { className: 'settings-card__grid' });

    // Both of these are inferred from the repository, so the placeholder states what will be used
    // when the field is left alone rather than pretending the value is unset.
    grid.append(
      this.select(
        'Type',
        [
          { value: '', label: `déduit (${validation?.inferredKind ?? '?'})` },
          { value: 'server', label: 'server' },
          { value: 'watch', label: 'watch' },
        ],
        project.kind ?? '',
        (value) => {
          project.kind = value === 'server' || value === 'watch' ? value : null;
          this.touch();
        },
      ),
    );

    grid.append(
      this.field(
        'Port',
        project.expectedPort === null ? '' : String(project.expectedPort),
        (value) => {
          const parsed = Number.parseInt(value, 10);
          project.expectedPort = Number.isFinite(parsed) ? parsed : null;
          this.touch();
        },
        validation?.inferredPort === null || validation?.inferredPort === undefined
          ? 'aucun'
          : `déduit ${validation.inferredPort}`,
      ),
    );

    card.append(grid);
    card.append(this.buildActionsEditor(project, validation));

    if (validation !== undefined && validation.issues.length > 0) {
      const issues = createElement('ul', { className: 'settings-card__issues' });
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
          className: 'settings-card__hint',
          text: `Scripts disponibles : ${validation.scripts.slice(0, 8).join(', ')}`,
        }),
      );
    }

    return card;
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
    box.append(
      createElement('span', { className: 'settings-actions__title', text: 'Actions' }),
    );

    if (project.actions.length === 0) {
      box.append(
        createElement('p', {
          className: 'settings-actions__empty',
          text: 'Aucune action : la ligne n’aura aucun bouton.',
        }),
      );
    }

    for (const action of project.actions) {
      box.append(this.buildActionRow(project, action, validation));
    }

    const add = createElement('button', { className: 'button', text: '+ Action' });
    add.type = 'button';
    add.title = 'Ajouter une commande à lancer sur ce projet';
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
  ): HTMLElement {
    const row = createElement('div', { className: 'settings-action' });

    row.append(
      this.field('Bouton', action.label, (value) => {
        // Only the label changes: the id keys the terminal tab, so re-deriving it here would orphan a
        // process the user started from this very button.
        action.label = value;
        this.touch();
      }),
    );

    row.append(
      this.field(
        'Commande',
        action.command,
        (value) => {
          action.command = value;
          this.touch();
        },
        action.role === 'server' && validation?.serverCommand !== undefined
          ? 'npm run start'
          : 'commande à lancer',
      ),
    );

    row.append(
      this.select(
        'Shell',
        [
          { value: '', label: 'profil par défaut' },
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
        'Rôle',
        [
          { value: 'task', label: 'tâche' },
          { value: 'server', label: 'serveur' },
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
    remove.title = `Supprimer « ${action.label} »`;
    remove.addEventListener('click', () => {
      project.actions = project.actions.filter((entry) => entry !== action);
      this.touch();
      void this.revalidate().then(() => this.render());
    });
    row.append(remove);

    return row;
  }

  private buildCandidates(): HTMLElement {
    const box = createElement('div', { className: 'settings-candidates' });
    if (this.candidates.length === 0) {
      box.append(
        createElement('p', { className: 'settings__empty', text: 'Aucun dépôt candidat trouvé.' }),
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
        text: candidate.alreadyAdded ? 'déjà ajouté' : 'Ajouter',
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
      'Profil par défaut',
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
        'Taille de police',
        String(this.fontSize),
        (value) => {
          const parsed = Number.parseInt(value, 10);
          // An unparseable or out-of-range value falls back to the default rather than being stored:
          // the field would otherwise be able to make the terminal unreadable while you type in it.
          this.fontSize = Number.isFinite(parsed) ? parsed : TERMINAL_FONT_SIZE.default;
          this.touch();
        },
        `${TERMINAL_FONT_SIZE.min} à ${TERMINAL_FONT_SIZE.max}`,
      ),
    );
    this.hosts.terminal.append(row);

    for (const profile of this.profiles) {
      const card = createElement('div', { className: 'settings-card' });
      const header = createElement('div', { className: 'settings-card__header' });
      // The name is editable like any other field: "Git Bash" is only what detection guessed, and a
      // profile the user points elsewhere deserves a name that says so.
      header.append(
        this.field('Nom', profile.label, (value) => {
          profile.label = value;
          profile.detected = false;
          this.touch();
        }),
        createElement('span', {
          className: 'settings-card__badge',
          // Says where the value came from, so an overridden profile is obviously deliberate.
          text: profile.detected ? 'détecté' : 'personnalisé',
        }),
      );
      card.append(header);

      const row = createElement('div', { className: 'settings-card__path' });
      row.append(
        this.field('Chemin du binaire', profile.file, (value) => {
          profile.file = value;
          profile.detected = false;
          this.touch();
        }),
      );
      const browse = createElement('button', { className: 'button', text: '…' });
      browse.type = 'button';
      browse.addEventListener('click', () => {
        void window.api.pickFolder(`Binaire de ${profile.label}`).then((picked) => {
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

      const grid = createElement('div', { className: 'settings-card__grid' });
      grid.append(
        this.field('Arguments', profile.args.join(' '), (value) => {
          profile.args = value.split(/\s+/).filter((arg) => arg.length > 0);
          this.touch();
        }),
      );
      grid.append(
        this.field('Dossier de départ', profile.cwd, (value) => {
          profile.cwd = value;
          this.touch();
        }),
      );
      card.append(grid);
      this.hosts.terminal.append(card);
    }
  }

  private renderFooter(): void {
    clearChildren(this.hosts.footer);

    const status = createElement('span', {
      className: this.dirty ? 'settings__status' : 'settings__status settings__status--ok',
      text: this.dirty
        ? 'modifications non enregistrées'
        : this.saved
          ? 'modifications enregistrées'
          : '',
    });
    this.hosts.footer.append(status);

    const close = createElement('button', { className: 'button', text: 'Fermer' });
    close.type = 'button';
    close.addEventListener('click', () => this.actions.onRequestClose());
    this.hosts.footer.append(close);

    const save = createElement('button', { className: 'button button--primary', text: 'Enregistrer' });
    save.type = 'button';
    // Saving a configuration with a broken path would produce a row that can never run.
    const blocked = this.validations.some((entry) =>
      entry.issues.some((issue) => issue.level === 'error'),
    );
    save.disabled = blocked;
    if (blocked) {
      save.title = 'Corrige les erreurs signalées avant d’enregistrer';
    }
    save.addEventListener('click', () => void this.save());
    this.hosts.footer.append(save);
  }

  /* --------------------------------------------------------------- actions */

  private async addByPicker(): Promise<void> {
    const picked = await window.api.pickFolder('Dossier du projet');
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
    const saved = await window.api.updateSettings({ terminalFontSize: this.fontSize });
    this.fontSize = saved.terminalFontSize;
    this.saved = true;
    this.setDirty(false);
    // Re-rendered rather than just the footer: a font size the store clamped must show its corrected
    // value in the field, otherwise the form claims something the app is not doing.
    this.renderTerminal();
    this.renderFooter();
  }

  private signature(): string {
    return signatureOf(this.projects, this.defaultProfileId);
  }

  private touch(): void {
    this.saved = false;
    this.setDirty(true);
    void this.revalidate().then(() => this.renderFooter());
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

  private field(
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder = '',
  ): HTMLElement {
    const wrapper = createElement('label', { className: 'settings-field' });
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

  private select(
    label: string,
    options: readonly { value: string; label: string }[],
    value: string,
    onChange: (value: string) => void,
  ): HTMLElement {
    const wrapper = createElement('label', { className: 'settings-field' });
    wrapper.append(createElement('span', { className: 'settings-field__label', text: label }));
    const select = createElement('select', { className: 'settings-field__input' });
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
