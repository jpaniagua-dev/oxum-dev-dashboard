import type {
  AppSettings,
  JiraIssue,
  JiraState,
  JiraViewId,
  NotesState,
  Project,
  ProjectId,
  ProjectRow,
  RepoPulls,
  ShellProfile,
  StripTab,
  ThemeMode,
  ThemeState,
} from '@shared/contracts.js';
import { showContextMenu } from './ui/context-menu.js';
import { requireElement } from './ui/dom.js';
import { renderJiraList } from './ui/jira-list.js';
import { NotesPanel } from './ui/notes-panel.js';
import { attachPaneResizer } from './ui/pane-resizer.js';
import { renderProjectTable } from './ui/project-table.js';
import { renderPullList } from './ui/pull-list.js';
import { attachSideResizer } from './ui/side-resizer.js';
import { StripTabs } from './ui/strip-tabs.js';
import { TerminalPane } from './ui/terminal-pane.js';

/**
 * Application shell.
 *
 * State lives in one place and the views are rebuilt from it, rather than each widget tracking its
 * own copy. With a handful of rows that is both simpler and impossible to desynchronise.
 */
class App {
  private projects: readonly Project[] = [];
  private rows: readonly ProjectRow[] = [];
  private profiles: readonly ShellProfile[] = [];
  private settings: AppSettings | null = null;
  private theme: ThemeState = { mode: 'system', resolved: 'light' };
  private terminal: TerminalPane | null = null;
  /** Terminals whose buffered output has already been replayed, so it is not duplicated. */
  private readonly replayed = new Set<string>();
  /**
   * True while an inline rename is open in the table.
   *
   * The table is rebuilt on every git poll, which is every ten seconds. Without this guard a refresh
   * landing mid-typing would replace the input and throw the half-typed name away.
   */
  private editingRow = false;
  private pulls: readonly RepoPulls[] = [];
  /** Repository selected in the pull request tab, so a refresh does not jump back to the first. */
  private selectedRepo: ProjectId | null = null;
  private jira: JiraState | null = null;
  private selectedJiraView: JiraViewId = 'mine';
  private strip: StripTabs | null = null;
  private resizer: { setHeight: (height: number) => void } | null = null;
  private notes: NotesPanel | null = null;
  private notesResizer: { setWidth: (width: number) => void } | null = null;

