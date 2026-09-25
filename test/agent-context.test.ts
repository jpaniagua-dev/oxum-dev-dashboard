import { describe, expect, it } from 'vitest';
import {
  ancestorDirs,
  claudeProjectKey,
  parseMemoryCard,
} from '../src/shared/agent-context.js';
import { describeAgentTask, describeExit } from '../src/renderer/ui/agents-panel.js';

/**
 * A session's context is derived from its working directory alone, which is what makes it knowable
 * without asking the agent anything. It is also string surgery with an off-by-one at every
 * separator, hence these.
 */
describe('ancestorDirs', () => {
  it('lists the folders root first, so the general rules read before the specific ones', () => {
    // The order instructions are APPLIED in: the nearest file wins, so a reader going down the list
    // meets what gets overridden before what overrides it.
    expect(ancestorDirs('C:\\Users\\julpan\\oxum\\projects\\web-app')).toEqual([
      'C:',
      'C:\\Users',
      'C:\\Users\\julpan',
      'C:\\Users\\julpan\\oxum',
      'C:\\Users\\julpan\\oxum\\projects',
      'C:\\Users\\julpan\\oxum\\projects\\web-app',
    ]);
  });

  it('ignores a trailing separator rather than producing an empty folder', () => {
    expect(ancestorDirs('C:\\repos\\app\\')).toEqual(ancestorDirs('C:\\repos\\app'));
  });

  it('handles a POSIX path, root included', () => {
    expect(ancestorDirs('/home/dev/app')).toEqual(['/', '/home', '/home/dev', '/home/dev/app']);
  });

  it('answers nothing for nothing', () => {
    expect(ancestorDirs('')).toEqual([]);
    expect(ancestorDirs('/')).toEqual([]);
  });
});

describe('claudeProjectKey', () => {
  it('turns a working directory into the folder Claude Code stores it under', () => {
    // Read off a real ~/.claude/projects: the drive's colon and the separator both become a dash,
    // which is why the drive produces two in a row.
    expect(claudeProjectKey('C:\\Users\\julpan\\oxum')).toBe('C--Users-julpan-oxum');
    expect(claudeProjectKey('C:\\Users\\julpan\\oxum\\projects\\oxum-dev-dashboard')).toBe(
      'C--Users-julpan-oxum-projects-oxum-dev-dashboard',
    );
  });

  it('gives the same key whichever separator the path was written with', () => {
    // The app carries both: a project path comes from a settings file a human edited, and a cwd comes
    // from node. Two keys for one folder would look up an empty directory half the time.
    expect(claudeProjectKey('C:/Users/julpan/oxum')).toBe(claudeProjectKey('C:\\Users\\julpan\\oxum'));
  });

  it('ignores a trailing separator', () => {
    expect(claudeProjectKey('C:\\repos\\app\\')).toBe('C--repos-app');
  });

  it('is lossy, and is therefore never inverted', () => {
    // A folder whose own name holds a dash encodes to the same shape as a nested one. Stated as a
    // test so nobody writes the reverse function.
    expect(claudeProjectKey('C:\\a\\b-c')).toBe(claudeProjectKey('C:\\a\\b\\c'));
  });
});

describe('parseMemoryCard', () => {
  const card = [
    '---',
    'name: no-em-dashes',
    'description: "never use an em dash in anything written"',
    'metadata:',
    '  type: feedback',
    '---',
    '',
    'Body text that also has a description: somewhere in it.',
  ].join('\n');

  it('reads the name and the description out of the frontmatter', () => {
    expect(parseMemoryCard('no-em-dashes.md', card)).toEqual({
      name: 'no-em-dashes',
      description: 'never use an em dash in anything written',
    });
  });

  it('does not pick up a key that appears in the body', () => {
    // Anchored to a line inside the frontmatter block, so prose cannot overwrite the index.
    expect(parseMemoryCard('x.md', card).description).not.toContain('somewhere in it');
  });

  it('falls back to the filename when there is no frontmatter at all', () => {
    expect(parseMemoryCard('loose-note.md', 'just a note')).toEqual({
      name: 'loose-note',
      description: '',
    });
  });

  it('falls back to the filename when the frontmatter names nothing', () => {
    expect(parseMemoryCard('x.md', '---\nmetadata:\n  type: user\n---\nbody').name).toBe('x');
  });

  it('survives CRLF, which is what these files are written with here', () => {
    const crlf = '---\r\nname: windows-card\r\ndescription: written on Windows\r\n---\r\nbody';
    expect(parseMemoryCard('x.md', crlf)).toEqual({
      name: 'windows-card',
      description: 'written on Windows',
    });
  });
});

/**
 * What a row of the Agents list says a session is working on.
 *
 * Read out of the ACTION ID and never out of the title: the handoff writes the ticket keys into the
 * id when it spawns the tab, so a tab renamed by hand still reports the right ticket.
 */
describe('describeAgentTask', () => {
  it('reads one ticket off a handoff', () => {
    expect(describeAgentTask('git:triage-work:PROJ-1801')).toBe('PROJ-1801');
  });

  it('reads a batch, in the order the id holds them', () => {
    expect(describeAgentTask('git:triage-work:PROJ-1801-PROJ-1802')).toBe('PROJ-1801, PROJ-1802');
  });

  it('reads a pull request number off a feedback pass', () => {
    expect(describeAgentTask('git:pr-feedback:example-org/web-app#42')).toBe('PR #42');
  });

  it('says nothing for an agent started from the button', () => {
    // It was opened to work on whatever you are about to tell it. Inventing a subject would be a
    // label the app made up.
    expect(describeAgentTask(null)).toBe('');
  });

  it('says nothing for an action it does not recognise', () => {
    expect(describeAgentTask('git:commit')).toBe('');
    expect(describeAgentTask('run')).toBe('');
  });
});

describe('describeExit', () => {
  it('separates a failure from a cancellation', () => {
    // Killing a process gives it a non-zero code like any other failure, so the code alone reports
    // every deliberate stop as something gone wrong.
    expect(describeExit({ exitCode: 1, stoppedOnPurpose: false })).toBe('failed (1)');
    expect(describeExit({ exitCode: 1, stoppedOnPurpose: true })).toBe('stopped');
  });

  it('calls a clean end finished', () => {
    expect(describeExit({ exitCode: 0, stoppedOnPurpose: false })).toBe('finished');
  });

  it('calls an unknown end finished rather than failed', () => {
    // A session adopted at boot has no recorded code. Reporting that as a failure would put a red
    // word on a session that did nothing wrong.
    expect(describeExit({ exitCode: null, stoppedOnPurpose: false })).toBe('finished');
  });
});
