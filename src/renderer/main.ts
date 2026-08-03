import type {
  AppSettings,
  ClaudeSession,
  Project,
  ProjectId,
  ProjectRow,
  ThemeMode,
  ThemeState,
} from '@shared/contracts.js';
import { requireElement } from './ui/dom.js';
import { renderProjectTable } from './ui/project-table.js';
import { renderSessionList } from './ui/session-list.js';
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
  private sessions: readonly ClaudeSession[] = [];
  private settings: AppSettings | null = null;
  private theme: ThemeState = { mode: 'system', resolved: 'light' };
  private terminal: TerminalPane | null = null;
  /** Projects whose buffered output has already been replayed into their terminal. */
  private readonly replayed = new Set<ProjectId>();

  async start(): Promise<void> {
    const bootstrap = await window.api.bootstrap();
    this.projects = bootstrap.projects;
    this.settings = bootstrap.settings;
    this.applyTheme(bootstrap.theme);

    this.terminal = new TerminalPane(
      requireElement('terminal-tabs'),
      requireElement('terminal-surface'),
      this.projects,
      (projectId, data) => window.api.sendPtyInput(projectId, data),
      (projectId, cols, rows) => window.api.resizePty(projectId, { cols, rows }),
    );
    this.terminal.mount(this.theme.resolved);
    this.setTerminalVisible(bootstrap.settings.showTerminal);

    this.bindChrome();
    this.renderTable();
    this.renderSessions();

    window.api.onRowsChanged((rows) => {
      this.rows = rows;
      this.renderTable();
      this.stampRefresh();
    });
    window.api.onSessionsChanged((sessions) => {
      this.sessions = sessions;
      this.renderSessions();
    });
    window.api.onPtyOutput(({ projectId, data }) => this.terminal?.write(projectId, data));
    window.api.onThemeChanged((state) => this.applyTheme(state));

    this.rows = await window.api.refreshNow();
    this.renderTable();
    this.stampRefresh();
  }

  /* ---------------------------------------------------------------- render */

  private renderTable(): void {
    renderProjectTable(requireElement('project-tbody'), this.rows, {
      onStart: (projectId) => void this.startProject(projectId),
      onStop: (projectId) => void window.api.stopPty(projectId),
      onCommit: (projectId) => void this.runCommit(projectId),
      onOpenPr: (url) => void window.api.openExternal(url),
      onOpenFolder: (projectId) => void window.api.openFolder(projectId),
    });
  }

  private renderSessions(): void {
    renderSessionList(requireElement('session-list'), this.sessions);
    const active = this.sessions.filter(
      (session) => session.status === 'working' || session.status === 'waiting',
    ).length;
    requireElement('sessions-count').textContent =
      this.sessions.length === 0 ? '' : `${active} active(s) / ${this.sessions.length}`;
  }

  private stampRefresh(): void {
    const now = new Date();
    requireElement('last-refresh').textContent = `maj ${now.toLocaleTimeString('fr-CH', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })}`;
  }

  /* --------------------------------------------------------------- actions */

  /**
   * Starts a project and brings its terminal forward.
   *
   * Switching tabs matters: the user clicked Run to watch something happen, and leaving another
   * project's terminal visible would look like nothing did.
   */
  private async startProject(projectId: ProjectId): Promise<void> {
    this.setTerminalVisible(true);
    this.terminal?.select(projectId);
    await this.replayBuffer(projectId);
    await window.api.runPty(projectId, 'start');
  }

  private async runCommit(projectId: ProjectId): Promise<void> {
    this.setTerminalVisible(true);
    this.terminal?.select(projectId);
    await this.replayBuffer(projectId);
    await window.api.runPty(projectId, 'commit');
  }

  /** Replays output produced before this terminal was first shown, once per project. */
  private async replayBuffer(projectId: ProjectId): Promise<void> {
    if (this.replayed.has(projectId)) {
      return;
    }
    this.replayed.add(projectId);
    const buffer = await window.api.readPtyBuffer(projectId);
    if (buffer.length > 0) {
      this.terminal?.reset(projectId, buffer);
    }
  }

  /* ----------------------------------------------------------------- chrome */

  private bindChrome(): void {
    requireElement<HTMLButtonElement>('refresh-button').addEventListener('click', () => {
      void window.api.refreshNow().then((rows) => {
        this.rows = rows;
        this.renderTable();
        this.stampRefresh();
      });
    });

    requireElement<HTMLButtonElement>('terminal-toggle').addEventListener('click', () => {
      const next = !(this.settings?.showTerminal ?? true);
      this.setTerminalVisible(next);
      void window.api.updateSettings({ showTerminal: next });
    });

    requireElement<HTMLButtonElement>('terminal-clear').addEventListener('click', () => {
      this.terminal?.clearActive();
    });

    requireElement<HTMLButtonElement>('theme-button').addEventListener('click', () => {
      void this.cycleTheme();
    });
  }

  private setTerminalVisible(visible: boolean): void {
    if (this.settings !== null) {
      this.settings = { ...this.settings, showTerminal: visible };
    }
    requireElement('terminal-pane').hidden = !visible;
    requireElement<HTMLButtonElement>('terminal-toggle').setAttribute(
      'aria-pressed',
      String(visible),
    );
    if (visible) {
      const active = this.terminal?.activeProject ?? this.projects[0]?.id;
      if (active !== undefined) {
        // Re-selecting re-fits: xterm cannot measure itself while its container is hidden.
        this.terminal?.select(active);
      }
    }
  }

  /* ------------------------------------------------------------------ theme */

  private applyTheme(state: ThemeState): void {
    this.theme = state;
    document.documentElement.dataset.theme = state.resolved;
    this.terminal?.applyTheme(state.resolved);
    this.renderThemeIcon();
  }

  private async cycleTheme(): Promise<void> {
    const next = nextThemeMode(this.theme.mode);
    this.applyTheme(await window.api.setThemeMode(next));
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

void new App().start();