  async start(): Promise<void> {
    const bootstrap = await window.api.bootstrap();
    this.projects = bootstrap.projects;
    this.settings = bootstrap.settings;
    this.profiles = bootstrap.shellProfiles;
    this.applyTheme(bootstrap.theme);

    this.terminal = new TerminalPane(requireElement('terminal-tabs'), requireElement('terminal-surface'), {
      onInput: (terminalId, data) => window.api.sendPtyInput(terminalId, data),
      onResize: (terminalId, cols, rows) => window.api.resizePty(terminalId, { cols, rows }),
      onClose: (terminalId) => void window.api.closeTerminal(terminalId),
      onRename: (terminalId, title) => void window.api.renameTerminal(terminalId, title),
      onNewShell: (profileId) => void this.openShell(profileId),
      // Reported rather than dropped: an `invoke` on a channel the main process does not know rejects,
      // and a bare `void` would turn that into an unhandled rejection nobody sees. That is precisely
      // how a stale main process makes a gesture look inert instead of broken.
      onReorder: (orderedIds) => {
        window.api.reorderTerminals(orderedIds).catch((error: unknown) => {
          console.error('[terminal] reordonnancement refuse:', error);
        });
      },
      onLayout: (panes, direction) => {
        window.api.setTerminalLayout(panes, direction).catch((error: unknown) => {
          console.error('[terminal] disposition refusee:', error);
        });
      },
      onSplitShell: (cwd, direction) => void this.splitShell(cwd, direction),
      onCopy: (text) => void window.api.writeClipboard(text),
      onPasteRequest: () => window.api.readClipboard(),
    });
    this.terminal.setTheme(this.theme.resolved);
    this.terminal.setFontSize(bootstrap.settings.terminalFontSize);
    this.terminal.setProfiles(this.profiles);
    // Adopt whatever is already running before deciding to open anything, sessions first: the layout
    // names sessions, so a layout applied to an empty strip would resolve to nothing.
    this.terminal.setSessions(bootstrap.terminals);
    this.terminal.setLayout(bootstrap.layout);

    this.pulls = bootstrap.pulls;
    this.jira = bootstrap.jira;
    this.bindChrome();
    this.bindStrip(bootstrap.settings);
    this.bindNotes(bootstrap.settings, bootstrap.notes);
    this.renderTable();
    this.renderPulls();
    this.renderJira();

    window.api.onRowsChanged((rows) => {
      this.rows = rows;
      this.renderTable();
      this.stampRefresh();
    });
    window.api.onPullsChanged((repos) => {
      this.pulls = repos;
      this.renderPulls();
    });
    window.api.onJiraChanged((state) => {
      this.jira = state;
      this.renderJira();
    });
    // Safe to apply mid-typing: `NotesState` carries no note body, so it cannot reach the editor.
    window.api.onNotesChanged((state) => this.notes?.apply(state));
    window.api.onTerminalsChanged((sessions) => this.terminal?.setSessions(sessions));
    window.api.onTerminalLayoutChanged((layout) => this.terminal?.setLayout(layout));
    window.api.onPtyOutput(({ terminalId, data }) => this.terminal?.write(terminalId, data));
    window.api.onThemeChanged((state) => this.applyTheme(state));

    this.rows = await window.api.refreshNow();
    this.renderTable();
    this.stampRefresh();

    // Open a shell straight away, but only when there is none: the pane should be usable as a
    // terminal immediately, without stacking a new tab on every renderer reload.
    if (bootstrap.terminals.length === 0) {
      const preferred = this.settings?.defaultShellProfileId ?? '';
      const profile = this.profiles.find((entry) => entry.id === preferred) ?? this.profiles[0];
      if (profile !== undefined) {
        await this.openShell(profile.id);
      }
    }
  }

  /**
   * Re-reads everything after a settings change.
   *
   * Refetching the whole bootstrap rather than patching each field: the project list, the profiles
   * and the tab strip all derive from it, and the change may come from the settings window, where no
   * local knowledge of what changed is available.
   */
  private async reloadAfterSettings(): Promise<void> {
    const bootstrap = await window.api.bootstrap();
    this.projects = bootstrap.projects;
    this.settings = bootstrap.settings;
    this.profiles = bootstrap.shellProfiles;
    this.terminal?.setProfiles(this.profiles);
    this.terminal?.setFontSize(bootstrap.settings.terminalFontSize);
    this.rows = await window.api.refreshNow();
    this.renderTable();
    this.stampRefresh();
  }

  /* ---------------------------------------------------------------- render */

  private renderTable(): void {
    if (this.editingRow) {
      // A rename is open: the refresh is dropped rather than queued, since the next poll is seconds
      // away and will show the same data.
      return;
    }
    renderProjectTable(requireElement('project-tbody'), this.rows, {
      onRunAction: (projectId, actionId) => void this.runAction(projectId, actionId),
      onRename: (projectId, label) => void this.renameProject(projectId, label),
      onEditingChange: (editing) => {
        this.editingRow = editing;
      },
      onStop: (projectId) => void this.stopProject(projectId),
      onOpenFolder: (projectId) => void window.api.openFolder(projectId),
      onOpenTerminal: (projectId) => void this.openShellInProject(projectId),
    });
  }

  private renderJira(): void {
    if (this.jira === null) {
      return;
    }
    renderJiraList(
      { views: requireElement('jira-views'), list: requireElement('jira-list') },
      this.jira,
      this.selectedJiraView,
      {
        onOpen: (url) => void window.api.openExternal(url),
        onSelect: (view) => {
          this.selectedJiraView = view;
          this.renderJira();
        },
        onMenu: (issue, x, y) => void this.openIssueMenu(issue, x, y),
      },
    );
  }

