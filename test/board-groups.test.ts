import { describe, expect, it } from 'vitest';
import {
  cleanName,
  groupAt,
  groupOf,
  memberKeyOf,
  moveToGroup,
  newGroup,
  nextGroupColor,
  sanitizeBoardGroups,
  type BoardGroup,
} from '../src/shared/board-groups.js';
import type { TerminalSession } from '../src/shared/contracts.js';
import { TAG_COLORS } from '../src/shared/project-tags.js';

const CONVERSATION = '0d4f1c3e-8a2b-4c6d-9e1f-2a3b4c5d6e7f';

function session(patch: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 'shell-1',
    title: 'Git Bash',
    kind: 'shell',
    projectId: null,
    actionId: null,
    role: null,
    profileId: 'git-bash',
    cwd: 'C:/work',
    note: null,
    running: true,
    exitCode: null,
    stoppedOnPurpose: false,
    closable: true,
    renamed: false,
    agent: null,
    ...patch,
  };
}

function group(id: string, members: string[], patch: Partial<BoardGroup> = {}): BoardGroup {
  return { id, name: id, color: 'blue', x: 0, y: 0, members, ...patch };
}

describe('the key a card is filed under', () => {
  it('files an agent under its conversation, which the app reopens on', () => {
    const agent = session({
      agent: {
        label: 'Claude Code',
        model: '',
        instructionFile: 'CLAUDE.md',
        startedAt: '',
        conversation: { id: CONVERSATION, plan: false },
      },
    });
    expect(memberKeyOf(agent)).toBe(`agent:${CONVERSATION}`);
  });

  it('files a server or a watch under its project and action, which a rerun lands on again', () => {
    expect(memberKeyOf(session({ kind: 'project', projectId: 'web-app', actionId: 'start' }))).toBe(
      'action:web-app/start',
    );
  });

  it('files a shell, and an agent with no conversation, under its terminal id for this run only', () => {
    expect(memberKeyOf(session())).toBe('session:shell-1');
    expect(
      memberKeyOf(session({ agent: { label: 'Codex', model: '', instructionFile: 'AGENTS.md', startedAt: '' } })),
    ).toBe('session:shell-1');
  });
});

describe('the stored groups', () => {
  it('drops the run-only keys at launch, and only at launch', () => {
    const stored = [group('g1', ['session:shell-3', `agent:${CONVERSATION}`])];
    expect(sanitizeBoardGroups(stored, true)[0]?.members).toEqual([`agent:${CONVERSATION}`]);
    expect(sanitizeBoardGroups(stored)[0]?.members).toHaveLength(2);
  });

  it('keeps a card in the first group that holds it, and cleans what it cannot use', () => {
    const groups = sanitizeBoardGroups([
      group('g1', ['action:web-app/start']),
      { ...group('g2', ['action:web-app/start', 'nonsense', 'action:api/watch']), color: 'purple', name: '  ' },
      group('g1', []),
      'junk',
    ]);
    expect(groups.map((entry) => entry.id)).toEqual(['g1', 'g2']);
    expect(groups[1]).toMatchObject({ color: 'grey', name: 'Group', members: ['action:api/watch'] });
    expect(sanitizeBoardGroups('not a list')).toEqual([]);
  });

  it('names a group with what was typed, on one line and capped', () => {
    expect(cleanName('  Fiscal   year  ')).toBe('Fiscal year');
    expect(cleanName('x'.repeat(80))).toHaveLength(40);
  });
});

describe('moving cards between groups', () => {
  const groups = [group('g1', ['a:1']), group('g2', [])];

  it('takes a card out of its group when it joins another: one frame at most', () => {
    const moved = moveToGroup(groups, 'a:1', 'g2');
    expect(moved.map((entry) => entry.members)).toEqual([[], ['a:1']]);
    expect(groupOf(moved, 'a:1')?.id).toBe('g2');
  });

  it('takes it out of every group when dropped outside a frame', () => {
    expect(moveToGroup(groups, 'a:1', null).every((entry) => entry.members.length === 0)).toBe(true);
  });

  it('leaves a card where it is when it is moved into its own group', () => {
    expect(moveToGroup(groups, 'a:1', 'g1')).toEqual(groups);
  });
});

describe('frames on the canvas', () => {
  const frames = [
    { id: 'g1', rect: { x: 0, y: 0, width: 500, height: 300 } },
    { id: 'g2', rect: { x: 400, y: 100, width: 500, height: 300 } },
  ];

  it('finds the frame under a point, the one drawn last when two overlap', () => {
    expect(groupAt({ x: 100, y: 100 }, frames)).toBe('g1');
    expect(groupAt({ x: 450, y: 150 }, frames)).toBe('g2');
    expect(groupAt({ x: 1000, y: 1000 }, frames)).toBeNull();
  });

  it('names a new group after the ones there are, and colours it with the least used colour', () => {
    const existing = [group('g1', [], { name: 'Group 1', color: 'blue' })];
    const fresh = newGroup(existing, { x: 10.4, y: 20.6 }, nextGroupColor(existing, TAG_COLORS));
    expect(fresh).toMatchObject({ name: 'Group 2', color: 'green', x: 10, y: 21, members: [] });
    expect(sanitizeBoardGroups([fresh])).toHaveLength(1);
  });
});
