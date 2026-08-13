import type {
  AppSettings,
  GitDiff,
  GitDiffTarget,
  GitRepoState,
  GitSyncOp,
  JiraIssue,
  JiraState,
  JiraViewId,
  NotesState,
  Project,
  ProjectId,
  ProjectRow,
  PullScope,
  RepoPulls,
  ShellProfile,
  StripTab,
  ThemeMode,
  ThemeState,
} from '@shared/contracts.js';
import { showContextMenu } from './ui/context-menu.js';
import { hitsInteractive, requireElement } from './ui/dom.js';
import {
  buildCommitMenuItems,
  buildRepoMenuItems,
  buildStashMenuItems,
  defaultTargetFor,
  renderGitPanel,
  type GitPanelActions,
  type GitPanelState,
  type GitViewId,
} from './ui/git-panel.js';
import { attachGitSplitter } from './ui/git-split.js';
import {
  DEFAULT_JIRA_SORT,
  nextSort,
  renderJiraList,
  type JiraSort,
  type JiraSortKey,
} from './ui/jira-list.js';
import { NotesPanel } from './ui/notes-panel.js';
import { attachPaneResizer } from './ui/pane-resizer.js';
import { renderProjectTable } from './ui/project-table.js';
import { renderPullList } from './ui/pull-list.js';
import { attachSideResizer } from './ui/side-resizer.js';
import { StripTabs } from './ui/strip-tabs.js';
import { TerminalPane } from './ui/terminal-pane.js';
import { applyUiFontSize } from './ui/ui-font.js';

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
  /** Which pull requests the tab lists. Mirrors `settings.pullScope`, so it survives a restart. */
  private pullScope: PullScope = 'mine';
  private jira: JiraState | null = null;
  private selectedJiraView: JiraViewId = 'mine';
  /*
   * Jira filter and sort.
   *
   * Deliberately **not** persisted, unlike the pull request scope. A hidden filter that comes back at
   * the next launch is how a list silently stops showing half the sprint, and the reason would be a
   * dropdown nobody remembers setting. The scope of a pull request tab is a preference; a filter is a
   * question you asked once.
   */
  private jiraAssignee = '';
  private jiraSort: JiraSort = DEFAULT_JIRA_SORT;
  /**
   * Project the last branch was created in, offered first the next time.
   *
   * Session-local for the same reason: it is a shortcut, not a setting, and a stale one would put the
   * wrong repository at the top of a menu whose whole point is picking the right one.
   */
  private lastBranchProject: ProjectId | null = null;
  /*
   * Git tab state.
   *
   * All of it lives here rather than inside the panel because the panel is rebuilt whole on every
   * refresh: a draft message or a selected file kept in the DOM would be thrown away every ten
   * seconds. `gitEditing` is the same guard as `editingRow` and for the same reason.
   */
  private gitProject: ProjectId | null = null;
  private gitRepo: GitRepoState | null = null;
  private gitView: GitViewId = 'changes';
  private gitTarget: GitDiffTarget | null = null;
  private gitDiff: GitDiff | null = null;
  private gitMessage = '';
  private gitBranchDraft = '';
  private gitStashDraft = '';
  private gitStashUntracked = false;
  private gitBusy = false;
  private gitEditing = false;
  private strip: StripTabs | null = null;
  /** Whether the top strip is folded down to its tab row. Mirrors `settings.stripCollapsed`. */
  private stripCollapsed = false;
  private resizer: { setHeight: (height: number) => void } | null = null;
  /** The Git tab's list/diff separator. Held so a settings change can reapply the stored width. */
  private gitSplitter: { setWidth: (width: number) => void } | null = null;
  private notes: NotesPanel | null = null;
  private notesResizer: { setWidth: (width: number) => void } | null = null;

  async start(): Promise<void> {
    const bootstrap = await window.api.bootstrap();
    this.projects = bootstrap.projects;
    this.settings = bootstrap.settings;
    this.profiles = bootstrap.shellProfiles;
    this.applyTheme(bootstrap.theme);
    // Before anything is measured: the strip resizer and the terminal's fit both read pixel sizes that
    // the text size decides, so applying it afterwards would fit them to a layout already gone.
    applyUiFontSize(bootstrap.settings.uiFontSize);

    this.terminal = new TerminalPane(
      requireElement('terminal-surface'),
      {
        onInput: (terminalId, data) => window.api.sendPtyInput(terminalId, data),
        onResize: (terminalId, cols, rows) => window.api.resizePty(terminalId, { cols, rows }),
        onClose: (terminalId) => void window.api.closeTerminal(terminalId),
        onRename: (terminalId, title) => void window.api.renameTerminal(terminalId, title),
        onNewShell: (profileId) => void this.openShell(profileId),
        // Reported rather than dropped: an `invoke` on a channel the main process does not know
        // rejects, and a bare `void` would turn that into an unhandled rejection nobody sees. That is
        // precisely how a stale main process makes a gesture look inert instead of broken.
        onLayout: (groups, direction) => {
          window.api.setTerminalLayout(groups, direction).catch((error: unknown) => {
            console.error('[terminal] layout refused:', error);
          });
        },
        onSplitShell: (cwd, direction) => void this.splitShell(cwd, direction),
        onCopy: (text) => void window.api.writeClipboard(text),
        onPasteRequest: () => window.api.readClipboard(),
        // Both ends, or none. ConPTY keeps its own copy of the screen and reprints it at the next
        // repaint it decides, which puts back the exact text that was just cleared.
        onClear: (terminalId) => window.api.clearPty(terminalId),
      },
      bootstrap.terminalCompat,
    );
    this.terminal.setTheme(this.theme.resolved);
    this.terminal.setFontSize(bootstrap.settings.terminalFontSize);
    this.terminal.setProfiles(this.profiles);
    // Adopt whatever is already running before deciding to open anything, sessions first: the layout
    // names sessions, so a layout applied to an empty strip would resolve to nothing.
    this.terminal.setSessions(bootstrap.terminals);
    this.terminal.setLayout(bootstrap.layout);

    this.pulls = bootstrap.pulls;
    this.pullScope = bootstrap.settings.pullScope;
    this.jira = bootstrap.jira;
    this.bindChrome();
    this.bindStrip(bootstrap.settings);
    this.bindNotes(bootstrap.settings, bootstrap.notes);
    this.renderTable();
    this.renderPulls();
    this.renderJira();
    // Painted so the tab is never blank, but only **read** when it is the one on screen: the reads
    // are per-repository and there is no monitor pushing them.
    this.renderGit();
    if (bootstrap.settings.activeStrip === 'git') {
      void this.loadGit();
    }

    window.api.onRowsChanged((rows) => {
      this.rows = rows;
      this.renderTable();
      // The git poll is the natural heartbeat for the Git tab too: the working tree it describes is
      // the very thing that tab shows. Only when it is on screen, since reading branches, history and
      // status for a hidden tab is work for nobody.
      if (this.strip?.active === 'git') {
        void this.loadGit();
      }
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
    window.api.onTerminalsChanged((sessions) => {
      this.terminal?.setSessions(sessions);
      // Closing the very last tab must not leave a dead surface: with no session there is no
      // strip, and the "+" that could open a new one lives in the strip. Same rule as the
      // bootstrap below — the terminal is this app's centre, so it is never left empty.
      if (sessions.length === 0) {
        void this.openDefaultShell();
      }
    });
    window.api.onTerminalLayoutChanged((layout) => this.terminal?.setLayout(layout));
    window.api.onPtyOutput(({ terminalId, data }) => this.terminal?.write(terminalId, data));
    window.api.onThemeChanged((state) => this.applyTheme(state));

    this.rows = await window.api.refreshNow();
    this.renderTable();
    this.stampRefresh();

    // Open a shell straight away, but only when there is none: the pane should be usable as a
    // terminal immediately, without stacking a new tab on every renderer reload.
    if (bootstrap.terminals.length === 0) {
      await this.openDefaultShell();
    }
  }

  /**
   * Opens a tab on the preferred shell profile, falling back to the first one known.
   *
   * The two callers are the two moments the surface would otherwise be empty: the first bootstrap,
   * and the closing of the last tab. One resolution for both, or the fallback shell after a close
   * would eventually differ from the one the app starts on.
   */
  private async openDefaultShell(): Promise<void> {
    const preferred = this.settings?.defaultShellProfileId ?? '';
    const profile = this.profiles.find((entry) => entry.id === preferred) ?? this.profiles[0];
    if (profile !== undefined) {
      await this.openShell(profile.id);
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
    /*
     * The interface size, then a refit.
     *
     * The refit is the non-obvious half: bigger text makes the tab row and the strip's own chrome
     * taller, so the box left to the terminal changes size without the window ever resizing — and a
     * `resize` event is exactly what does not fire here. Same trap as opening the notes panel.
     */
    applyUiFontSize(bootstrap.settings.uiFontSize);
    this.terminal?.refit();
    this.rows = await window.api.refreshNow();
    this.renderTable();
    // The repository column is drawn from the project list, which is exactly what may have changed.
    // The selection is dropped when its project is gone, so the panel cannot point at nothing.
    if (!this.projects.some((project) => project.id === this.gitProject)) {
      this.gitProject = null;
      this.gitRepo = null;
      this.gitTarget = null;
      this.gitDiff = null;
    }
    this.renderGit();
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
      onNewTerminal: (projectId) => void this.openNewShellInProject(projectId),
    });
  }

  private renderJira(): void {
    if (this.jira === null) {
      return;
    }
    renderJiraList(
      {
        views: requireElement('jira-views'),
        filter: requireElement('jira-filter'),
        list: requireElement('jira-list'),
      },
      this.jira,
      { selected: this.selectedJiraView, assignee: this.jiraAssignee, sort: this.jiraSort },
      {
        onOpen: (url) => void window.api.openExternal(url),
        onSelect: (view) => {
          this.selectedJiraView = view;
          // The filter belongs to the list it was applied to: "Mes tickets" has no assignee column, so
          // a filter carried over would silently narrow a view that offers no way to see or clear it.
          this.jiraAssignee = '';
          this.renderJira();
        },
        onMenu: (issue, x, y) => void this.openIssueMenu(issue, x, y),
        onFilterAssignee: (assignee) => {
          this.jiraAssignee = assignee;
          this.renderJira();
        },
        onSort: (key: JiraSortKey) => {
          this.jiraSort = nextSort(this.jiraSort, key);
          this.renderJira();
        },
      },
      {
        siteUrl: this.settings?.jira.siteUrl ?? '',
        projectKeys: this.settings?.jira.projectKeys ?? [],
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
        label: issue.isMine ? 'Already assigned to you' : 'Assign this issue to me',
        disabled: issue.isMine,
        run: () => void this.runJiraWrite(() => window.api.assignJiraToMe(issue.key)),
      },
      /*
       * The branch, second in the list and above the transitions.
       *
       * Position is not decoration here: "assign it to me, create its branch" is the pair of gestures
       * that start a ticket, and they are the two things done from this menu in the same minute. The
       * transitions below are the ones done later, one at a time.
       */
      {
        label: 'Create a branch...',
        hint: `Runs the "dev ${issue.key}" alias in a terminal tab, on the chosen project`,
        run: () => this.openBranchProjectMenu(issue, x, y),
      },
      ...transitions.map((transition) => ({
        label: `Move to "${transition.label}"`,
        run: () =>
          void this.runJiraWrite(() => window.api.transitionJira(issue.key, transition.id)),
      })),
      {
        label: 'Open in the browser',
        run: () => void window.api.openExternal(issue.url),
      },
    ];
    if (transitions.length === 0) {
      items.splice(1, 0, {
        // Says why rather than showing a menu that looks broken: no transitions usually means the
        // connection failed, not that the issue is frozen.
        label: 'No transition available',
        disabled: true,
        run: () => {},
      });
    }
    showContextMenu(x, y, items);
  }

  /**
   * Asks which project the branch goes in, then runs `dev <TICKET>` there.
   *
   * A **second menu at the same spot** rather than a dialog or an inline submenu, and the reasons are
   * this app's own. A modal is out on principle here: a `mousedown` inside an overlay released outside
   * it fires a `click` on the common ancestor, which is the bug that got the settings modal removed. A
   * true submenu would mean hover timers, edge flipping and a keyboard model — a menu framework, for a
   * list of four repositories. And a flat list of "Create a branch in X" entries inside the first
   * menu would push the transitions below the fold on a machine with ten projects.
   *
   * Two clicks, same place, no new widget. The last project used comes first and says so, because
   * branch after branch lands in the same repository for days at a time.
   */
  private openBranchProjectMenu(issue: JiraIssue, x: number, y: number): void {
    const ordered = [...this.projects].sort((left, right) => {
      if (left.id === this.lastBranchProject) {
        return -1;
      }
      return right.id === this.lastBranchProject ? 1 : 0;
    });

    if (ordered.length === 0) {
      showContextMenu(x, y, [
        { label: 'No project configured', disabled: true, run: () => {} },
      ]);
      return;
    }

    showContextMenu(
      x,
      y,
      ordered.map((project) => ({
        label:
          project.id === this.lastBranchProject ? `${project.label} (dernier)` : project.label,
        hint: `dev ${issue.key} in ${project.path}`,
        run: () => void this.startBranch(project.id, issue.key),
      })),
    );
  }

  /**
   * Runs the ticket's `dev` alias in a terminal tab and brings it forward.
   *
   * Focused straight away for the reason the commit tab is: the alias prints what it did and can ask
   * something, and a tab created behind the current one would be invisible until it had finished.
   */
  private async startBranch(projectId: ProjectId, issueKey: string): Promise<void> {
    const { terminalId, result } = await window.api.startTicketBranch(projectId, issueKey);
    this.stampMessage(result.message);
    if (terminalId === null) {
      console.warn('[branch]', result.message);
      return;
    }
    this.lastBranchProject = projectId;
    await this.focusTerminal(terminalId);
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
      {
        repos: requireElement('pulls-repos'),
        views: requireElement('pulls-views'),
        list: requireElement('pulls-list'),
      },
      this.pulls,
      this.selectedRepo,
      this.pullScope,
      {
        // Same gesture as a click on a project row, and it goes through the same reuse path: seeing a
        // pull request usually means going to work on it.
        onNewTerminal: (projectId) => void this.openNewShellInProject(projectId),
        onOpenPull: (url) => void window.api.openExternal(url),
        onSelect: (projectId) => {
          this.selectedRepo = projectId;
          this.renderPulls();
        },
        onSelectScope: (scope) => {
          this.pullScope = scope;
          if (this.settings !== null) {
            this.settings = { ...this.settings, pullScope: scope };
          }
          // Local-only, like the strip heights: it is written from this window and echoing it back
          // would rebuild the list under the click that produced it.
          void window.api.updateSettings({ pullScope: scope });
          this.renderPulls();
        },
      },
    );
  }

  /* -------------------------------------------------------------------- git */

  private renderGit(): void {
    renderGitPanel(
      {
        repos: requireElement('git-repos'),
        header: requireElement('git-header'),
        views: requireElement('git-views'),
        list: requireElement('git-list'),
        commit: requireElement('git-commit'),
        diff: requireElement('git-diff'),
      },
      this.gitPanelState(),
      this.gitPanelActions(),
    );
  }

  /**
   * The Git tab's state, as one object.
   *
   * Extracted because the action menu needs the very same snapshot as the panel: two places assembling
   * it would eventually disagree about, say, whether a write is in flight, and the menu would offer a
   * `Push` the panel has already disabled.
   */
  private gitPanelState(): GitPanelState {
    return {
      projects: this.projects,
      selectedProject: this.gitProject,
      repo: this.gitRepo,
      view: this.gitView,
      target: this.gitTarget,
      diff: this.gitDiff,
      message: this.gitMessage,
      branchDraft: this.gitBranchDraft,
      stashDraft: this.gitStashDraft,
      stashUntracked: this.gitStashUntracked,
      busy: this.gitBusy,
    };
  }

  private gitPanelActions(): GitPanelActions {
    return {
        onSelectProject: (projectId) => {
          if (projectId === this.gitProject) {
            return;
          }
          this.gitProject = projectId;
          // The diff and the drafts belong to the repository that was open, not to this one: keeping
          // a message typed for another project is how a commit ends up in the wrong place.
          this.gitRepo = null;
          this.gitTarget = null;
          this.gitDiff = null;
          this.gitMessage = '';
          this.gitBranchDraft = '';
          this.gitStashDraft = '';
          this.renderGit();
          void this.loadGit();
        },
        onSelectView: (view) => {
          this.gitView = view;
          this.renderGit();
        },
        onSelectTarget: (target) => {
          this.gitTarget = target;
          this.gitDiff = null;
          this.renderGit();
          void this.loadGitDiff();
        },
        onStage: (paths, staged) =>
          void this.runGitWrite(() => window.api.gitStage(this.requireGitProject(), paths, staged)),
        onCheckout: (name) =>
          void this.runGitWrite(() => window.api.gitCheckout(this.requireGitProject(), name)),
        onCreateBranch: (name) => {
          void this.runGitWrite(async () => {
            const result = await window.api.gitCreateBranch(this.requireGitProject(), name, true);
            if (result.ok) {
              this.gitBranchDraft = '';
            }
            return result;
          });
        },
        onCommit: () => void this.commitGit(),
        onMessage: (value) => {
          // Stored without a re-render: the textarea already shows it, and rebuilding the panel on
          // every keystroke would move the caret.
          this.gitMessage = value;
        },
        onBranchDraft: (value) => {
          this.gitBranchDraft = value;
        },
        onSync: (op) => void this.syncGit(op),
        onCherryPick: (sha, noCommit) =>
          void this.runGitWrite(() =>
            window.api.gitCherryPick(this.requireGitProject(), sha, noCommit),
          ),
        onSequencer: (op) =>
          void this.runGitWrite(() => window.api.gitSequencer(this.requireGitProject(), op)),
        onStashDraft: (value) => {
          this.gitStashDraft = value;
        },
        onStashUntracked: (include) => {
          this.gitStashUntracked = include;
          // Re-rendered, unlike a text draft: the switch changes the button's own label and enablement,
          // so the panel has to be repainted for the checkbox to mean anything.
          this.renderGit();
        },
        onStashPush: () => {
          void this.runGitWrite(async () => {
            const result = await window.api.gitStashPush(
              this.requireGitProject(),
              this.gitStashDraft,
              this.gitStashUntracked,
            );
            if (result.ok) {
              this.gitStashDraft = '';
            }
            return result;
          });
        },
        onStash: (stash, op) =>
          void this.runGitWrite(() =>
            window.api.gitStash(this.requireGitProject(), stash.sha, op),
          ),
        onCopy: (text) => void window.api.writeClipboard(text),
        onNewTerminal: (projectId) => void this.openNewShellInProject(projectId),
        onMenu: (x, y) => this.openGitMenu(x, y),
        onCommitMenu: (commit, x, y) => {
          if (this.gitRepo === null || this.gitRepo.error !== null) {
            return;
          }
          showContextMenu(
            x,
            y,
            buildCommitMenuItems(commit, this.gitRepo, this.gitPanelState(), this.gitPanelActions()),
          );
        },
        onStashMenu: (stash, x, y) => {
          showContextMenu(
            x,
            y,
            buildStashMenuItems(stash, this.gitPanelState(), this.gitPanelActions()),
          );
        },
        onEditing: (editing) => {
          this.gitEditing = editing;
        },
    };
  }

  /**
   * The repository's actions: the three network operations and a terminal.
   *
   * Rebuilt at each opening rather than held, for the same reason the Jira transitions are read when
   * their menu opens: the labels depend on live state (`Push` becomes `Push et publier la branche`
   * without an upstream) and a menu built once would eventually offer the wrong one.
   */
  private openGitMenu(x: number, y: number): void {
    if (this.gitRepo === null || this.gitRepo.error !== null) {
      return;
    }
    showContextMenu(x, y, buildRepoMenuItems(this.gitRepo, this.gitPanelState(), this.gitPanelActions()));
  }

  /**
   * Reads the selected repository, defaulting the selection to the first project.
   *
   * Skipped while a field has the focus: this runs on the git poll, so a refresh landing mid-sentence
   * would replace the textarea under the cursor. Exactly the guard the project table's rename uses.
   */
  private async loadGit(): Promise<void> {
    if (this.gitEditing) {
      return;
    }
    this.gitProject ??= this.projects[0]?.id ?? null;
    const projectId = this.gitProject;
    if (projectId === null) {
      this.renderGit();
      return;
    }

    this.gitRepo = await window.api.gitState(projectId);
    // The selected file may have been committed or reverted since the last pass, and a diff column
    // still showing it would describe something that no longer exists.
    if (this.gitTarget?.kind === 'file') {
      const path = this.gitTarget.path;
      if (!(this.gitRepo?.changes.some((change) => change.path === path) ?? false)) {
        this.gitTarget = null;
        this.gitDiff = null;
      }
    }
    // Same rule for a stash, and it is not hypothetical here: `pop` and `drop` both remove the entry
    // the diff column is showing, so this is the normal outcome of using the view rather than an edge.
    if (this.gitTarget?.kind === 'stash') {
      const sha = this.gitTarget.sha;
      if (!(this.gitRepo?.stashes.some((stash) => stash.sha === sha) ?? false)) {
        this.gitTarget = null;
        this.gitDiff = null;
      }
    }
    /*
     * Opens on the first changed file when nothing is selected.
     *
     * The diff is the reason the tab has a third column, and arriving on an empty one asks the user to
     * click before the tab tells them anything. Only when there is no selection at all, so it can
     * never pull the view away from a file being read, and only on the changes view: preselecting a
     * commit would fire a `git show` for a list nobody has looked at yet.
     */
    const first = this.gitRepo?.changes[0];
    if (this.gitTarget === null && this.gitView === 'changes' && first !== undefined) {
      this.gitTarget = defaultTargetFor(first);
      this.gitDiff = null;
    }
    this.renderGit();
    if (this.gitTarget !== null && this.gitDiff === null) {
      await this.loadGitDiff();
    }
  }

  private async loadGitDiff(): Promise<void> {
    const projectId = this.gitProject;
    const target = this.gitTarget;
    if (projectId === null || target === null) {
      return;
    }
    const diff = await window.api.gitDiff(projectId, target);
    // Dropped when the selection moved on while this was in flight: a slow diff must not overwrite
    // the fast one the user asked for afterwards.
    if (this.gitTarget === target) {
      this.gitDiff = diff;
      this.renderGit();
    }
  }

  /**
   * Runs a git write, then re-reads.
   *
   * Every write goes through here so three things always happen together: the buttons are disabled
   * while it runs, the outcome is reported where the user is looking, and the state is re-read. A
   * checkout that succeeded but left the branch list showing the old branch is worse than one that
   * failed loudly.
   */
  private async runGitWrite(write: () => Promise<{ ok: boolean; message: string }>): Promise<void> {
    if (this.gitBusy) {
      return;
    }
    this.gitBusy = true;
    this.renderGit();
    try {
      const result = await write();
      this.stampMessage(result.message);
      if (!result.ok) {
        console.warn('[git]', result.message);
      }
    } finally {
      this.gitBusy = false;
      // The diff is dropped rather than kept: staging a file changes what `git diff` answers for it,
      // so the panel would otherwise show the previous answer next to the new checkbox.
      this.gitDiff = null;
      await this.loadGit();
    }
  }

  private async syncGit(op: GitSyncOp): Promise<void> {
    await this.runGitWrite(() => window.api.gitSync(this.requireGitProject(), op));
  }

  /**
   * Commits, in a terminal tab.
   *
   * The tab is brought forward straight away: running the commit there is only worth anything if the
   * hook output is watched, and a commit tab created behind the current one would be invisible until
   * it had already finished.
   */
  private async commitGit(): Promise<void> {
    const projectId = this.gitProject;
    if (projectId === null || this.gitBusy) {
      return;
    }
    this.gitBusy = true;
    this.renderGit();
    try {
      const { terminalId, result } = await window.api.gitCommit(projectId, this.gitMessage);
      this.stampMessage(result.message);
      if (terminalId !== null) {
        // Cleared once handed over: the message now lives in the file git is reading, and leaving it
        // in the form invites committing it twice.
        this.gitMessage = '';
        await this.focusTerminal(terminalId);
      }
    } finally {
      this.gitBusy = false;
      await this.loadGit();
    }
  }

  /**
   * The selected project, for the write paths.
   *
   * They are only reachable from a rendered panel, which cannot exist without a selection, so an
   * empty string here would be a programming error rather than a state to handle: the main process
   * answers "projet introuvable" and it shows up in the status line.
   */
  private requireGitProject(): ProjectId {
    return this.gitProject ?? '';
  }

  private stampRefresh(): void {
    requireElement('last-refresh').textContent = `updated ${new Date().toLocaleTimeString('en-GB', {
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
      console.warn(`[stop] nothing to stop for ${projectId}`);
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
   * Triggered by a click anywhere on the row. The main process resolves the project, the profile and
   * the existing tab: doing it here meant three lookups the renderer had no authority over, and reuse
   * could not be decided at all.
   */
  private async openShellInProject(projectId: ProjectId): Promise<void> {
    const terminalId = await window.api.openProjectShell(projectId);
    if (terminalId !== null) {
      await this.focusTerminal(terminalId);
    }
  }

  /**
   * Opens a new shell in a project's folder, without reusing anything.
   *
   * The `Terminal` button, as opposed to the row click above. It goes through `openShell` rather than
   * `openProjectShell` precisely because that one spawns unconditionally and tags the tab with no
   * `projectId`: the row keeps its own single shell, and these extra tabs are free shells that no
   * configuration change can close behind your back.
   */
  private async openNewShellInProject(projectId: ProjectId): Promise<void> {
    const project = this.projects.find((entry) => entry.id === projectId);
    if (project === undefined) {
      return;
    }
    const terminalId = await window.api.openShell({
      // The profile the bare "new tab" click uses, so the button and the `+` agree on the shell.
      profileId: this.settings?.defaultShellProfileId ?? '',
      cwd: project.path,
      title: project.label,
    });
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
    const picked = await window.api.pickFolder('Project folder to add');
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
      if (this.strip?.active === 'git') {
        // The diff goes with it: the file may well have changed since it was read, and refreshing
        // everything except the pane being looked at is the wrong half.
        this.gitDiff = null;
        void this.loadGit().then(() => this.stampRefresh());
        return;
      }
      void window.api.refreshNow().then((rows) => {
        this.rows = rows;
        this.renderTable();
        this.stampRefresh();
      });
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
        // Picking a tab while the strip is folded means "show me that one", not "switch an invisible
        // panel". The gesture is the whole way back, which is why the tab row never folds with it.
        if (this.stripCollapsed) {
          this.applyStripCollapsed(false);
        } else if (this.settings !== null) {
          this.resizer?.setHeight(heightOf(this.settings, tab));
        }
        void window.api.updateSettings({ activeStrip: tab });
        // Nothing is read for the Git tab while it is hidden, so showing it is the moment to read.
        // The stored column width goes back on here too: the splitter cannot measure a `display: none`
        // panel, so this is the first instant its value can actually be honoured.
        if (tab === 'git') {
          this.gitSplitter?.setWidth(this.settings?.gitListWidth ?? DEFAULT_GIT_LIST_WIDTH);
          void this.loadGit();
        }
        // The terminal's geometry changed with the strip's: without this its pty keeps the old size.
        this.terminal?.refit();
      },
    });
    this.strip.adopt(settings.activeStrip);

    /*
     * The Git tab's own separator, inside the strip rather than at the edge of the window.
     *
     * Attached once, here, next to the strip's other resizer: both are geometry of the same pane. The
     * terminal is **not** refitted on this one, unlike the two others, and that is not an oversight —
     * this separator moves a boundary *inside* the strip, so the terminal's box does not change.
     */
    this.gitSplitter = attachGitSplitter({
      handle: requireElement('git-resizer'),
      panel: requireElement('strip-panel-git'),
      list: requireElement('git-main'),
      initialWidth: settings.gitListWidth,
      onResize: () => {},
      onCommit: (width) => {
        const rounded = Math.round(width);
        if (this.settings !== null) {
          this.settings = { ...this.settings, gitListWidth: rounded };
        }
        void window.api.updateSettings({ gitListWidth: rounded });
      },
    });

    requireElement<HTMLButtonElement>('strip-collapse').addEventListener('click', () => {
      this.applyStripCollapsed(!this.stripCollapsed);
    });

    /*
     * Double-clicking the tab row folds and unfolds it, the way double-clicking a title bar maximises
     * a window. The chevron stays: this is the gesture you find by accident once you know the app, not
     * the one that has to be discoverable.
     *
     * `hitsInteractive` is what keeps it from firing on the tabs and on `+ Project`, which is not a
     * detail: without it, double-clicking "Jira" would select that tab *and* fold the panel it was
     * asking to see. No `preventDefault` needed against text selection, the body being
     * `user-select: none` everywhere but the terminal surface and the note editor.
     */
    requireElement('projects-header').addEventListener('dblclick', (event) => {
      if (hitsInteractive(event)) {
        return;
      }
      this.applyStripCollapsed(!this.stripCollapsed);
    });

    /*
     * `Alt+Shift+A`, the same chord family as the terminal's `{d,b,w}` and the notes' `n`, for the
     * same reasons: capture phase, since a focused xterm would swallow it; `Alt+Shift` rather than
     * `Ctrl+Alt`, which is AltGr on a Swiss French layout; a letter rather than a digit; and a guard
     * on `event.repeat`, without which holding the keys folds and unfolds dozens of times.
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
          event.code !== 'KeyA'
        ) {
          return;
        }
        event.preventDefault();
        this.applyStripCollapsed(!this.stripCollapsed);
      },
      true,
    );

    this.applyStripCollapsed(settings.stripCollapsed, { persist: false });
  }

  /**
   * Folds the top strip down to its tab row, or unfolds it.
   *
   * The height set by `attachPaneResizer` has to be **cleared**, not overridden: it is an inline
   * pixel value on the pane, and a class alone cannot beat it. Unfolding puts it back through the
   * resizer rather than by hand, so the stored height goes through the same clamp it always does.
   *
   * The terminal is refitted at the end because its geometry just changed while the *window* did not,
   * so the `resize` listener inside `TerminalPane` never fires. Same reason as the notes panel.
   */
  private applyStripCollapsed(collapsed: boolean, options: { persist?: boolean } = {}): void {
    this.stripCollapsed = collapsed;
    const pane = requireElement('projects-pane');
    pane.classList.toggle('projects--collapsed', collapsed);
    // The separator has nothing left to resize once the strip is folded, and dragging it would fight
    // the fold by writing a height straight back onto the pane.
    requireElement('projects-resizer').hidden = collapsed;

    const button = requireElement<HTMLButtonElement>('strip-collapse');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.title = collapsed ? 'Unfold the strip (Alt+Shift+A)' : 'Fold the strip (Alt+Shift+A)';
    button.setAttribute('aria-label', collapsed ? 'Unfold the strip' : 'Fold the strip');

    if (collapsed) {
      pane.style.height = '';
    } else if (this.settings !== null) {
      this.resizer?.setHeight(heightOf(this.settings, this.strip?.active ?? 'projects'));
    }

    if (options.persist !== false) {
      if (this.settings !== null) {
        this.settings = { ...this.settings, stripCollapsed: collapsed };
      }
      void window.api.updateSettings({ stripCollapsed: collapsed });
    }
    this.terminal?.refit();
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
    button.setAttribute('aria-label', open ? 'Hide the notes' : 'Show the notes');

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
    button.title = `Theme: ${describeThemeMode(this.theme.mode)}`;

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

/**
 * Fallback width of the Git tab's working column.
 *
 * Only reached if the settings have not loaded, which is a state the panel can technically be in; it
 * matches the CSS fallback in `.git` so the two cannot disagree about the first paint.
 */
const DEFAULT_GIT_LIST_WIDTH = 460;

/** Remembered height of one strip tab. */
function heightOf(settings: AppSettings, tab: StripTab): number {
  switch (tab) {
    case 'pulls':
      return settings.pullsHeight;
    case 'jira':
      return settings.jiraHeight;
    case 'git':
      return settings.gitHeight;
    case 'projects':
      return settings.projectsHeight;
  }
}

/** Settings key that stores a tab's height. */
function heightKeyOf(
  tab: StripTab,
): 'projectsHeight' | 'pullsHeight' | 'jiraHeight' | 'gitHeight' {
  switch (tab) {
    case 'pulls':
      return 'pullsHeight';
    case 'jira':
      return 'jiraHeight';
    case 'git':
      return 'gitHeight';
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
      return 'light';
    case 'dark':
      return 'dark';
    case 'system':
      return 'system';
  }
}

// A rejected bootstrap used to fail silently, leaving the window up but half-initialised with no
// trace anywhere. Reporting it is what makes such a failure findable.
void new App().start().catch((error: unknown) => {
  console.error('[bootstrap] renderer failed to start:', error);
});