  /**
   * The actions of one issue: assigning it to yourself and moving it.
   *
   * The transitions are asked for **when the menu opens**, not cached: a workflow decides which moves are
   * legal from the current status, so a cached list would offer moves Jira would then refuse. The cost is
   * one request per right-click, which is the right trade for never lying about what is possible.
   */
  private async openIssueMenu(issue: JiraIssue, x: number, y: number): Promise<void> {
    const transitions = await window.api.jiraTransitions(issue.key);
    const items = [
      {
        label: issue.isMine ? 'Déjà assigné à toi' : 'M’assigner ce ticket',
        disabled: issue.isMine,
        run: () => void this.runJiraWrite(() => window.api.assignJiraToMe(issue.key)),
      },
      ...transitions.map((transition) => ({
        label: `Passer en « ${transition.label} »`,
        run: () =>
          void this.runJiraWrite(() => window.api.transitionJira(issue.key, transition.id)),
      })),
      {
        label: 'Ouvrir dans le navigateur',
        run: () => void window.api.openExternal(issue.url),
      },
    ];
    if (transitions.length === 0) {
      items.splice(1, 0, {
        // Says why rather than showing a menu that looks broken: no transitions usually means the
        // connection failed, not that the issue is frozen.
        label: 'Aucune transition disponible',
        disabled: true,
        run: () => {},
      });
    }
    showContextMenu(x, y, items);
  }

  /** Runs a Jira write and reports its outcome where the user is looking. */
  private async runJiraWrite(write: () => Promise<{ ok: boolean; message: string }>): Promise<void> {
    const result = await write();
    this.stampMessage(result.message);
    if (!result.ok) {
      console.warn('[jira]', result.message);
    }
  }

  /** Shows a short-lived message in the top bar, next to the refresh stamp. */
  private stampMessage(message: string): void {
    requireElement('last-refresh').textContent = message;
    window.setTimeout(() => this.stampRefresh(), 4000);
  }

  private renderPulls(): void {
    renderPullList(
      { repos: requireElement('pulls-repos'), list: requireElement('pulls-list') },
      this.pulls,
      this.selectedRepo,
      {
        // Same gesture as a click on a project row, and it goes through the same reuse path: seeing a
        // pull request usually means going to work on it.
        onOpenTerminal: (projectId) => void this.openShellInProject(projectId),
        onOpenPull: (url) => void window.api.openExternal(url),
        onSelect: (projectId) => {
          this.selectedRepo = projectId;
          this.renderPulls();
        },
      },
    );
  }

  private stampRefresh(): void {
    requireElement('last-refresh').textContent = `maj ${new Date().toLocaleTimeString('fr-CH', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })}`;
  }

  /* --------------------------------------------------------------- actions */

  /** Runs one of a project's actions and brings its tab forward. */
  private async runAction(projectId: ProjectId, actionId: string): Promise<void> {
    const terminalId = await window.api.runAction(projectId, actionId);
    if (terminalId !== null) {
      await this.focusTerminal(terminalId);
    }
  }

  /**
   * Stops the project's server action.
   *
   * One call naming the project, no session hunting here. The renderer used to look up the server
   * action and then the session carrying its id, and both hops returned nothing without a word when
   * the two sides disagreed about the shape of a session: `Stop` became a button that did nothing.
   * The main process holds the sessions and the roles, so it answers the question.
   */
  private async stopProject(projectId: ProjectId): Promise<void> {
    const stopped = await window.api.stopProjectServer(projectId);
    if (!stopped) {
      console.warn(`[stop] rien à arrêter pour ${projectId}`);
    }
  }

  /**
   * Opens a shell for a split, in the directory of the pane being divided.
   *
   * Deliberately not routed through `focusTerminal`: that one gives the new session the focused pane,
   * which is exactly what a split must not do. The pane is added beside it instead.
   */
  private async splitShell(cwd: string, direction: 'columns' | 'rows'): Promise<void> {
    const preferred = this.settings?.defaultShellProfileId ?? '';
    const profile = this.profiles.find((entry) => entry.id === preferred) ?? this.profiles[0];
    if (profile === undefined) {
      return;
    }
    const terminalId = await window.api.openShell({ profileId: profile.id, cwd });
    if (terminalId !== null) {
      this.terminal?.addPane(terminalId, direction);
      await this.replayBuffer(terminalId);
    }
  }

  private async openShell(profileId: string): Promise<void> {
    const terminalId = await window.api.openShell({ profileId });
    if (terminalId !== null) {
      await this.focusTerminal(terminalId);
    }
  }

