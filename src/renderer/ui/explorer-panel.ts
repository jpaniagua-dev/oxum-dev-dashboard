import type { Project, ProjectId, ResolvedTheme, TerminalCompat } from '@shared/contracts.js';
import {
  baseName,
  breadcrumb,
  childPath,
  EXPLORER_SEARCH_LIMIT,
  formatSize,
  IDLE_PANEL_EDITOR,
  matchesName,
  matchFiles,
  moveSelection,
  parentPath,
  splitLineSuffix,
  type ExplorerEntry,
  type ExplorerFiles,
  type ExplorerListing,
  type ExplorerTarget,
  type PanelEditorState,
} from '@shared/explorer.js';
import { clearChildren, createElement, createIcon } from './dom.js';
import { watchModified } from './editor-modified.js';
import { FILE_ICON, FOLDER_ICON } from './icons.js';
import {
  createTerminalView,
  ensureTerminalRenderer,
  TERMINAL_THEMES,
  type TerminalView,
} from './terminal-view.js';

/**
 * The Explorer tab: each project's files, browsed a folder at a time, searched by name across the
 * project, and opened in the editor that takes the right of the panel, or in a window of its own.
 *
 * A class that owns its state, like the Extensions tab: nothing else in the app reads which folder is
 * open or what was typed. The folder per project is kept for the session and never persisted, the
 * rule this app applies to every selection.
 *
 * Two elements are built once and never rebuilt: the search field, so typing and the arrow keys never
 * lose focus to a repaint, and the editor's terminal, because an xterm is opened on its container once
 * and must never leave the DOM.
 */

/** One line of the list. */
export type ExplorerRow =
  | { readonly type: 'up'; readonly path: string }
  | { readonly type: 'entry'; readonly path: string; readonly entry: ExplorerEntry }
  | { readonly type: 'match'; readonly path: string };

/**
 * The rows the list shows, in order.
 *
 * No query: the folder's parent link, then its entries. A query: the folder's entries whose name
 * matches, then the project's files that match and are not already among them, with their path,
 * so a file deeper down is one keystroke away from wherever the list happens to be.
 */
export function explorerRows(
  listing: ExplorerListing | null,
  files: ExplorerFiles | null,
  query: string,
): ExplorerRow[] {
  const rows: ExplorerRow[] = [];
  const folder = listing?.path ?? '';
  const entries = listing?.ok === true ? listing.entries : [];
  if (query.trim().length === 0) {
    const parent = parentPath(folder);
    if (parent !== null) {
      rows.push({ type: 'up', path: parent });
    }
    for (const entry of entries) {
      rows.push({ type: 'entry', path: childPath(folder, entry.name), entry });
    }
    return rows;
  }
  const shown = new Set<string>();
  for (const entry of entries) {
    if (matchesName(entry.name, query)) {
      const path = childPath(folder, entry.name);
      shown.add(path);
      rows.push({ type: 'entry', path, entry });
    }
  }
  if (files?.ok === true) {
    for (const path of matchFiles(files.paths, query, EXPLORER_SEARCH_LIMIT)) {
      if (!shown.has(path)) {
        rows.push({ type: 'match', path });
      }
    }
  }
  return rows;
}

/** The editor's name for a label: `micro` for `micro`, `C:\tools\micro.exe` or `micro.cmd`. */
export function editorName(command: string): string {
  const name = command.trim().split(/[\\/]/).pop() ?? '';
  const bare = name.replace(/\.(exe|cmd|bat|com)$/i, '');
  return bare.length > 0 ? bare : 'the editor';
}

/** The line above the editor when there is something to say, or an empty string. */
export function editorStatus(state: PanelEditorState, editor: string): string {
  if (state.message.length > 0) {
    return state.message;
  }
  if (state.pending !== null) {
    return `Opening ${state.pending} once ${editor} has closed this file. If it asks about unsaved changes, answer below.`;
  }
  if (!state.running && state.exitCode !== null) {
    return `${editor} ended with exit code ${state.exitCode}.`;
  }
  return '';
}

export interface ExplorerPanelOptions {
  readonly projects: () => readonly Project[];
  readonly editorCommand: () => string;
  readonly stamp: (message: string) => void;
  readonly theme: ResolvedTheme;
  readonly fontSize: number;
  readonly compat: TerminalCompat | null;
}

export class ExplorerPanel {
  private projectId: ProjectId | null = null;
  /** The open folder of each project this session, `''` being the root. */
  private readonly folders = new Map<ProjectId, string>();
  private listing: ExplorerListing | null = null;
  /** The project-wide file list, fetched on the first query and dropped when the tab is shown. */
  private readonly files = new Map<ProjectId, ExplorerFiles>();
  /** Set when the tab is shown, so the next search asks the main process to list the files again. */
  private refreshFiles = true;
  private query = '';
  private selected = -1;
  /** Bumped by every folder read, so an answer that arrives after a newer request is dropped. */
  private generation = 0;

