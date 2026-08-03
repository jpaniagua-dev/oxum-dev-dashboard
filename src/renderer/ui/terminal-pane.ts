import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { Project, ProjectId, ResolvedTheme } from '@shared/contracts.js';
import { clearChildren, createElement } from './dom.js';

/** Palettes matching the app tokens, since xterm needs literal colours rather than CSS variables. */
const THEMES: Record<ResolvedTheme, Record<string, string>> = {
  light: {
    background: '#ffffff',
    foreground: '#1f1f1f',
    cursor: '#e61e3c',
    selectionBackground: '#fbdad5',
  },
  dark: {
    background: '#0e0e0e',
    foreground: '#ededed',
    cursor: '#ea515b',
    selectionBackground: '#3a1f26',
  },
};

/**
 * One xterm instance per project, so switching tabs does not lose scrollback.
 *
 * A real terminal rather than a log view: the toolchain redraws progress with cursor control, and
 * the `commit` alias is a full-screen prompt_toolkit TUI that only works against a TTY. Keystrokes
 * are forwarded straight to the pty, which is what makes that TUI usable from here.
 */
export class TerminalPane {
  private readonly terminals = new Map<ProjectId, { term: Terminal; fit: FitAddon }>();
  private active: ProjectId | null = null;
  private theme: ResolvedTheme = 'light';

  constructor(
    private readonly tabsHost: HTMLElement,
    private readonly surface: HTMLElement,
    private readonly projects: readonly Project[],
    private readonly onInput: (projectId: ProjectId, data: string) => void,
    private readonly onResize: (projectId: ProjectId, cols: number, rows: number) => void,
  ) {
    window.addEventListener('resize', () => this.fitActive());
  }

  /** Builds the tab strip and shows the first project. */
  mount(theme: ResolvedTheme): void {
    this.theme = theme;
    this.renderTabs();
    const first = this.projects[0];
    if (first !== undefined) {
      this.select(first.id);
    }
  }

  get activeProject(): ProjectId | null {
    return this.active;
  }

  /** Appends output. Terminals are created lazily so unused projects cost nothing. */
  write(projectId: ProjectId, data: string): void {
    this.ensure(projectId).term.write(data);
  }

  /** Replaces a terminal's content, used when replaying a buffer on first open. */
  reset(projectId: ProjectId, content: string): void {
    const entry = this.ensure(projectId);
    entry.term.reset();
    if (content.length > 0) {
      entry.term.write(content);
    }
  }

  clearActive(): void {
    if (this.active !== null) {
      this.terminals.get(this.active)?.term.clear();
    }
  }

  select(projectId: ProjectId): void {
    this.active = projectId;
    clearChildren(this.surface);
    const entry = this.ensure(projectId);
    entry.term.open(this.surface);
    this.fitActive();
    entry.term.focus();
    this.renderTabs();
  }

  /** Applies a light/dark switch to every terminal, not just the visible one. */
  applyTheme(theme: ResolvedTheme): void {
    this.theme = theme;
    for (const { term } of this.terminals.values()) {
      term.options.theme = THEMES[theme];
    }
  }

  private ensure(projectId: ProjectId): { term: Terminal; fit: FitAddon } {
    const existing = this.terminals.get(projectId);
    if (existing !== undefined) {
      return existing;
    }

    const term = new Terminal({
      fontFamily: "'Cascadia Code', Consolas, monospace",
      fontSize: 12,
      // Enough history to scroll back through a full build without eating memory.
      scrollback: 5000,
      cursorBlink: false,
      convertEol: true,
      theme: THEMES[this.theme],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.onData((data) => this.onInput(projectId, data));

    const entry = { term, fit };
    this.terminals.set(projectId, entry);
    return entry;
  }

  private fitActive(): void {
    if (this.active === null) {
      return;
    }
    const entry = this.terminals.get(this.active);
    if (entry === undefined) {
      return;
    }
    try {
      entry.fit.fit();
      this.onResize(this.active, entry.term.cols, entry.term.rows);
    } catch {
      // Fitting fails while the pane is hidden and has no size; harmless.
    }
  }

  private renderTabs(): void {
    clearChildren(this.tabsHost);
    for (const project of this.projects) {
      const tab = createElement('button', { className: 'terminal__tab', text: project.label });
      tab.type = 'button';
      tab.setAttribute('aria-selected', String(project.id === this.active));
      tab.addEventListener('click', () => this.select(project.id));
      this.tabsHost.append(tab);
    }
  }
}