  /**
   * Opens the repository's shell, or brings back the one already open there.
   *
   * Triggered by a click anywhere on the row, and by the `>_` button. The main process resolves the
   * project, the profile and the existing tab: doing it here meant three lookups the renderer had no
   * authority over, and reuse could not be decided at all.
   */
  private async openShellInProject(projectId: ProjectId): Promise<void> {
    const terminalId = await window.api.openProjectShell(projectId);
    if (terminalId !== null) {
      await this.focusTerminal(terminalId);
    }
  }

  /**
   * Renames a project.
   *
   * Only the label changes; the id stays derived from the folder, which is what keeps a running
   * terminal attached to the row it belongs to.
   */
  private async renameProject(projectId: ProjectId, label: string): Promise<void> {
    if (this.settings === null) {
      return;
    }
    // No explicit reload: saving makes the main process rebuild and broadcast, and the handler for
    // that event refreshes the view.
    await window.api.saveProjects(
      this.settings.projects.map((project) =>
        project.id === projectId ? { ...project, label } : project,
      ),
    );
  }

  /**
   * Adds a project straight from the main view.
   *
   * A folder is all the dashboard needs: the type and the port come from the repository's own
   * `package.json`, so the fast path is a picker rather than the settings window. The entry itself is
   * built by the main process, which is the single definition of what a new project looks like.
   */
  private async addProject(): Promise<void> {
    const picked = await window.api.pickFolder('Dossier du projet à ajouter');
    if (picked === null || this.settings === null) {
      return;
    }

    const config = await window.api.buildProjectConfig(picked);
    if (this.settings.projects.some((project) => project.id === config.id)) {
      // Already watched: switching to its terminal is more useful than a duplicate row.
      void this.openShellInProject(config.id);
      return;
    }

    await window.api.saveProjects([...this.settings.projects, config]);
  }

  private async focusTerminal(terminalId: string): Promise<void> {
    this.terminal?.select(terminalId);
    await this.replayBuffer(terminalId);
  }

  /**
   * Replays what a session printed before its view existed, once and only once.
   *
   * A tab can collect output long before it is ever displayed, and a view created on first display
   * would otherwise start empty and lose everything the process had already said.
   */
  private async replayBuffer(terminalId: string): Promise<void> {
    if (this.replayed.has(terminalId)) {
      return;
    }
    this.replayed.add(terminalId);
    const buffer = await window.api.readPtyBuffer(terminalId);
    if (buffer.length > 0) {
      this.terminal?.reset(terminalId, buffer);
    }
  }

  /* ----------------------------------------------------------------- chrome */

  private bindChrome(): void {
    requireElement<HTMLButtonElement>('refresh-button').addEventListener('click', () => {
      // Refreshes whichever view is on screen: on the pull request tab, the project poll is not what the
      // button is being pressed for.
      if (this.strip?.active === 'pulls') {
        void window.api.refreshPulls().then((repos) => {
          this.pulls = repos;
          this.renderPulls();
          this.stampRefresh();
        });
        return;
      }
      if (this.strip?.active === 'jira') {
        void window.api.refreshJira().then((state) => {
          this.jira = state;
          this.renderJira();
          this.stampRefresh();
        });
        return;
      }
      void window.api.refreshNow().then((rows) => {
        this.rows = rows;
        this.renderTable();
        this.stampRefresh();
      });
    });

    requireElement<HTMLButtonElement>('terminal-clear').addEventListener('click', () => {
      this.terminal?.clearActive();
    });

    requireElement<HTMLButtonElement>('theme-button').addEventListener('click', () => {
      void this.cycleTheme();
    });

    requireElement<HTMLButtonElement>('add-project').addEventListener('click', () => {
      void this.addProject();
    });

    requireElement<HTMLButtonElement>('settings-button').addEventListener('click', () => {
      void window.api.openSettings();
    });

    /*
     * Settings now change from another window, so this event is the only signal that anything moved.
     * The whole view is rebuilt from it rather than patching the local copy: the project list, the
     * table and the new-tab menu all derive from settings, and guessing which ones changed is how
     * they drift apart.
     */
    window.api.onSettingsChanged((settings) => {
      this.settings = settings;
      void this.reloadAfterSettings();
    });
  }

