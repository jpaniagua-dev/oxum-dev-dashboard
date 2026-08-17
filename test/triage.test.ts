import { WORK_BATCH_LIMIT, type TriagedTicket } from '../src/shared/contracts.js';
import { describe, expect, it } from 'vitest';
import { flattenDocument } from '../src/main/jira/jira-service.js';
import { isEmptyAnswer, parseTriage } from '../src/main/triage/triage-parse.js';
import { DESCRIPTION_LIMIT, buildTriagePrompt, trimDescription } from '../src/main/triage/triage-prompt.js';
import { readProgress, splitLines } from '../src/main/triage/triage-progress.js';
import {
  countVerdicts,
  describeAge,
  describeRun,
  firstFilledVerdict,
  readyKeys,
} from '../src/renderer/ui/triage-panel.js';

const asked = [
  { key: 'PROJ-1', summary: 'Add a column', assignee: 'dev@example.com', status: 'To Do', description: 'Body' },
  { key: 'PROJ-2', summary: 'Fix the header', assignee: '', status: 'To Do', description: '' },
];

describe('parseTriage', () => {
  it('reads a plain JSON array', () => {
    const tickets = parseTriage({
      answer: '[{"key":"PROJ-1","verdict":"ready","reason":"The field exists","question":""},' +
        '{"key":"PROJ-2","verdict":"backend","reason":"No API for it","question":""}]',
      asked,
    });

    expect(tickets.map((ticket) => ticket.verdict)).toEqual(['ready', 'backend']);
    expect(tickets[0]?.reason).toBe('The field exists');
  });

  it('reads an array wrapped in prose or a code fence', () => {
    // Models asked for bare JSON still fence it often enough that refusing those would throw away a
    // perfectly good answer over a formatting habit.
    const tickets = parseTriage({
      answer: 'Here is the triage:\n```json\n[{"key":"PROJ-1","verdict":"ready"}]\n```\nHope that helps.',
      asked: [asked[0]!],
    });

    expect(tickets[0]?.verdict).toBe('ready');
  });

  it('keeps a ticket the analysis forgot, and says so', () => {
    // The one failure nobody would notice: a ticket silently missing from the tab reads exactly like
    // a sprint that does not contain it.
    const tickets = parseTriage({ answer: '[{"key":"PROJ-1","verdict":"ready"}]', asked });

    expect(tickets).toHaveLength(2);
    expect(tickets[1]?.key).toBe('PROJ-2');
    expect(tickets[1]?.verdict).toBe('unclear');
    expect(tickets[1]?.reason).toBe('The analysis did not mention it.');
  });

  it('falls back to unclear on a verdict nobody defined', () => {
    const tickets = parseTriage({ answer: '[{"key":"PROJ-1","verdict":"probably-fine"}]', asked: [asked[0]!] });

    expect(tickets[0]?.verdict).toBe('unclear');
  });

  it('matches keys regardless of case and stray spaces', () => {
    const tickets = parseTriage({ answer: '[{"key":" proj-1 ","verdict":"ready"}]', asked: [asked[0]!] });

    expect(tickets[0]?.verdict).toBe('ready');
  });

  it('keeps every fact from Jira, never from the model', () => {
    // The model is asked to classify, not to restate: letting it rewrite a summary or a description
    // would put text on screen that no longer matches the ticket the overview claims to show.
    const tickets = parseTriage({
      answer: '[{"key":"PROJ-1","verdict":"ready","summary":"Something else","description":"Invented"}]',
      asked: [asked[0]!],
    });

    expect(tickets[0]?.summary).toBe('Add a column');
    expect(tickets[0]?.assignee).toBe('dev@example.com');
    expect(tickets[0]?.status).toBe('To Do');
    expect(tickets[0]?.description).toBe('Body');
  });

  it('carries what answering the question triggers', () => {
    // The half that makes a question worth answering now rather than later.
    const tickets = parseTriage({
      answer:
        '[{"key":"PROJ-1","verdict":"needs-decision","question":"One or two?","next":"A front-end change either way"}]',
      asked: [asked[0]!],
    });

    expect(tickets[0]?.question).toBe('One or two?');
    expect(tickets[0]?.next).toBe('A front-end change either way');
  });

  it('survives an answer with no array at all', () => {
    expect(parseTriage({ answer: 'I could not do that.', asked })).toHaveLength(2);
    expect(isEmptyAnswer('I could not do that.')).toBe(true);
    expect(isEmptyAnswer('[{"key":"PROJ-1"}]')).toBe(false);
  });
});

