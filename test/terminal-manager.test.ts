import { describe, expect, it } from 'vitest';
import {
  decideRerun,
  isClosable,
  isUnreachable,
  resolveActionCommand,
  TerminalManager,
} from '../src/main/terminal/terminal-manager.js';
import {
  GIT_COMMIT_ACTION_ID,
  type Project,
  type ProjectAction,
  type ShellProfile,
  type TerminalSession,
} from '../src/shared/contracts.js';
import { GIT_PTY_FILE } from '../src/main/git/run-git.js';
import { stripAnsi } from '../src/main/projects/output-parser.js';

function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 't1',
    title: 'tab',
    kind: 'project',
    projectId: 'web-app',
    actionId: 'run',
    role: 'server',
    profileId: 'cmd',
    cwd: 'C:/repos/web-app',
    running: true,
    closable: false,
    renamed: false,
    ...overrides,
  };
}

function action(overrides: Partial<ProjectAction> = {}): ProjectAction {
  return { id: 'run', label: 'Run', command: 'npm run start', role: 'server', profileId: null, ...overrides };
}

function profile(file: string, args: string[] = []): ShellProfile {
  return { id: 'p', label: 'p', file, args, cwd: 'C:/repos', detected: true };
}

describe('isClosable', () => {
  it('always allows closing a shell tab', () => {
    expect(isClosable(session({ kind: 'shell', actionId: null, running: true }), null)).toBe(true);
    expect(isClosable(session({ kind: 'shell', actionId: null, running: false }), null)).toBe(true);
  });

  it('allows closing a task tab even while it runs', () => {
    // Regression lock: a commit tab used to be permanent, so once the TUI finished it sat in the
    // strip forever with no way to dismiss it. It is a one-shot task, not furniture.
    expect(isClosable(session({ actionId: 'commit', running: true }), 'task')).toBe(true);
    expect(isClosable(session({ actionId: 'commit', running: false }), 'task')).toBe(true);
  });

  it('protects a running server action from a stray click', () => {
    // `Stop` is the deliberate way to end a server; a close button beside it would make killing a
    // build one misplaced click away.
    expect(isClosable(session({ running: true }), 'server')).toBe(false);
  });

  it('allows closing a server tab once it has stopped', () => {
    expect(isClosable(session({ running: false }), 'server')).toBe(true);
  });
});

describe('decideRerun', () => {
  it('spawns when the action has no tab yet', () => {
    expect(decideRerun(undefined, 'server')).toBe('spawn');
    expect(decideRerun(undefined, 'task')).toBe('spawn');
  });

  it('replaces a tab whose process has ended, whatever its role', () => {
    // The tab and its scrollback are kept right up to the moment the same action runs again: that
    // output is usually the reason the tab is still there.
    expect(decideRerun({ running: false }, 'server')).toBe('spawn');
    expect(decideRerun({ running: false }, 'task')).toBe('spawn');
  });

  it('restarts a server that is still running', () => {
    /*
     * The regression this locks. The old rule handed back the existing tab and started nothing, which
     * read as reasonable and was a trap: in any state where the row and the sessions disagreed (a
     * stale exit reported for a replaced session, so the row said "crashed" over a live process), the
     * row showed `Run` and clicking it did **nothing, forever**. A restart always does something
     * observable, and it repairs that disagreement instead of being stuck behind it.
     */
    expect(decideRerun({ running: true }, 'server')).toBe('restart');
  });

  it('leaves a running task alone', () => {
    // `Commit` runs husky and lint-staged, which can take half a minute. A second click must not kill
    // a commit in flight, so the tab is handed back and nothing is started.
    expect(decideRerun({ running: true }, 'task')).toBe('reuse');
  });
});

describe('isUnreachable', () => {
  const project: Project = {
    id: 'web',
    label: 'Web',
    path: 'C:/repos/web',
    actions: [action(), action({ id: 'commit', label: 'Commit', command: 'commit', role: 'task' })],
    kind: 'server',
    expectedPort: 4200,
    tags: [],
  };

  it('never touches a free shell, which belongs to no project', () => {
    expect(isUnreachable({ projectId: null, actionId: null }, null, undefined)).toBe(false);
  });

  it('keeps a repository shell, which belongs to no action', () => {
    // The regression this guards: a repo shell has a projectId and no actionId, so an action lookup
    // finds nothing and an earlier version closed the shell on every settings save.
    expect(isUnreachable({ projectId: 'web', actionId: null }, null, project)).toBe(false);
  });

  it('drops any tab of a project that no longer exists', () => {
    expect(isUnreachable({ projectId: 'gone', actionId: 'run' }, 'server', undefined)).toBe(true);
    expect(isUnreachable({ projectId: 'gone', actionId: null }, null, undefined)).toBe(true);
  });

  it('drops a tab whose action was deleted', () => {
    expect(isUnreachable({ projectId: 'web', actionId: 'lint' }, 'task', project)).toBe(true);
  });

  it('keeps a tab whose action is still there', () => {
    expect(isUnreachable({ projectId: 'web', actionId: 'run' }, 'server', project)).toBe(false);
    expect(isUnreachable({ projectId: 'web', actionId: 'commit' }, 'task', project)).toBe(false);
  });

  it('keeps a reserved git tab, whose action id names no configured action', () => {
    /*
     * The Git tab's commit runs in a tab carrying `git:commit`, which is deliberately not one of the
     * project's actions: it is built by the app, not configured by the user. Looked up in the action
     * list it finds nothing, so without the `git:` exemption every settings save would close a commit
     * while its pre-commit hooks were still running.
     */
    expect(isUnreachable({ projectId: 'web', actionId: GIT_COMMIT_ACTION_ID }, 'task', project)).toBe(
      false,
    );
  });

  it('still drops a reserved tab when the project itself is gone', () => {
    // The exemption is about the action list, not about the project: no project, no folder to run in.
    expect(
      isUnreachable({ projectId: 'gone', actionId: GIT_COMMIT_ACTION_ID }, 'task', undefined),
    ).toBe(true);
  });

  it('drops a running server whose action was demoted to a task', () => {
    // The row would then show neither Run nor Stop for it, and the port would stay held for good.
    const demoted: Project = {
      ...project,
      actions: [action({ role: 'task' })],
    };
    expect(isUnreachable({ projectId: 'web', actionId: 'run' }, 'server', demoted)).toBe(true);
  });
});