  /**
   * The strip: its two tabs and its resizer, which share one state.
   *
   * The height is written to the key of the **active** tab, and applied again on every tab change. One
   * resizer for both, because there is only ever one strip: a second instance would fight the first over
   * the same element.
   */
  private bindStrip(settings: AppSettings): void {
    this.resizer = attachPaneResizer({
      handle: requireElement('projects-resizer'),
      pane: requireElement('projects-pane'),
      initialHeight: heightOf(settings, settings.activeStrip),
      onResize: () => this.terminal?.refit(),
      onCommit: (height) => {
        const rounded = Math.round(height);
        const key = heightKeyOf(this.strip?.active ?? 'projects');
        if (this.settings !== null) {
          this.settings = { ...this.settings, [key]: rounded };
        }
        void window.api.updateSettings({ [key]: rounded });
      },
    });

    this.strip = new StripTabs({
      onChange: (tab) => {
        if (this.settings !== null) {
          this.resizer?.setHeight(heightOf(this.settings, tab));
        }
        void window.api.updateSettings({ activeStrip: tab });
        // The terminal's geometry changed with the strip's: without this its pty keeps the old size.
        this.terminal?.refit();
      },
    });
    this.strip.adopt(settings.activeStrip);
  }

  /* ------------------------------------------------------------------ notes */

  /**
   * The notes panel, its resizer and its toggle.
   *
   * The panel changes the workspace's **width** and nothing else, so every entry point that moves it
   * also refits the terminal: the window `resize` listener inside `TerminalPane` does not fire here,
   * since the window did not resize. Three places need it, and all three are in this method.
   */
  private bindNotes(settings: AppSettings, initial: NotesState): void {
    const panel = requireElement('notes-panel');
    const handle = requireElement('notes-resizer');
    const button = requireElement('notes-button');

    this.notes = new NotesPanel(
      {
        list: requireElement('notes-list'),
        formatBar: requireElement('notes-format-bar'),
        surface: requireElement('notes-surface'),
        status: requireElement('notes-status'),
        newButton: requireElement('notes-new'),
        panel,
      },
      {
        onText: (id, text) => window.api.updateNote(id, text),
        onCreate: () => window.api.createNote(),
        onOpen: async (id) => (await window.api.openNote(id))?.text ?? null,
        onDelete: (id) => window.api.deleteNote(id),
      },
      initial,
      this.theme.resolved,
    );

    this.notesResizer = attachSideResizer({
      handle,
      panel,
      initialWidth: settings.notesWidth,
      onResize: () => this.terminal?.refit(),
      onCommit: (width) => {
        const rounded = Math.round(width);
        if (this.settings !== null) {
          this.settings = { ...this.settings, notesWidth: rounded };
        }
        void window.api.updateSettings({ notesWidth: rounded });
      },
    });

    button.addEventListener('click', () => this.toggleNotes(!this.notesOpen()));
    panel.addEventListener('notes-escape', () => this.toggleNotes(false));

    /*
     * `Alt+Shift+N`, matching the terminal's own `Alt+Shift+{d,b,w}` and for the same reasons: capture
     * phase, because a focused xterm or CodeMirror would otherwise swallow it; `Alt+Shift` rather than
     * `Ctrl+Alt`, which is AltGr on a Swiss French layout; a letter rather than a digit; and a guard on
     * `event.repeat`, without which holding the keys toggles the panel dozens of times.
     */
    document.addEventListener(
      'keydown',
      (event) => {
        if (
          event.repeat ||
          !event.altKey ||
          !event.shiftKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.code !== 'KeyN'
        ) {
          return;
        }
        event.preventDefault();
        this.toggleNotes(!this.notesOpen());
      },
      true,
    );
    // Reopens where it was left, and applies the stored width through the resizer's own clamp.
    this.toggleNotes(settings.notesOpen, { persist: false });
  }

  private notesOpen(): boolean {
    return !requireElement('notes-panel').hidden;
  }