  private editor: PanelEditorState = IDLE_PANEL_EDITOR;
  /** Whether the panel is laid out for the editor, set before the open so it is measured at its size. */
  private editing = false;
  /** Last geometry announced to the editor: a resize of the same size makes ConPTY reprint the screen. */
  private sent: { cols: number; rows: number } | null = null;
  /** Unsaved changes, read off the editor's status line. Shown above it, and counted when quitting. */
  private modified = false;
  private readonly modifiedWatch: { reset: () => void };

  private readonly host: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly crumbs: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly editorHead: HTMLElement;
  private readonly editorStatus: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly terminalHost: HTMLElement;
  private readonly view: TerminalView;

  constructor(
    host: HTMLElement,
    private readonly options: ExplorerPanelOptions,
  ) {
    this.host = host;
    this.rail = createElement('div', { className: 'pulls__repos explorer__rail' });
    const main = createElement('div', { className: 'pulls__main' });
    const bar = createElement('div', { className: 'pulls__bar explorer__bar' });
    this.crumbs = createElement('nav', { className: 'explorer__crumbs' });
    this.crumbs.setAttribute('aria-label', 'Folder');
    this.search = createElement('input', { className: 'explorer__search' });
    this.search.type = 'search';
    this.search.placeholder = 'Filter, or find a file in the project (name:line)';
    this.search.setAttribute('aria-label', 'Filter this folder or find a file in the project');
    this.search.addEventListener('input', () => {
      this.query = this.search.value;
      this.selected = this.query.trim().length > 0 ? 0 : -1;
      this.renderList();
      if (this.query.trim().length > 0) {
        void this.ensureFiles();
      }
    });
    this.search.addEventListener('keydown', (event) => this.onKey(event));
    const refresh = createElement('button', { className: 'button button--quiet', text: 'Refresh' });
    refresh.type = 'button';
    refresh.addEventListener('click', () => void this.load());
    bar.append(this.crumbs, this.search, refresh);
    this.list = createElement('div', { className: 'pulls__list explorer__list' });
    this.list.setAttribute('role', 'listbox');
    main.append(bar, this.list);

    const detail = createElement('div', { className: 'pulls__overview explorer__detail' });
    this.editorHead = createElement('div', { className: 'explorer__editor-head' });
    this.editorStatus = createElement('p', { className: 'explorer__editor-status' });
    this.hint = createElement('p', {
      className: 'pulls__empty',
      text: 'Click a file, or press Enter on it, to edit it here. Shift+Enter opens it in a window of its own.',
    });
    this.terminalHost = createElement('div', { className: 'explorer__terminal' });
    this.view = createTerminalView({
      fontSize: options.fontSize,
      theme: options.theme,
      compat: options.compat,
      onInput: (data) => window.api.sendPanelEditorInput(data),
      onCopy: (text) => void window.api.writeClipboard(text),
      onPasteRequest: () => window.api.readClipboard(),
      onOpenLink: (url) => void window.api.openExternal(url),
    });
    this.terminalHost.append(this.view.element);
    this.modifiedWatch = watchModified(this.view, (modified) => {
      this.modified = modified;
      window.api.reportPanelEditorModified(modified);
      this.renderEditor();
    });
    detail.append(this.editorHead, this.editorStatus, this.hint, this.terminalHost);
    host.append(this.rail, main, detail);

    // One observer for every reason the terminal changes size: the window, the strip's splitter, the
    // layout switching to the editor, the tab being shown again.
    new ResizeObserver(() => this.fit()).observe(this.terminalHost);
    window.api.onPanelEditorOutput((data) => this.view.term.write(data));
    window.api.onPanelEditorState((state) => this.adoptEditor(state));
    void window.api.readPanelEditor().then((state) => this.adoptEditor(state));

    this.renderRail();
    this.renderCrumbs();
    this.renderList();
    this.renderEditor();
  }

  /** Reads the open folder again. Called when the tab is shown. */
  async load(): Promise<void> {
    this.refreshFiles = true;
    this.files.clear();
    this.ensureProject();
    this.renderRail();
    await this.readFolder();
    if (this.query.trim().length > 0) {
      await this.ensureFiles();
    }
  }

