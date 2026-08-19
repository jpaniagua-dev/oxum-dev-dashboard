import { describe, expect, it } from 'vitest';
import type { WorktreeCommand } from '../src/shared/contracts.js';
import {
  WORKTREE_HELPER,
  anchorPattern,
  buildWorktreeCommand,
  isTicketLabel,
  parseCreateInput,
  parseWorktreeCommand,
  sanitizeDescription,
  shellQuote,
} from '../src/main/git/worktree-command.js';

/**
 * These pin a command line that **deletes folders**.
 *
 * Everything here is one string away from removing the wrong worktree or throwing away uncommitted
 * work, and none of it is visible from the screen: the tab shows a menu entry, the consequence shows up
 * in a terminal tab a second later. That asymmetry is the whole reason this module is pure and separate
 * from `ipc.ts`.
 */

const remove = (over: Partial<Extract<WorktreeCommand, { kind: 'remove' }>> = {}): WorktreeCommand => ({
  kind: 'remove',
  label: 'PROJ-123-web-app',
  discardChanges: false,
  deleteBranch: false,
  ...over,
});

describe('buildWorktreeCommand, removing', () => {
  it('anchors the pattern so it names that worktree and no other', () => {
    // The helper matches its argument unanchored against every label, repository and branch it knows,
    // so a bare `PROJ-12` would also match `PROJ-123`. It refuses on the ambiguity rather than guessing,
    // which is safe but sends the user back to the terminal for a click that should have worked.
    expect(buildWorktreeCommand(remove(), 'web-app').command).toBe(
      `${WORKTREE_HELPER} rm '^PROJ-123-web-app$'`,
    );
  });

  it('adds -f only when asked, and -d only when asked', () => {
    expect(buildWorktreeCommand(remove({ deleteBranch: true }), 'web-app').command).toBe(
      `${WORKTREE_HELPER} rm '^PROJ-123-web-app$' -d`,
    );
    expect(buildWorktreeCommand(remove({ discardChanges: true }), 'web-app').command).toBe(
      `${WORKTREE_HELPER} rm '^PROJ-123-web-app$' -f`,
    );
    expect(
      buildWorktreeCommand(remove({ discardChanges: true, deleteBranch: true }), 'web-app').command,
    ).toBe(`${WORKTREE_HELPER} rm '^PROJ-123-web-app$' -f -d`);
  });

  it('never lets a flag ride along on a plain removal', () => {
    // The one that matters: `-f` discards uncommitted work, so a bare `Remove` that quietly carried it
    // would turn a refusal (the good outcome) into a silent loss.
    const line = buildWorktreeCommand(remove(), 'web-app').command ?? '';
    expect(line).not.toContain('-f');
    expect(line).not.toContain('-d');
  });

  it('refuses a name that could be read as shell syntax, instead of quoting and hoping', () => {
    const built = buildWorktreeCommand(remove({ label: 'web-app; rm -rf ~' }), 'web-app');
    expect(built.command).toBeUndefined();
    expect(built.error).toContain('not a name');
  });
});

describe('buildWorktreeCommand, renaming', () => {
  it('passes the anchored pattern and the bare new label', () => {
    // The new label is a label and not a folder name: the helper appends the repository itself, which
    // is what keeps `wip-toast-web-app` turning into `PROJ-9-web-app` and not into a hand-typed name
    // the branch no longer agrees with.
    expect(
      buildWorktreeCommand(
        { kind: 'rename', label: 'wip-toast-web-app', newLabel: 'PROJ-9' },
        'web-app',
      ).command,
    ).toBe(`${WORKTREE_HELPER} mv '^wip-toast-web-app$' PROJ-9`);
  });

  it('refuses a new label that is not a label', () => {
    const built = buildWorktreeCommand(
      { kind: 'rename', label: 'wip-toast-web-app', newLabel: 'a b' },
      'web-app',
    );
    expect(built.command).toBeUndefined();
    expect(built.error).toContain('new label');
  });
});