describe('buildTriagePrompt', () => {
  it('names every ticket asked about', () => {
    const prompt = buildTriagePrompt('Sprint 7', [
      { key: 'PROJ-1', summary: 'Add a column', status: 'To Do', assignee: '', description: 'Body' },
    ]);

    expect(prompt).toContain('PROJ-1');
    expect(prompt).toContain('Sprint 7');
    expect(prompt).toContain('unassigned');
  });

  it('announces a truncated description instead of cutting it silently', () => {
    // A model reading an extract as a whole ticket concludes the specification is thin, which is a
    // verdict about our prompt rather than about the ticket.
    const trimmed = trimDescription('x'.repeat(DESCRIPTION_LIMIT + 50));

    expect(trimmed).toContain('[description truncated]');
    expect(trimDescription('short')).toBe('short');
  });
});

describe('flattenDocument', () => {
  it('reads the text out of an Atlassian document', () => {
    const document = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] },
      ],
    };

    expect(flattenDocument(document)).toBe('First line\nSecond line\n');
  });

  it('treats a missing description as empty rather than as a failure', () => {
    // Plenty of real tickets have none, and it is not an error worth surfacing.
    expect(flattenDocument(null)).toBe('');
    expect(flattenDocument(undefined)).toBe('');
  });
});

/** A triaged ticket with only its verdict set, for the counting and ordering tests. */
const ticketWith = (verdict: TriagedTicket['verdict']): TriagedTicket => ({
  key: 'PROJ-1',
  summary: '',
  verdict,
  reason: '',
  question: '',
  next: '',
  assignee: '',
  status: '',
  description: '',
});

describe('countVerdicts', () => {
  it('counts every verdict, including the ones at zero', () => {
    const counts = countVerdicts([
      ticketWith('ready'),
      ticketWith('ready'),
      ticketWith('backend'),
    ]);

    expect(counts.ready).toBe(2);
    expect(counts.backend).toBe(1);
    expect(counts.blocked).toBe(0);
  });
});

describe('readyKeys', () => {
  const keyed = (key: string, verdict: TriagedTicket['verdict']): TriagedTicket => ({
    ...ticketWith(verdict),
    key,
  });

  it('takes the ready tickets and nothing else', () => {
    // The batch button starts work unattended, so a ticket the analysis parked on a question must
    // never end up in it: answering that question is what decides what gets built.
    expect(
      readyKeys([
        keyed('PROJ-1', 'ready'),
        keyed('PROJ-2', 'needs-decision'),
        keyed('PROJ-3', 'ready'),
        keyed('PROJ-4', 'backend'),
      ]),
    ).toEqual(['PROJ-1', 'PROJ-3']);
  });

  it('keeps the list order, so the first started is the first read', () => {
    expect(readyKeys([keyed('PROJ-9', 'ready'), keyed('PROJ-2', 'ready')])).toEqual([
      'PROJ-9',
      'PROJ-2',
    ]);
  });

  it('caps at the same limit the main process applies', () => {
    // Both ends cap. If only the main process did, the button would promise more than it starts and
    // drop the tail without saying so.
    const many = Array.from({ length: WORK_BATCH_LIMIT + 3 }, (_unused, index) =>
      keyed(`PROJ-${index}`, 'ready'),
    );

    expect(readyKeys(many)).toHaveLength(WORK_BATCH_LIMIT);
  });

  it('returns nothing when no ticket is ready, so the button never appears', () => {
    expect(readyKeys([keyed('PROJ-1', 'blocked')])).toEqual([]);
  });
});

