import type { IPty } from '@lydell/node-pty';
import { describe, expect, it } from 'vitest';
import { IpcChannel } from '../src/shared/contracts.js';
import type { PanelEditorState } from '../src/shared/explorer.js';
import { EDITOR_QUIT_KEY, type EditorRequest } from '../src/main/editor/editor-process.js';
import { PanelEditor } from '../src/main/editor/panel-editor.js';

/** A pty that records what it is told and exits when the test says so. */
class FakePty {
  readonly written: string[] = [];
  private exit: ((event: { exitCode: number }) => void) | null = null;
  constructor(readonly request: EditorRequest) {}
  onData(): void {}
  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exit = listener;
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(): void {}
  end(exitCode: number): void {
    this.exit?.({ exitCode });
  }
}

function request(path: string): EditorRequest {
  return {
    key: `web-app\0${path}`,
    projectId: 'web-app',
    path,
    title: `${path} - web-app`,
    file: 'editor.exe',
    args: [path],
    cwd: 'C:/repos/web-app',
  };
}

interface Setup {
  readonly editor: PanelEditor;
  readonly ptys: FakePty[];
  readonly windows: string[];
  readonly last: () => PanelEditorState | undefined;
}

function setup(windowed: string[] = []): Setup {
  const ptys: FakePty[] = [];
  const states: PanelEditorState[] = [];
  const windows: string[] = [];
  const editor = new PanelEditor({
    owner: () => ({
      id: 1,
      send: (channel: string, payload: unknown) => {
        if (channel === IpcChannel.PanelEditorState) {
          states.push(payload as PanelEditorState);
        }
      },
    }),
    windows: {
      has: (key) => windowed.includes(key),
      open: (what) => windows.push(what.path),
    },
    spawn: (what) => {
      const fake = new FakePty(what);
      ptys.push(fake);
      return fake as unknown as IPty;
    },
  });
  return { editor, ptys, windows, last: () => states[states.length - 1] };
}

const SIZE = { cols: 100, rows: 30 };

describe('PanelEditor', () => {
  it('starts the editor on a file and says which one', () => {
    const { editor, ptys, last } = setup();
    editor.open(request('a.ts'), SIZE);
    expect(ptys).toHaveLength(1);
    expect(last()).toMatchObject({ path: 'a.ts', running: true, pending: null });
  });

  it('asks the editor to quit before another file takes its place, never kills it', () => {
    const { editor, ptys, last } = setup();
    editor.open(request('a.ts'), SIZE);
    editor.open(request('b.ts'), SIZE);
    // Still one process: the second file waits for the first editor to let go.
    expect(ptys).toHaveLength(1);
    expect(ptys[0]?.written).toEqual([EDITOR_QUIT_KEY]);
    expect(last()).toMatchObject({ path: 'a.ts', pending: 'b.ts - web-app' });
    ptys[0]?.end(0);
    expect(ptys).toHaveLength(2);
    expect(ptys[1]?.request.path).toBe('b.ts');
    expect(last()).toMatchObject({ path: 'b.ts', running: true, pending: null });
  });

  it('opens nothing twice: the same file again only drops what was waiting', () => {
    const { editor, ptys, last } = setup();
    editor.open(request('a.ts'), SIZE);
    editor.open(request('b.ts'), SIZE);
    editor.open(request('a.ts'), SIZE);
    expect(last()?.pending).toBeNull();
    ptys[0]?.end(0);
    expect(ptys).toHaveLength(1);
    expect(last()?.session).toBeNull();
  });

  it('moves the open file to its own window once the editor here has quit', () => {
    const { editor, ptys, windows, last } = setup();
    editor.open(request('a.ts'), SIZE);
    editor.popOut(request('a.ts'));
    expect(ptys[0]?.written).toEqual([EDITOR_QUIT_KEY]);
    expect(windows).toEqual([]);
    ptys[0]?.end(0);
    expect(windows).toEqual(['a.ts']);
    expect(last()?.session).toBeNull();
  });

  it('brings forward a file that already has a window, instead of a second editor on it', () => {
    const { editor, ptys, windows } = setup(['web-app\0a.ts']);
    expect(editor.open(request('a.ts'), SIZE)).toEqual({ ok: true, message: 'Already open in its own window' });
    expect(ptys).toHaveLength(0);
    expect(windows).toEqual(['a.ts']);
  });

  it('keeps a bad exit on screen, and clears a clean one', () => {
    const { editor, ptys, last } = setup();
    editor.open(request('a.ts'), SIZE);
    ptys[0]?.end(2);
    expect(last()).toMatchObject({ path: 'a.ts', running: false, exitCode: 2 });
    editor.open(request('b.ts'), SIZE);
    ptys[1]?.end(0);
    expect(last()?.session).toBeNull();
  });

  it('counts for the quit question only while it holds unsaved changes', () => {
    const { editor, ptys } = setup();
    editor.open(request('a.ts'), SIZE);
    expect(editor.modifiedCount()).toBe(0);
    editor.setModified(true);
    expect(editor.modifiedCount()).toBe(1);
    // Quitting forgets it, and so does the next file starting clean.
    ptys[0]?.end(0);
    expect(editor.modifiedCount()).toBe(0);
    editor.open(request('b.ts'), SIZE);
    expect(editor.modifiedCount()).toBe(0);
  });

  it('takes input only from its owner page', () => {
    const { editor } = setup();
    expect(editor.ownedBy({ id: 1 })).toBe(true);
    expect(editor.ownedBy({ id: 2 })).toBe(false);
  });
});