  /**
   * Edits a file named from outside the tab: a changed file of the Git tab.
   *
   * In the panel, the project becomes the open one and the list moves to the file's folder, so what
   * sits beside the editor is where the file lives. A window leaves the tab as it was. The caller
   * shows the tab first: the editor is started at the size the panel measures.
   */
  edit(projectId: ProjectId, path: string, target: ExplorerTarget): void {
    if (target === 'panel') {
      this.folders.set(projectId, parentPath(path) ?? '');
      if (projectId === this.projectId) {
        this.resetForProject();
        void this.readFolder();
      } else {
        this.selectProject(projectId);
      }
    }
    void this.openFile(path, target, null, projectId);
  }

  /** The configured projects changed: keep the open one if it still exists. */
  projectsChanged(): void {
    const before = this.projectId;
    this.ensureProject();
    this.renderRail();
    if (this.projectId !== before) {
      this.resetForProject();
      void this.readFolder();
    }
  }

  setTheme(theme: ResolvedTheme): void {
    this.view.term.options.theme = TERMINAL_THEMES[theme];
  }

  setFontSize(size: number): void {
    if (this.view.term.options.fontSize !== size) {
      this.view.term.options.fontSize = size;
      this.fit();
    }
  }

  /* ----------------------------------------------------------------- state */

  private ensureProject(): void {
    const projects = this.options.projects();
    if (this.projectId === null || !projects.some((project) => project.id === this.projectId)) {
      this.projectId = projects[0]?.id ?? null;
    }
  }

  private folder(): string {
    return this.projectId === null ? '' : (this.folders.get(this.projectId) ?? '');
  }

  private rows(): ExplorerRow[] {
    const files = this.projectId === null ? null : (this.files.get(this.projectId) ?? null);
    return explorerRows(this.listing, files, splitLineSuffix(this.query).query);
  }

  private resetForProject(): void {
    this.listing = null;
    this.query = '';
    this.search.value = '';
    this.selected = -1;
    this.renderCrumbs();
    this.renderList();
  }

  private selectProject(projectId: ProjectId): void {
    if (projectId === this.projectId) {
      return;
    }
    this.projectId = projectId;
    this.renderRail();
    this.resetForProject();
    void this.readFolder();
  }

  private async readFolder(): Promise<void> {
    const projectId = this.projectId;
    if (projectId === null) {
      this.listing = null;
      this.renderCrumbs();
      this.renderList();
      return;
    }
    const generation = ++this.generation;
    const listing = await window.api.listExplorer(projectId, this.folder());
    if (generation !== this.generation || projectId !== this.projectId) {
      return;
    }
    this.listing = listing;
    this.selected = Math.min(this.selected, this.rows().length - 1);
    this.renderCrumbs();
    this.renderList();
  }

  private async openFolder(path: string): Promise<void> {
    if (this.projectId === null) {
      return;
    }
    this.folders.set(this.projectId, path);
    this.query = '';
    this.search.value = '';
    this.selected = -1;
    await this.readFolder();
    // The keyboard stays in the field, so the next folder is one more Enter away.
    this.search.focus();
  }

  private async ensureFiles(): Promise<void> {
    const projectId = this.projectId;
    if (projectId === null || this.files.has(projectId)) {
      return;
    }
    const refresh = this.refreshFiles;
    this.refreshFiles = false;
    const files = await window.api.explorerFiles(projectId, refresh);
    this.files.set(projectId, files);
    if (projectId === this.projectId) {
      this.renderList();
    }
  }

  /**
   * Opens a file in the editor beside the list, or in a window of its own.
   *
   * For the panel, the layout switches to the editor **before** asking, so the size sent with the
   * request is the one the editor will keep: it draws its first frame for that size.
   */
  private async openFile(
    path: string,
    target: ExplorerTarget,
    line: number | null = null,
    projectId = this.projectId,
  ): Promise<void> {
    if (projectId === null) {
      return;
    }
    if (target === 'panel') {
      this.setEditing(true);
      ensureTerminalRenderer(this.view);
      this.fit();
    }
    const size = { cols: this.view.term.cols, rows: this.view.term.rows };
    const result = await window.api.openExplorerFile(projectId, path, target, size, line);
    if (result.message.length > 0) {
      this.options.stamp(result.message);
    }
    if (target === 'panel') {
      if (result.ok && result.message.length === 0) {
        this.view.term.focus();
      }
      if (this.editor.session === null) {
        // Nothing started here (refused, or brought forward in its own window): back to the list.
        this.setEditing(false);
      }
    }
  }