  private toggleNotes(open: boolean, options: { persist?: boolean } = {}): void {
    const panel = requireElement('notes-panel');
    const handle = requireElement('notes-resizer');
    const button = requireElement('notes-button');

    panel.hidden = !open;
    handle.hidden = !open;
    button.setAttribute('aria-pressed', String(open));
    button.setAttribute('aria-label', open ? 'Masquer les notes' : 'Afficher les notes');

    if (open) {
      this.notesResizer?.setWidth(this.settings?.notesWidth ?? 340);
      void this.notes?.openFirst();
    }
    // The workspace just changed width; the ptys have not been told.
    this.terminal?.refit();

    if (options.persist !== false) {
      if (this.settings !== null) {
        this.settings = { ...this.settings, notesOpen: open };
      }
      void window.api.updateSettings({ notesOpen: open });
    }
  }

  /* ------------------------------------------------------------------ theme */

  private applyTheme(state: ThemeState): void {
    this.theme = state;
    document.documentElement.dataset.theme = state.resolved;
    this.terminal?.setTheme(state.resolved);
    this.notes?.setTheme(state.resolved);
    this.renderThemeIcon();
  }

  private async cycleTheme(): Promise<void> {
    this.applyTheme(await window.api.setThemeMode(nextThemeMode(this.theme.mode)));
  }

  private renderThemeIcon(): void {
    const button = requireElement<HTMLButtonElement>('theme-button');
    button.title = `Thème : ${describeThemeMode(this.theme.mode)}`;

    const icon = document.getElementById('theme-icon');
    if (icon === null) {
      return;
    }
    icon.replaceChildren();
    const spec = THEME_ICONS[this.theme.mode];
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', spec.path);
    if (spec.paint === 'stroke') {
      shape.setAttribute('fill', 'none');
      shape.setAttribute('stroke', 'currentColor');
      shape.setAttribute('stroke-width', '1.4');
      shape.setAttribute('stroke-linecap', 'round');
    } else {
      shape.setAttribute('fill', 'currentColor');
    }
    icon.append(shape);
  }
}

/**
 * Sun for light, moon for dark, half-filled disc for "follow the system".
 *
 * The sun is strokes, because its rays are lines a fill cannot express; the others are solid.
 */
const THEME_ICONS: Record<ThemeMode, { path: string; paint: 'fill' | 'stroke' }> = {
  light: {
    path: 'M8 10.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM8 3.3V1.6M8 14.4v-1.7M3.5 8H1.8M14.2 8h-1.7M4.8 4.8 3.6 3.6M12.4 12.4l-1.2-1.2M11.2 4.8l1.2-1.2M4.8 11.2l-1.2 1.2',
    paint: 'stroke',
  },
  dark: { path: 'M9.4 1.9a6.2 6.2 0 1 0 4.7 8.9A5 5 0 0 1 9.4 1.9z', paint: 'fill' },
  system: {
    path: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm0 1.6v9.8a4.9 4.9 0 0 1 0-9.8z',
    paint: 'fill',
  },
};

/** Remembered height of one strip tab. */
function heightOf(settings: AppSettings, tab: StripTab): number {
  switch (tab) {
    case 'pulls':
      return settings.pullsHeight;
    case 'jira':
      return settings.jiraHeight;
    case 'projects':
      return settings.projectsHeight;
  }
}

/** Settings key that stores a tab's height. */
function heightKeyOf(tab: StripTab): 'projectsHeight' | 'pullsHeight' | 'jiraHeight' {
  switch (tab) {
    case 'pulls':
      return 'pullsHeight';
    case 'jira':
      return 'jiraHeight';
    case 'projects':
      return 'projectsHeight';
  }
}

function nextThemeMode(mode: ThemeMode): ThemeMode {
  switch (mode) {
    case 'light':
      return 'dark';
    case 'dark':
      return 'system';
    case 'system':
      return 'light';
  }
}

function describeThemeMode(mode: ThemeMode): string {
  switch (mode) {
    case 'light':
      return 'clair';
    case 'dark':
      return 'sombre';
    case 'system':
      return 'système';
  }
}

// A rejected bootstrap used to fail silently, leaving the window up but half-initialised with no
// trace anywhere. Reporting it is what makes such a failure findable.
void new App().start().catch((error: unknown) => {
  console.error('[bootstrap] echec du demarrage du renderer:', error);
});
