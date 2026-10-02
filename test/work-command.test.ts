import { describe, expect, it } from 'vitest';
import {
  SKIP_PERMISSIONS_FLAG,
  buildWorkCommand,
  handoffPrompt,
  resolveWorkspaceRoot,
  safeSkill,
  safeRepoName,
} from '../src/main/triage/work-command.js';

/** The handoff as it ran before it became a setting: the `/ticket` skill. */
const SKILL = { skill: '/ticket', notes: '' };

describe('buildWorkCommand, model', () => {
  it('omits the flag when no model is pinned, which is the default', () => {
    expect(buildWorkCommand(['PROJ-123'], 'web-app', '', undefined, 'ask', SKILL)).toBe(
      'claude --dangerously-skip-permissions "/ticket PROJ-123 in the web-app repository"',
    );
  });

  it('quotes the model, this being the one Claude Code run that reaches a shell', () => {
    // `claude-opus-5[1m]` unquoted is a bracket expression to bash, and the tab would either run on
    // the wrong model or fail on a name nobody typed.
    expect(buildWorkCommand(['PROJ-123'], 'web-app', 'claude-opus-5[1m]')).toContain(
      'claude --model "claude-opus-5[1m]" --dangerously-skip-permissions',
    );
  });

  it('drops a model that is not a model rather than putting it on the command line', () => {
    expect(buildWorkCommand(['PROJ-123'], 'web-app', 'opus"; id #')).not.toContain('--model');
  });
});

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
    // The pairing with `resolveWorkspaceRoot`: the working directory is the workspace, so the only way
    // the session can know which repository the ticket is about is for the prompt to say so.
    expect(buildWorkCommand(['PROJ-123'], 'web-app', '', undefined, 'ask', SKILL)).toBe(
      'claude --dangerously-skip-permissions "/ticket PROJ-123 in the web-app repository"',
    );
  });

  it('lists a batch in order and lets the skill run once per ticket', () => {
    const command = buildWorkCommand(['PROJ-1', 'PROJ-2'], 'admin-front', '', undefined, 'ask', SKILL);
    expect(command).toContain('in the admin-front repository');
    expect(command).toContain('PROJ-1, PROJ-2');
    // Not a slash command for a batch: `/ticket` takes one ticket, and handing it two would leave the
    // second one to be inferred from a sentence the skill never reads.
    expect(command).not.toContain('/ticket PROJ');
  });

  it('drops the repository clause rather than writing an empty one', () => {
    // A folder name that sanitises to nothing is unlikely, but "in the  repository" would be worse than
    // saying nothing: it reads as a repository whose name the tab lost.
    expect(buildWorkCommand(['PROJ-1'], '???', '', undefined, 'ask', SKILL)).toBe(
      'claude --dangerously-skip-permissions "/ticket PROJ-1"',
    );
  });
});

describe('handoffPrompt, without a skill', () => {
  const notes = 'C:/Users/dev/AppData/Roaming/app/triage.json';

  it('says what to do and where the notes are, needing nothing installed', () => {
    const ask = handoffPrompt(['PROJ-7'], 'web-app', 'ask', { skill: '', notes });
    expect(ask).toMatch(/^Work on ticket PROJ-7 in the web-app repository\./);
    expect(ask).toContain(`The triage notes about it are in ${notes}.`);
    expect(ask).toContain('Ask before pushing');
    const auto = handoffPrompt(['PROJ-7'], 'web-app', 'auto', { skill: '', notes });
    expect(auto).toContain('open a draft pull request with gh');
  });

  it('holds nothing a shell would expand inside its double quotes', () => {
    for (const handoff of ['ask', 'auto'] as const) {
      expect(handoffPrompt(['PROJ-1', 'PROJ-2'], 'web', handoff, { skill: '', notes })).not.toMatch(/["`$%!]/);
    }
    // A notes path that is not safe is left out rather than quoted.
    expect(handoffPrompt(['PROJ-1'], 'web', 'ask', { skill: '', notes: 'C:/$(x)/t.json' })).not.toContain('notes');
  });

  it('accepts a skill name and nothing else', () => {
    expect(safeSkill('ticket')).toBe('/ticket');
    expect(safeSkill('/plugin:ticket-auto')).toBe('/plugin:ticket-auto');
    expect(safeSkill('ticket; rm')).toBeNull();
    expect(safeSkill('')).toBeNull();
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

describe('resolveWorkspaceRoot', () => {
  const exists = (path: string): boolean => path === 'C:/workspace';

  it('starts in the workspace, so the session inherits what lives above the repositories', () => {
    expect(resolveWorkspaceRoot('C:/workspace', 'C:/workspace/repos/web-app', exists)).toBe(
      'C:/workspace',
    );
  });

  it('falls back to the repository when the configured root is not on disk', () => {
    // A pty spawned on a missing directory fails, and the tab would close on an error about a path
    // nobody typed today. The fallback is what every version before this one did.
    expect(resolveWorkspaceRoot('C:/gone', 'C:/workspace/repos/web-app', exists)).toBe(
      'C:/workspace/repos/web-app',
    );
  });

  it('treats an empty setting as "start in the repository"', () => {
    // A real answer, not a missing one: it is how the previous behaviour stays available.
    expect(resolveWorkspaceRoot('', 'C:/workspace/repos/web-app', exists)).toBe(
      'C:/workspace/repos/web-app',
    );
    expect(resolveWorkspaceRoot('   ', 'C:/workspace/repos/web-app', exists)).toBe(
      'C:/workspace/repos/web-app',
    );
  });
});