  /**
   * What Enter or a click does on a row: go into a folder, or edit a file, at the line typed after
   * its name when there is one (`app.ts:42`).
   */
  private activate(row: ExplorerRow, target: ExplorerTarget = 'panel'): void {
    if (row.type === 'up' || (row.type === 'entry' && row.entry.kind === 'dir')) {
      void this.openFolder(row.path);
      return;
    }
    void this.openFile(row.path, target, splitLineSuffix(this.query).line);
  }

  private onKey(event: KeyboardEvent): void {
    const rows = this.rows();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.selected = moveSelection(this.selected, event.key === 'ArrowDown' ? 1 : -1, rows.length);
      this.renderList();
      return;
    }
    if (event.key === 'Enter') {
      const row = rows[this.selected];
      if (row === undefined) {
        return;
      }
      event.preventDefault();
      this.activate(row, event.shiftKey ? 'window' : 'panel');
      return;
    }
    if (event.key === 'Backspace' && this.search.value.length === 0) {
      const parent = parentPath(this.folder());
      if (parent !== null) {
        event.preventDefault();
        void this.openFolder(parent);
      }
      return;
    }
    if (event.key === 'Escape' && this.search.value.length > 0) {
      event.preventDefault();
      this.search.value = '';
      this.query = '';
      this.selected = -1;
      this.renderList();
    }
  }

  /* ---------------------------------------------------------------- editor */

  private adoptEditor(state: PanelEditorState): void {
    if (state.session !== this.editor.session && state.session !== null) {
      // A new process: the previous file's screen must not show under the new one's first frame.
      this.view.term.reset();
      this.sent = null;
      this.modified = false;
      this.modifiedWatch.reset();
    }
    this.editor = state;
    this.setEditing(state.session !== null || state.pending !== null);
    if (state.running) {
      this.fit();
    }
    this.renderEditor();
    this.renderList();
  }

  private setEditing(editing: boolean): void {
    if (editing === this.editing) {
      return;
    }
    this.editing = editing;
    this.host.classList.toggle('explorer--editing', editing);
    this.view.element.hidden = !editing;
    this.hint.hidden = editing;
  }

  private fit(): void {
    // Hidden (another tab is shown) or not laid out yet: there is nothing to measure.
    if (!this.editing || this.terminalHost.clientWidth === 0 || this.terminalHost.clientHeight === 0) {
      return;
    }
    try {
      this.view.fit.fit();
    } catch {
      return;
    }
    const { cols, rows } = this.view.term;
    if (this.sent?.cols === cols && this.sent.rows === rows) {
      return;
    }
    this.sent = { cols, rows };
    window.api.resizePanelEditor({ cols, rows });
  }

  /* ---------------------------------------------------------------- render */

  private renderRail(): void {
    clearChildren(this.rail);
    const projects = this.options.projects();
    if (projects.length === 0) {
      this.rail.append(createElement('p', { className: 'pulls__empty', text: 'No project configured.' }));
      return;
    }
    for (const project of projects) {
      const row = createElement('button', {
        className: `pulls__repo${project.id === this.projectId ? ' pulls__repo--active' : ''}`,
        title: project.path,
      });
      row.type = 'button';
      row.append(createElement('span', { className: 'pulls__repo-name', text: project.label }));
      row.addEventListener('click', () => this.selectProject(project.id));
      this.rail.append(row);
    }
  }

  private renderCrumbs(): void {
    clearChildren(this.crumbs);
    const project = this.options.projects().find((candidate) => candidate.id === this.projectId);
    if (project === undefined) {
      return;
    }
    const folder = this.folder();
    this.crumbs.append(this.crumb(project.label, '', folder.length === 0));
    for (const crumb of breadcrumb(folder)) {
      this.crumbs.append(createElement('span', { className: 'explorer__crumb-sep', text: '/' }));
      this.crumbs.append(this.crumb(crumb.name, crumb.path, crumb.path === folder));
    }
  }

  private crumb(label: string, path: string, current: boolean): HTMLButtonElement {
    const button = createElement('button', {
      className: `explorer__crumb${current ? ' explorer__crumb--current' : ''}`,
      text: label,
    });
    button.type = 'button';
    if (current) {
      button.setAttribute('aria-current', 'location');
    }
    button.addEventListener('click', () => void this.openFolder(path));
    return button;
  }

  private renderList(): void {
    clearChildren(this.list);
    if (this.projectId === null) {
      return;
    }
    const listing = this.listing;
    if (listing === null) {
      this.list.append(createElement('p', { className: 'pulls__empty', text: 'Reading…' }));
      return;
    }
    if (!listing.ok) {
      this.list.append(createElement('p', { className: 'pulls__error', text: listing.message }));
    }
    const searching = this.query.trim().length > 0;
    const files = this.files.get(this.projectId);
    if (searching && files?.ok === false) {
      this.list.append(createElement('p', { className: 'pulls__error', text: files.message }));
    }
    const rows = this.rows();
    if (rows.length === 0 && listing.ok) {
      this.list.append(
        createElement('p', {
          className: 'pulls__empty',
          text: searching ? (files === undefined ? 'Searching the project…' : 'Nothing matches.') : 'This folder is empty.',
        }),
      );
    }
    rows.forEach((row, index) => this.list.append(this.renderRow(row, index)));
    if (listing.ok && listing.truncated && !searching) {
      this.list.append(
        createElement('p', {
          className: 'pulls__empty',
          text: 'Only the first entries are listed. Type a name to find the rest.',
        }),
      );
    }
    this.list.querySelector('.explorer__row--active')?.scrollIntoView({ block: 'nearest' });
  }

  private renderRow(row: ExplorerRow, index: number): HTMLButtonElement {
    const dimmed = row.type === 'entry' && row.entry.dimmed;
    const open = isFile(row) && this.editor.projectId === this.projectId && this.editor.path === row.path;
    const active = index === this.selected || (this.selected === -1 && open);
    const button = createElement('button', {
      className: [
        'explorer__row',
        active ? 'explorer__row--active' : '',
        open ? 'explorer__row--open' : '',
        dimmed ? 'explorer__row--dimmed' : '',
        isFile(row) ? '' : 'explorer__row--folder',
      ]
        .filter((name) => name.length > 0)
        .join(' '),
    });
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(active));
    // The name says the kind too (a folder ends with `/`), so the glyph is decoration for a reader.
    const icon = createElement('span', { className: 'explorer__icon' });
    icon.append(createIcon(isFile(row) ? FILE_ICON : FOLDER_ICON, { paint: 'stroke' }));
    button.append(icon);

    if (row.type === 'up') {
      button.append(createElement('span', { className: 'explorer__name', text: '..' }));
      button.title = 'The folder above';
    } else if (row.type === 'entry') {
      const name = row.entry.kind === 'dir' ? `${row.entry.name}/` : row.entry.name;
      button.append(createElement('span', { className: 'explorer__name', text: name }));
      if (row.entry.link) {
        button.append(createElement('span', { className: 'explorer__meta', text: 'link' }));
      }
      if (row.entry.size !== null) {
        button.append(createElement('span', { className: 'explorer__meta', text: formatSize(row.entry.size) }));
      }
      button.title = dimmed ? `${row.path} (ignored or excluded)` : row.path;
    } else {
      button.append(createElement('span', { className: 'explorer__name', text: baseName(row.path) }));
      button.append(createElement('span', { className: 'explorer__path', text: row.path }));
      button.title = row.path;
    }

    button.addEventListener('click', (event) => {
      this.selected = index;
      this.renderList();
      this.activate(row, event.shiftKey ? 'window' : 'panel');
    });
    return button;
  }

  private renderEditor(): void {
    clearChildren(this.editorHead);
    const state = this.editor;
    const name = editorName(this.options.editorCommand());
    const status = editorStatus(state, name);
    this.editorStatus.textContent = status;
    this.editorStatus.hidden = status.length === 0;
    this.editorStatus.classList.toggle(
      'explorer__editor-status--error',
      state.message.length > 0 || (state.exitCode !== null && !state.running),
    );
    if (state.session === null || state.path === null || state.projectId === null) {
      return;
    }
    const { path, projectId } = state;
    this.editorHead.append(
      createElement('span', { className: 'explorer__editor-title', text: state.title, title: state.title }),
    );
    if (this.modified && state.running) {
      this.editorHead.append(
        createElement('span', {
          className: 'explorer__unsaved',
          text: 'Unsaved changes',
          title: `${name} has changes not written to disk. Ctrl+S saves them.`,
        }),
      );
    }
    const popOut = createElement('button', { className: 'button button--quiet', text: 'Pop out' });
    popOut.type = 'button';
    popOut.title = `Moves this file to a window of its own. ${name} is asked to close it here first.`;
    popOut.addEventListener('click', () => void this.openFile(path, 'window', null, projectId));
    const close = createElement('button', { className: 'button button--quiet', text: 'Close' });
    close.type = 'button';
    close.title = `Asks ${name} to quit. It asks about unsaved changes itself.`;
    close.addEventListener('click', () => {
      void window.api.closePanelEditor();
      // If the editor asks about unsaved changes, the answer is typed in the terminal.
      this.view.term.focus();
    });
    this.editorHead.append(popOut, close);
  }
}

function isFile(row: ExplorerRow): boolean {
  return row.type === 'match' || (row.type === 'entry' && row.entry.kind === 'file');
}
