import { describe, expect, it } from 'vitest';
import {
  SKIP_PERMISSIONS_FLAG,
  buildWorkCommand,
  resolveClaudeContext,
  safeRepoName,
} from '../src/main/triage/work-command.js';

describe('buildWorkCommand', () => {
  it('skips the permission prompts, with the flag spelled the way the CLI accepts it', () => {
    // The one spelling that exists. An unknown option makes `claude` print usage and exit, which looks
    // exactly like a session that started and did nothing, so this is pinned rather than trusted.
    expect(SKIP_PERMISSIONS_FLAG).toBe('--dangerously-skip-permissions');
    expect(buildWorkCommand(['PROJ-123'], 'web-app')).toContain(
      'claude --dangerously-skip-permissions ',
    );
  });

  it('names the repository in the prompt, since the session no longer starts inside it', () => {
    // The pairing with `resolveClaudeContext`: the working directory is the workspace, so the only way
    // the session can know which repository the ticket is about is for the prompt to say so.
    expect(buildWorkCommand(['PROJ-123'], 'web-app')).toBe(
      'claude --dangerously-skip-permissions "/ticket PROJ-123 in the web-app repository"',
    );
  });

  it('lists a batch in order and lets the skill run once per ticket', () => {
    const command = buildWorkCommand(['PROJ-1', 'PROJ-2'], 'admin-front');
    expect(command).toContain('in the admin-front repository');
    expect(command).toContain('PROJ-1, PROJ-2');
    // Not a slash command for a batch: `/ticket` takes one ticket, and handing it two would leave the
    // second one to be inferred from a sentence the skill never reads.
    expect(command).not.toContain('/ticket');
  });

  it('drops the repository clause rather than writing an empty one', () => {
    // A folder name that sanitises to nothing is unlikely, but "in the  repository" would be worse than
    // saying nothing: it reads as a repository whose name the tab lost.
    expect(buildWorkCommand(['PROJ-1'], '???')).toBe(
      'claude --dangerously-skip-permissions "/ticket PROJ-1"',
    );
  });
});

describe('safeRepoName', () => {
  it('keeps what a folder name really contains', () => {
    expect(safeRepoName('web-app')).toBe('web-app');
    expect(safeRepoName('design.system_2')).toBe('design.system_2');
  });

  it('removes what a shell would read as syntax', () => {
    // The name lands inside a double-quoted argument, and bash expands `$` and backticks in there. A
    // configured project path is not renderer input, but the cost of the guard is one regular expression.
    expect(safeRepoName('web-app$(whoami)')).toBe('web-appwhoami');
    expect(safeRepoName('web "app"')).toBe('webapp');
  });

  it('reports nothing left rather than an empty name', () => {
    expect(safeRepoName('   ')).toBeNull();
    expect(safeRepoName('$`"')).toBeNull();
  });
});

describe('resolveClaudeContext', () => {
  const exists = (path: string): boolean => path === 'C:/workspace';

  it('starts in the workspace, so the session inherits what lives above the repositories', () => {
    expect(resolveClaudeContext('C:/workspace', 'C:/workspace/repos/web-app', exists)).toBe(
      'C:/workspace',
    );
  });

  it('falls back to the repository when the configured root is not on disk', () => {
    // A pty spawned on a missing directory fails, and the tab would close on an error about a path
    // nobody typed today. The fallback is what every version before this one did.
    expect(resolveClaudeContext('C:/gone', 'C:/workspace/repos/web-app', exists)).toBe(
      'C:/workspace/repos/web-app',
    );
  });

  it('treats an empty setting as "start in the repository"', () => {
    // A real answer, not a missing one: it is how the previous behaviour stays available.
    expect(resolveClaudeContext('', 'C:/workspace/repos/web-app', exists)).toBe(
      'C:/workspace/repos/web-app',
    );
    expect(resolveClaudeContext('   ', 'C:/workspace/repos/web-app', exists)).toBe(
      'C:/workspace/repos/web-app',
    );
  });
});
