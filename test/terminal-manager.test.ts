import { describe, expect, it } from 'vitest';
import {
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

function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 't1',
    title: 'tab',
    kind: 'project',
    projectId: 'web-app',
    actionId: 'run',
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

describe('isUnreachable', () => {
  const project: Project = {
    id: 'web',
    label: 'Web',
    path: 'C:/repos/web',
    actions: [action(), action({ id: 'commit', label: 'Commit', command: 'commit', role: 'task' })],
    kind: 'server',
    expectedPort: 4200,
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