describe('buildWorktreeCommand, creating', () => {
  it('names the repository by its folder, and quotes the description', () => {
    expect(
      buildWorktreeCommand(
        { kind: 'create', label: 'PROJ-9', description: 'documents list' },
        'web-app',
      ).command,
    ).toBe(`${WORKTREE_HELPER} new web-app PROJ-9 'documents list'`);
  });

  it('refuses a ticket label with no description, on the field rather than in a tab', () => {
    // The helper refuses this too. Refusing here as well is what puts the message next to what is being
    // typed, instead of opening a terminal tab only to complain in it.
    const built = buildWorktreeCommand({ kind: 'create', label: 'PROJ-9', description: '  ' }, 'web-app');
    expect(built.command).toBeUndefined();
    expect(built.error).toContain('needs a description');
  });

  it('takes a slug label on its own, a slug being its own description', () => {
    expect(
      buildWorktreeCommand({ kind: 'create', label: 'toast-zone-escape', description: '' }, 'web-app')
        .command,
    ).toBe(`${WORKTREE_HELPER} new web-app toast-zone-escape`);
  });

  it('refuses a repository folder it cannot pass on', () => {
    const built = buildWorktreeCommand(
      { kind: 'create', label: 'PROJ-9', description: 'documents list' },
      'web app',
    );
    expect(built.command).toBeUndefined();
    expect(built.error).toContain('Repository folder');
  });
});

describe('anchorPattern', () => {
  it('matches the name and nothing longer', () => {
    expect(anchorPattern('PROJ-12-web-app')).toBe('^PROJ-12-web-app$');
    expect(new RegExp(anchorPattern('PROJ-12-web-app')).test('PROJ-123-web-app')).toBe(false);
    expect(new RegExp(anchorPattern('PROJ-12-web-app')).test('PROJ-12-web-app')).toBe(true);
  });
});

describe('shellQuote', () => {
  it('reopens the quote around an apostrophe rather than ending the argument', () => {
    expect(shellQuote("l'index")).toBe("'l'\\''index'");
  });

  it('leaves what the shell would otherwise expand inert', () => {
    expect(shellQuote('$HOME `id`')).toBe("'$HOME `id`'");
  });
});

describe('sanitizeDescription', () => {
  it('keeps what a branch name is built from and drops the rest', () => {
    expect(sanitizeDescription('  documents   list  ')).toBe('documents list');
    expect(sanitizeDescription('list; rm -rf ~')).toBe('list rm -rf');
  });

  it('caps a description rather than letting it become the branch name', () => {
    expect(sanitizeDescription('a'.repeat(200)).length).toBe(80);
  });
});

describe('parseCreateInput', () => {
  it('splits the label from the description at the first space', () => {
    expect(parseCreateInput('PROJ-9 documents list')).toEqual({
      label: 'PROJ-9',
      description: 'documents list',
    });
  });

  it('reads a lone slug as a label with nothing to describe', () => {
    expect(parseCreateInput('  toast-zone-escape ')).toEqual({
      label: 'toast-zone-escape',
      description: '',
    });
  });
});

describe('isTicketLabel', () => {
  it('recognises a ticket key and not a slug', () => {
    expect(isTicketLabel('PROJ-123')).toBe(true);
    expect(isTicketLabel('toast-zone-escape')).toBe(false);
    expect(isTicketLabel('PROJ-123-web-app')).toBe(false);
  });
});

describe('parseWorktreeCommand', () => {
  it('reads the flags strictly, a truthy string not being a yes', () => {
    // `"false"` is truthy. Coercing it would arm `--force` on a removal nobody asked to force.
    const parsed = parseWorktreeCommand({
      kind: 'remove',
      label: 'PROJ-1-web-app',
      discardChanges: 'false',
      deleteBranch: 1,
    });
    expect(parsed).toEqual({
      kind: 'remove',
      label: 'PROJ-1-web-app',
      discardChanges: false,
      deleteBranch: false,
    });
  });

  it('refuses anything that is not one of the three gestures', () => {
    expect(parseWorktreeCommand(null)).toBeNull();
    expect(parseWorktreeCommand({ kind: 'prune', label: 'x' })).toBeNull();
    expect(parseWorktreeCommand({ kind: 'remove', label: '   ' })).toBeNull();
    expect(parseWorktreeCommand({ kind: 'rename', label: 'x' })).toBeNull();
  });
});