describe('stopProjectServer', () => {
  it('reports false when the project has nothing running', () => {
    // The point of the boolean: a `Stop` that finds nothing must say so. When the renderer did this
    // lookup itself, the same situation was a silent no-op and the button looked broken.
    const manager = new TerminalManager({
      onOutput: () => {},
      onParsed: () => {},
      onProjectStartExit: () => {},
      onSessionsChanged: () => {},
      onLayoutChanged: () => {},
    });
    expect(manager.stopProjectServer('web-app')).toBe(false);
  });
});

/*
 * The two tests below drive a **real** pty, unlike everything else in this file.
 *
 * They earn the exception: what they cover is a race between a `taskkill` and a `Map.delete`, which no
 * pure function can express and which cost a genuinely puzzling bug — a red `Run` button that did
 * nothing at all, in a row whose server was running the whole time. Windows-only, like `killTree`
 * itself, so they are skipped elsewhere rather than failing for the wrong reason.
 */
const onWindows = process.platform === 'win32';
const CMD = 'C:/WINDOWS/System32/cmd.exe';

function serverProject(command: string): { project: Project; action: ProjectAction } {
  const serverAction = action({ command });
  return {
    project: {
      id: 'demo',
      label: 'Demo',
      path: process.cwd(),
      actions: [serverAction],
      kind: 'server',
      expectedPort: 4200,
      tags: [],
    },
    action: serverAction,
  };
}

/*
 * The Git tab's commit and amend, launched the way the tab launches them.
 *
 * Driven through `runProjectCommand` against a real pty rather than by asserting a string, because
 * the bug this pins was invisible to every other kind of test: `pty.spawn('git', ...)` **throws**
 * `File not found` on Windows, where `execFile('git', ...)` and `CreateProcessW` both append `.exe`
 * themselves. node-pty is the one spawner in this app that does not, so the Git tab shipped with a
 * commit and an amend that opened a tab reading `Could not launch git`, which any reader would take
 * for git being absent from the machine.
 *
 * No type and no lint rule can catch that: both spellings are strings, and the failing one is the one
 * that looks right everywhere else in the codebase.
 */
describe.runIf(onWindows)('the git binary a pty is handed', () => {
  const gitProject = (): Project => ({
    id: 'git-fixture',
    label: 'Fixture',
    path: process.cwd(),
    actions: [],
    kind: 'server',
    expectedPort: null,
    tags: [],
  });

  const manager = (): TerminalManager =>
    new TerminalManager({
      onOutput: () => {},
      onParsed: () => {},
      onProjectStartExit: () => {},
      onSessionsChanged: () => {},
      onLayoutChanged: () => {},
    });

  it('launches and runs under GIT_PTY_FILE', async () => {
    const instance = manager();
    const id = instance.runProjectCommand({
      project: gitProject(),
      actionId: GIT_COMMIT_ACTION_ID,
      title: 'Fixture commit',
      file: GIT_PTY_FILE,
      args: ['--version'],
      size: { cols: 80, rows: 24 },
    });
    expect(id).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1500));

    /*
     * Stripped before matching, and that is not tidiness. ConPTY emits the first character of the
     * output, then the window-title OSC sequence, then the rest, so the raw buffer literally reads
     * `g<title escape>it version`: a plain `toContain('git version')` fails on a run that worked.
     * `stripAnsi` is the app's own, and its OSC branch is what closes the word back up.
     */
    const buffer = stripAnsi(instance.buffer(id as string));
    expect(buffer).toContain('git version');
    expect(buffer).not.toContain('Could not launch');
    instance.stopAll();
  }, 15_000);

  it('does NOT launch under a bare name, which is why the constant exists', async () => {
    /*
     * Pinning a quirk of a dependency, deliberately, because it is the reason for a line of code that
     * otherwise looks redundant. If node-pty ever starts resolving a bare name, this test fails and
     * that failure is the signal to simplify `GIT_PTY_FILE` away, not to weaken the assertion.
     */
    const instance = manager();
    const id = instance.runProjectCommand({
      project: gitProject(),
      actionId: GIT_COMMIT_ACTION_ID,
      title: 'Fixture commit',
      file: 'git',
      args: ['--version'],
      size: { cols: 80, rows: 24 },
    });
    expect(id).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(instance.buffer(id as string)).toContain('Could not launch git');
    instance.stopAll();
  }, 15_000);
});

