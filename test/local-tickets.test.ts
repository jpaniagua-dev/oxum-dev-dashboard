import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JiraState } from '../src/shared/contracts.js';
import {
  localAsIssue,
  nextTicketKey,
  parseTicket,
  readDraft,
  serializeTicket,
  ticketDraftProblem,
  ticketFileName,
} from '../src/shared/local-tickets.js';
import { LocalTicketStore } from '../src/main/tickets/local-ticket-store.js';
import { listOrder, withLocalTickets } from '../src/renderer/ui/jira-board.js';

const TICKET = {
  key: 'LOC-3',
  summary: 'Fix: the "login" timeout',
  type: 'Bug',
  stage: 'in-progress' as const,
  created: '2026-10-02T09:00:00.000Z',
  updated: '2026-10-02T10:00:00.000Z',
};

describe('the ticket file', () => {
  it('round-trips the frontmatter and keeps the body as written', () => {
    const text = serializeTicket(TICKET, '\nLine one\n\n- a list\n');
    expect(parseTicket(text, 'x.md')).toEqual({ ...TICKET, file: 'x.md' });
    expect(text.endsWith('\nLine one\n\n- a list\n')).toBe(true);
    expect(text).toContain('summary: "Fix: the \\"login\\" timeout"');
    expect(text).toContain('status: In progress');
  });

  it('refuses a file without a local key, and defaults a misspelt stage to todo', () => {
    expect(parseTicket('# no frontmatter', 'x.md')).toBe('no frontmatter');
    expect(parseTicket('---\nkey: PROJ-1\n---\n', 'x.md')).toMatch(/LOC/);
    const ticket = parseTicket('---\nkey: LOC-1\nsummary: Hello\nstage: doing\n---\n', 'x.md');
    expect(typeof ticket === 'object' ? ticket.stage : ticket).toBe('todo');
  });

  it('never hands out a number again, and names the file like a branch', () => {
    expect(nextTicketKey([])).toBe('LOC-1');
    expect(nextTicketKey(['LOC-2', 'LOC-10', 'PROJ-99'])).toBe('LOC-11');
    expect(nextTicketKey(['LOC-2'], 7)).toBe('LOC-8');
    expect(ticketFileName('LOC-4', 'Dark mode: toggle!')).toBe('LOC-4-dark-mode-toggle.md');
  });

  it('checks a draft, and reads one sent over IPC', () => {
    expect(ticketDraftProblem({ summary: ' ', type: 'Task', stage: 'todo', description: '' })).toMatch(/title/);
    expect(ticketDraftProblem({ summary: 'Ok', type: 'Task', stage: 'unknown', description: '' })).toMatch(/column/);
    expect(readDraft({ summary: ' Ok ', type: '', stage: 'done', description: 'x' })).toEqual({
      summary: 'Ok',
      type: 'Task',
      stage: 'done',
      description: 'x',
    });
    expect(readDraft({ summary: 'Ok', type: 'Task', stage: 'later', description: '' })).toBeNull();
  });

  it('becomes a card of the board: the reader own, with no page', () => {
    expect(localAsIssue({ ...TICKET, file: 'x.md' })).toMatchObject({
      key: 'LOC-3',
      source: 'local',
      isMine: true,
      assignee: '',
      url: '',
      status: 'In progress',
    });
  });
});

describe('the local tickets next to Jira', () => {
  const local = localAsIssue({ ...TICKET, file: 'x.md' });
  const jira = { ...local, key: 'PROJ-1', source: 'jira' as const, stage: 'todo' as const };

  it('adds the local tickets to every Jira view', () => {
    const state: JiraState = {
      configured: true,
      views: [
        { id: 'sprint', label: 'Sprint', issues: [jira], checkedAt: 'x', error: null, truncated: false },
        { id: 'mine', label: 'My issues', issues: [], checkedAt: 'x', error: null, truncated: false },
      ],
    };
    const merged = withLocalTickets(state, [local]);
    expect(merged.jiraConfigured).toBe(true);
    expect(merged.state.views.map((view) => view.issues.map((issue) => issue.key))).toEqual([
      ['PROJ-1', 'LOC-3'],
      ['LOC-3'],
    ]);
  });

  it('still draws the local tickets when Jira is not configured', () => {
    const merged = withLocalTickets({ configured: false, views: [] }, [local]);
    expect(merged.jiraConfigured).toBe(false);
    expect(merged.state.configured).toBe(true);
    expect(merged.state.views[0]?.issues).toEqual([local]);
  });

  it('lists what is moving first, keeping the order inside each group', () => {
    const done = { ...jira, key: 'PROJ-2', stage: 'done' as const };
    const waiting = { ...jira, key: 'PROJ-3' };
    expect(listOrder([done, jira, local, waiting]).map((issue) => issue.key)).toEqual([
      'LOC-3',
      'PROJ-1',
      'PROJ-3',
      'PROJ-2',
    ]);
  });
});

describe('LocalTicketStore', () => {
  let root: string;
  let dir: string;
  let store: LocalTicketStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tickets-'));
    dir = join(root, 'tickets');
    store = new LocalTicketStore(() => dir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads an absent folder as empty, then creates, moves and finds tickets', async () => {
    expect(await store.read()).toEqual({ dir, tickets: [], problems: [] });
    const first = await store.create({ summary: 'First one', type: 'Task', stage: 'todo', description: 'Body text' });
    const second = await store.create({ summary: 'Second one', type: 'Bug', stage: 'todo', description: '' });
    expect([first.key, second.key]).toEqual(['LOC-1', 'LOC-2']);
    expect(first.file).toBe(join(dir, 'LOC-1-first-one.md'));

    const moved = await store.move('LOC-1', 'done');
    expect(moved.stage).toBe('done');
    const text = await readFile(first.file, 'utf8');
    expect(text).toContain('stage: done');
    expect(text.endsWith('\nBody text\n')).toBe(true);
    expect((await store.read()).tickets.map((ticket) => `${ticket.key}:${ticket.stage}`)).toEqual([
      'LOC-1:done',
      'LOC-2:todo',
    ]);
  });

  it('keeps a hand-edited file in its own line endings when it moves', async () => {
    await store.create({ summary: 'seed', type: 'Task', stage: 'todo', description: '' });
    const file = join(dir, 'LOC-5-by-hand.md');
    await writeFile(
      file,
      '---\r\nkey: LOC-5\r\nsummary: By hand\r\nstage: todo\r\n---\r\n\r\nWritten in an editor.\r\n',
    );
    await store.move('LOC-5', 'in-progress');
    const text = await readFile(file, 'utf8');
    expect(text).toContain('stage: in-progress\r\n');
    expect(text.endsWith('\r\n\r\nWritten in an editor.\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('names a file it cannot use, and the second claimant of a key', async () => {
    await store.create({ summary: 'One', type: 'Task', stage: 'todo', description: '' });
    await writeFile(join(dir, 'notes.md'), 'just notes');
    await writeFile(join(dir, 'copy.md'), '---\nkey: LOC-1\nsummary: Copy\n---\n');
    const state = await store.read();
    expect(state.tickets).toHaveLength(1);
    expect(state.problems).toHaveLength(2);
    expect(state.problems).toContain('notes.md: no frontmatter');
    expect(state.problems.some((problem) => problem.includes('already used'))).toBe(true);
  });
});