describe('firstFilledVerdict', () => {
  const ticket = (verdict: TriagedTicket['verdict']): TriagedTicket => ({
    key: 'PROJ-1',
    summary: '',
    verdict,
    reason: '',
    question: '',
    next: '',
    assignee: '',
    status: '',
    description: '',
  });

  it('lands on what can be built before what is waiting on you', () => {
    // The sub-tab order is the order of what the reader can act on, and the default follows it.
    expect(firstFilledVerdict([ticket('blocked'), ticket('ready')])).toBe('ready');
    expect(firstFilledVerdict([ticket('backend'), ticket('needs-decision')])).toBe('needs-decision');
  });

  it('skips the empty verdicts', () => {
    // Landing on an empty tab would make a finished analysis look like it found nothing.
    expect(firstFilledVerdict([ticket('unclear')])).toBe('unclear');
  });

  it('falls back to ready when there is nothing at all', () => {
    expect(firstFilledVerdict([])).toBe('ready');
  });
});

describe('readProgress', () => {
  it('names the file a tool call is opening, not the tool', () => {
    // "Reading schema.graphql" says why the run is taking its time; "Read" says nothing.
    const step = readProgress({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'C:/repo/src/schema.graphql' } }],
      },
    });

    expect(step).toEqual({ phase: 'reading', detail: 'Reading schema.graphql', counts: true });
  });

  it('names a search by its pattern', () => {
    const step = readProgress({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'FilterInput' } }] },
    });

    expect(step?.detail).toBe('Searching FilterInput');
  });

  it('treats the first prose as the answering phase', () => {
    // The model only writes once it has finished looking, and that stretch is where a silent screen
    // looks broken while it is in fact producing the verdicts.
    const step = readProgress({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '[{"key":"PROJ-1"' }] },
    });

    expect(step).toEqual({ phase: 'answering', detail: 'Writing the verdicts', counts: false });
  });

  it('ignores the hook chatter around a session', () => {
    // Those events describe the dashboard's own hooks, not the sprint.
    expect(readProgress({ type: 'system', subtype: 'hook_started' })).toBeNull();
    expect(readProgress({ type: 'system', subtype: 'init' })?.phase).toBe('starting');
  });

  it('survives anything that is not an event', () => {
    expect(readProgress(null)).toBeNull();
    expect(readProgress('nonsense')).toBeNull();
    expect(readProgress({ type: 'assistant' })).toBeNull();
  });
});

describe('splitLines', () => {
  it('keeps a half-received object for the next chunk', () => {
    // A pipe cuts wherever its buffer ended, so an event routinely arrives in two pieces. Parsing
    // per chunk would drop exactly those, and the run would look frozen while it was working.
    const first = splitLines('{"a":1}\n{"b":2}\n{"c":');
    expect(first.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(first.rest).toBe('{"c":');

    const second = splitLines(`${first.rest}3}\n`);
    expect(second.lines).toEqual(['{"c":3}']);
    expect(second.rest).toBe('');
  });
});

describe('describeRun', () => {
  const startedAt = '2026-08-16T12:00:00Z';

  it('counts the seconds, because the reader is watching a clock', () => {
    const progress = { sprintId: 1, phase: 'reading' as const, detail: '', steps: 4, startedAt, tickets: 20 };

    expect(describeRun(progress, new Date('2026-08-16T12:01:07Z'))).toBe('20 tickets, 4 steps, 1:07');
  });

  it('leaves out what it does not know yet', () => {
    const progress = { sprintId: 1, phase: 'fetching' as const, detail: '', steps: 0, startedAt, tickets: 0 };

    expect(describeRun(progress, new Date('2026-08-16T12:00:03Z'))).toBe('0:03');
  });
});

describe('describeAge', () => {
  const now = new Date('2026-08-16T12:00:00Z');

  it('answers in words, because the question is whether the analysis is still worth trusting', () => {
    expect(describeAge('2026-08-16T11:58:00Z', now)).toBe('Analysed 2 min ago');
    expect(describeAge('2026-08-16T09:00:00Z', now)).toBe('Analysed 3 h ago');
    expect(describeAge('2026-08-14T12:00:00Z', now)).toBe('Analysed 2 d ago');
  });

  it('says so when there is nothing to date', () => {
    expect(describeAge('', now)).toBe('Never analysed');
    expect(describeAge('not a date', now)).toBe('Never analysed');
  });
});