describe.runIf(onWindows)('exit reporting', () => {
  it('reports the exit of a session it still owns', async () => {
    const exits: { code: number; stopped: boolean }[] = [];
    const manager = new TerminalManager({
      onOutput: () => {},
      onParsed: () => {},
      onProjectStartExit: (_projectId, code, stopped) => exits.push({ code, stopped }),
      onSessionsChanged: () => {},
      onLayoutChanged: () => {},
    });

    const { project, action: serverAction } = serverProject('exit 1');
    await manager.runProjectAction(project, serverAction, profile(CMD), { cols: 80, rows: 24 });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // A non-zero exit nobody asked for: this is what paints the row `crash`, and it must keep working.
    expect(exits).toEqual([{ code: 1, stopped: false }]);
    manager.stopAll();
  }, 15_000);

  it('drops the exit of a session that was closed before its process died', async () => {
    /*
     * The regression. `close()` fires `taskkill /T /F` and deletes the entry straight away, so the pty
     * exits a few hundred milliseconds later with nothing left to attach it to. Reported, that exit
     * described the dead process while landing on the row of whatever is running now: the row went
     * `crashed` over a live server, and from there `Run` was displayed, enabled, and permanently inert.
     */
    const exits: number[] = [];
    const manager = new TerminalManager({
      onOutput: () => {},
      onParsed: () => {},
      onProjectStartExit: (_projectId, code) => exits.push(code),
      onSessionsChanged: () => {},
      onLayoutChanged: () => {},
    });

    // Something that stays alive long enough to still be running when the tab is closed.
    const { project, action: serverAction } = serverProject('ping -n 30 127.0.0.1');
    const first = await manager.runProjectAction(project, serverAction, profile(CMD), {
      cols: 80,
      rows: 24,
    });
    expect(first).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));

    manager.close(first as string);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(exits).toEqual([]);
    manager.stopAll();
  }, 15_000);
});

describe('resolveActionCommand', () => {
  it('runs a command through cmd with /c', () => {
    // A pty does not resolve `.cmd` shims the way a shell does, so a bare `npm` would not launch.
    const resolved = resolveActionCommand(action(), profile('C:/WINDOWS/System32/cmd.exe'));
    expect(resolved.file).toBe('C:/WINDOWS/System32/cmd.exe');
    expect(resolved.args).toEqual(['/c', 'npm run start']);
  });

  it('runs bash INTERACTIVE, not login, so aliases exist', () => {
    // With `-lc`, `type commit` reports "not found": a login shell reads `.bash_profile` rather than
    // the `.bashrc` that defines the alias, and bash does not expand aliases in a non-interactive
    // shell at all. Both verified on the machine.
    const resolved = resolveActionCommand(
      action({ command: 'commit', role: 'task' }),
      profile('C:/Program Files/Git/bin/bash.exe', ['-i']),
    );
    expect(resolved.args[0]).toBe('-ic');
    expect(resolved.args[0]).not.toBe('-lc');
    expect(resolved.args[1]).toBe('commit');
  });

  it('keeps the command as one argument', () => {
    // Splitting on spaces would break the first quoted path or `&&` the user writes.
    const resolved = resolveActionCommand(
      action({ command: 'npm run build && echo "done here"' }),
      profile('C:/Program Files/Git/bin/bash.exe'),
    );
    expect(resolved.args).toHaveLength(2);
    expect(resolved.args[1]).toBe('npm run build && echo "done here"');
  });

  it('uses -Command for PowerShell', () => {
    const resolved = resolveActionCommand(action(), profile('C:/WINDOWS/System32/powershell.exe'));
    expect(resolved.args).toEqual(['-NoLogo', '-Command', 'npm run start']);
  });

  it('goes through WSL with a bash of its own', () => {
    const resolved = resolveActionCommand(action(), profile('C:/WINDOWS/System32/wsl.exe'));
    expect(resolved.args).toEqual(['-e', 'bash', '-ic', 'npm run start']);
  });

  it('falls back to cmd for an unknown executable rather than guessing a flag', () => {
    // The profile's own args are dropped on purpose: they configure an interactive session, not a
    // one-shot command, and passing them to something expecting a script fails unreadably.
    const resolved = resolveActionCommand(action(), profile('D:/tools/weird-shell.exe', ['--login']));
    expect(resolved.file).toBe('cmd.exe');
    expect(resolved.args).toEqual(['/c', 'npm run start']);
  });
});
