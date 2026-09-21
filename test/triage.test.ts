import {
  AUTONOMY_MAX_POINTS,
  DESCRIPTION_TRUNCATED_MARK,
  RESERVED_ACTION_PREFIX,
  WORK_BATCH_LIMIT,
  workActionId,
  type TriagedTicket,
} from '../src/shared/contracts.js';
import { autonomyBlock, canRunUnattended } from '../src/shared/triage-autonomy.js';
import { readResult } from '../src/main/triage/triage-store.js';
import { describe, expect, it } from 'vitest';
import { flattenDocument } from '../src/main/jira/jira-service.js';
import { isEmptyAnswer, parseTriage } from '../src/main/triage/triage-parse.js';
import { DESCRIPTION_LIMIT, buildTriagePrompt, trimDescription } from '../src/main/triage/triage-prompt.js';
import { readProgress, splitLines } from '../src/main/agent/agent-progress.js';
import { selectIssues } from '../src/main/triage/triage-select.js';
import {
  autonomousKeys,
  countVerdicts,
  describeAge,
  describeAutonomousRun,
  describeCoverage,
  describeEmptyResult,
  describeRun,
  describeTicketAge,
  describeWork,
  firstFilledVerdict,
  readyKeys,
} from '../src/renderer/ui/triage-panel.js';

/** One fixed instant, so a stamped verdict can be asserted rather than approximated. */
const RUN_AT = '2026-09-18T08:00:00.000Z';

const asked = [
  { key: 'PROJ-1', summary: 'Add a column', assignee: 'dev@example.com', status: 'To Do', description: 'Body' },
  { key: 'PROJ-2', summary: 'Fix the header', assignee: '', status: 'To Do', description: '' },
];

describe('parseTriage: the estimate', () => {
  const one = (extra: string): TriagedTicket | undefined =>
    parseTriage({
      answer: `[{"key":"PROJ-1","verdict":"ready","reason":"ok"${extra}}]`,
      asked: [asked[0] as (typeof asked)[number]],
      analysedAt: RUN_AT,
    })[0];

  it('keeps a value the scale carries', () => {
    expect(one(',"estimate":5')?.estimate).toBe(5);
  });

  it('snaps a value off the scale, since the number is written to a ticket', () => {
    // A model handed a numeric field answers 4 or 6 often enough, and the board is planned in Fibonacci.
    expect(one(',"estimate":6')?.estimate).toBe(5);
  });

  it('refuses a missing or unusable estimate rather than defaulting to one', () => {
    // An invented estimate is a number a human plans against. A blank field at least reads as a question
    // nobody answered, and the prompt tells the model to answer 0 when there is nothing to size.
    expect(one('')?.estimate).toBeNull();
    expect(one(',"estimate":0')?.estimate).toBeNull();
    expect(one(',"estimate":"soon"')?.estimate).toBeNull();
  });

  it('leaves a forgotten ticket without an estimate, as it leaves it unclear', () => {
    // Same rule as the verdict: a ticket the analysis skipped must not come back carrying values nobody
    // produced for it.
    const tickets = parseTriage({ answer: '[{"key":"PROJ-1","verdict":"ready","estimate":3}]', asked, analysedAt: RUN_AT });
    expect(tickets[1]?.verdict).toBe('unclear');
    expect(tickets[1]?.estimate).toBeNull();
  });
});

describe('describeWork', () => {
  it('announces the four Jira writes, which happen out of sight', () => {
    const sentence = describeWork(['PROJ-1'], 3);
    expect(sentence).toContain('PROJ-1');
    expect(sentence).toContain('active sprint');
    expect(sentence).toContain('assigns it to you');
    expect(sentence).toContain('3 story points');
    expect(sentence).toContain('starts progress');
  });

  it('states a missing estimate rather than staying silent about it', () => {
    // An unmentioned omission reads as a promise: the tooltip has to say the field will not be written.
    expect(describeWork(['PROJ-1'], null)).toContain('no story points');
  });

  it('does not quote one number for a batch of tickets', () => {
    // Several tickets carry several estimates, and naming one would be right for at most one of them.
    const sentence = describeWork(['PROJ-1', 'PROJ-2'], null);
    expect(sentence).toContain('2 tickets');
    expect(sentence).toContain('the story points the analysis gave each');
    expect(sentence).not.toContain('no story points');
  });
});

describe('parseTriage', () => {
  it('reads a plain JSON array', () => {
    const tickets = parseTriage({
      answer: '[{"key":"PROJ-1","verdict":"ready","domain":"front-end","reason":"The field exists","question":""},' +
        '{"key":"PROJ-2","verdict":"blocked","domain":"backend","reason":"No API for it","question":""}]',
      asked,
      analysedAt: RUN_AT,
      });

    expect(tickets.map((ticket) => ticket.verdict)).toEqual(['ready', 'blocked']);
    expect(tickets.map((ticket) => ticket.domain)).toEqual(['front-end', 'backend']);
    expect(tickets[0]?.reason).toBe('The field exists');
  });

  it('reads an array wrapped in prose or a code fence', () => {
    // Models asked for bare JSON still fence it often enough that refusing those would throw away a
    // perfectly good answer over a formatting habit.
    const tickets = parseTriage({
      answer: 'Here is the triage:\n```json\n[{"key":"PROJ-1","verdict":"ready"}]\n```\nHope that helps.',
      asked: [asked[0]!],
      analysedAt: RUN_AT,
      });

    expect(tickets[0]?.verdict).toBe('ready');
  });

  it('keeps a ticket the analysis forgot, and says so', () => {
    // The one failure nobody would notice: a ticket silently missing from the tab reads exactly like
    // a sprint that does not contain it.
    const tickets = parseTriage({ answer: '[{"key":"PROJ-1","verdict":"ready"}]', asked, analysedAt: RUN_AT });

    expect(tickets).toHaveLength(2);
    expect(tickets[1]?.key).toBe('PROJ-2');
    expect(tickets[1]?.verdict).toBe('unclear');
    expect(tickets[1]?.reason).toBe('The analysis did not mention it.');
  });

  it('falls back to unclear on a verdict nobody defined', () => {
    const tickets = parseTriage({ answer: '[{"key":"PROJ-1","verdict":"probably-fine"}]', asked: [asked[0]!], analysedAt: RUN_AT });

    expect(tickets[0]?.verdict).toBe('unclear');
  });

  it('matches keys regardless of case and stray spaces', () => {
    const tickets = parseTriage({ answer: '[{"key":" proj-1 ","verdict":"ready"}]', asked: [asked[0]!], analysedAt: RUN_AT });

    expect(tickets[0]?.verdict).toBe('ready');
  });

  it('keeps every fact from Jira, never from the model', () => {
    // The model is asked to classify, not to restate: letting it rewrite a summary or a description
    // would put text on screen that no longer matches the ticket the overview claims to show.
    const tickets = parseTriage({
      answer: '[{"key":"PROJ-1","verdict":"ready","summary":"Something else","description":"Invented"}]',
      asked: [asked[0]!],
      analysedAt: RUN_AT,
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
      analysedAt: RUN_AT,
      });

    expect(tickets[0]?.question).toBe('One or two?');
    expect(tickets[0]?.next).toBe('A front-end change either way');
  });

  it('survives an answer with no array at all', () => {
    expect(parseTriage({ answer: 'I could not do that.', asked, analysedAt: RUN_AT })).toHaveLength(2);
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

    expect(trimmed).toContain(DESCRIPTION_TRUNCATED_MARK);
    expect(trimDescription('short')).toBe('short');
  });

  it('names the four verdicts and not the one that became a domain', () => {
    const prompt = buildTriagePrompt('Sprint 7', []);

    expect(prompt).toContain('"needs-decision"');
    expect(prompt).toContain('"full-stack"');
    expect(prompt).not.toContain('- "backend": the front-end cannot do it');
  });

  it('states the point cap the app enforces', () => {
    // The test that stops the prompt and the guardrail from drifting apart, which is the failure mode
    // of the whole hybrid: the model has to be judged by the rule it was given.
    expect(buildTriagePrompt('Sprint 7', [])).toContain(
      `${AUTONOMY_MAX_POINTS} story points or fewer`,
    );
  });

  it('answers its own example', () => {
    // The example line IS the contract with the model. Feeding it back through the parser pins the two
    // together for good, including the shape an older answer still parses into.
    const prompt = buildTriagePrompt('Sprint 7', []);
    const line = prompt.split('\n').find((text) => text.startsWith('[{"key":"PROJ-123"'));
    const tickets = parseTriage({
      answer: (line ?? '').replace('PROJ-123', 'PROJ-1'),
      asked: [asked[0]!],
      analysedAt: RUN_AT,
    });

    expect(tickets[0]?.verdict).toBe('ready');
    expect(tickets[0]?.domain).toBe('front-end');
    expect(tickets[0]?.claimsAutonomy).toBe(true);
    expect(tickets[0]?.estimate).toBe(3);
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

/**
 * A triaged ticket with only its verdict set, for the counting, ordering and guardrail tests.
 *
 * One builder and not two. There used to be a second copy inside the `firstFilledVerdict` block, and
 * the duplicate is exactly how one of them ends up missing a field the day the type grows one.
 */
const ticketWith = (
  verdict: TriagedTicket['verdict'],
  overrides: Partial<TriagedTicket> = {},
): TriagedTicket => ({
  key: 'PROJ-1',
  summary: '',
  verdict,
  domain: 'unknown',
  claimsAutonomy: false,
  reason: '',
  question: '',
  next: '',
  estimate: null,
  assignee: '',
  status: '',
  description: '',
  analysedAt: RUN_AT,
  ...overrides,
});

/** A ticket every guardrail clears, so each test below can spoil exactly one thing. */
const autonomous = (overrides: Partial<TriagedTicket> = {}): TriagedTicket =>
  ticketWith('ready', { domain: 'front-end', claimsAutonomy: true, estimate: 1, ...overrides });

describe('countVerdicts', () => {
  it('counts every verdict, including the ones at zero', () => {
    const counts = countVerdicts([
      ticketWith('ready'),
      ticketWith('ready'),
      ticketWith('blocked'),
    ]);

    expect(counts.ready).toBe(2);
    expect(counts.blocked).toBe(1);
    expect(counts.unclear).toBe(0);
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
        keyed('PROJ-4', 'blocked'),
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
  const ticket = (verdict: TriagedTicket['verdict']): TriagedTicket => ticketWith(verdict);

  it('lands on what can be built before what is waiting on you', () => {
    // The sub-tab order is the order of what the reader can act on, and the default follows it.
    expect(firstFilledVerdict([ticket('blocked'), ticket('ready')])).toBe('ready');
    expect(firstFilledVerdict([ticket('unclear'), ticket('needs-decision')])).toBe('needs-decision');
  });

  it('skips the empty verdicts', () => {
    // Landing on an empty tab would make a finished analysis look like it found nothing.
    expect(firstFilledVerdict([ticket('unclear')])).toBe('unclear');
  });

  it('falls back to ready when there is nothing at all', () => {
    expect(firstFilledVerdict([])).toBe('ready');
  });
});

describe('toDomain, through parseTriage', () => {
  const domainOf = (raw: string): string => {
    const tickets = parseTriage({
      answer: `[{"key":"PROJ-1","verdict":"ready","domain":${raw}}]`,
      asked: [asked[0]!],
      analysedAt: RUN_AT,
    });
    return tickets[0]!.domain;
  };

  it('folds the spellings a model actually writes', () => {
    // Not pedantry: an unknown domain cancels the 100% agent flag, so a missing hyphen would kill a
    // run in silence.
    expect(domainOf('"frontend"')).toBe('front-end');
    expect(domainOf('"Front End"')).toBe('front-end');
    expect(domainOf('"front_end"')).toBe('front-end');
    expect(domainOf('"fullstack"')).toBe('full-stack');
    expect(domainOf('"server"')).toBe('backend');
  });

  it('falls back to unknown on a domain nobody defined', () => {
    expect(domainOf('"middleware"')).toBe('unknown');
    expect(domainOf('7')).toBe('unknown');
  });

  it('reads an absent domain as unknown, never as front-end', () => {
    // The default side used to be the only side. Defaulting here would make every answer written by
    // an older version claim a stack nobody judged.
    const tickets = parseTriage({
      answer: '[{"key":"PROJ-1","verdict":"ready"}]',
      asked: [asked[0]!],
      analysedAt: RUN_AT,
    });

    expect(tickets[0]?.domain).toBe('unknown');
  });
});

describe('toAutonomous, through parseTriage', () => {
  const claimOf = (raw: string): boolean => {
    const tickets = parseTriage({
      answer: `[{"key":"PROJ-1","verdict":"ready","autonomous":${raw}}]`,
      asked: [asked[0]!],
      analysedAt: RUN_AT,
    });
    return tickets[0]!.claimsAutonomy;
  };

  it('takes a real boolean and the spellings a model quotes', () => {
    expect(claimOf('true')).toBe(true);
    expect(claimOf('"true"')).toBe(true);
    expect(claimOf('"Yes"')).toBe(true);
  });

  it('reads everything else as false, false being the safe direction', () => {
    // This is the one field that removes the human, so nothing is inferred from a value that could
    // have meant something else.
    expect(claimOf('false')).toBe(false);
    expect(claimOf('1')).toBe(false);
    expect(claimOf('"probably"')).toBe(false);
    expect(claimOf('null')).toBe(false);
  });

  it('reads an absent claim as false', () => {
    const tickets = parseTriage({
      answer: '[{"key":"PROJ-1","verdict":"ready"}]',
      asked: [asked[0]!],
      analysedAt: RUN_AT,
    });

    expect(tickets[0]?.claimsAutonomy).toBe(false);
  });
});

describe('canRunUnattended', () => {
  it('clears a ready, sized, whole ticket the analysis vouched for', () => {
    expect(canRunUnattended(autonomous())).toBe(true);
    expect(autonomyBlock(autonomous())).toBeNull();
  });

  it('refuses what the analysis did not claim', () => {
    expect(autonomyBlock(autonomous({ claimsAutonomy: false }))).toBe('not-claimed');
  });

  it('refuses anything that is not ready', () => {
    // The rule readyKeys already records: a batch of parked tickets asks an agent to decide for you,
    // and an unattended run is that batch with the human removed.
    expect(autonomyBlock({ ...autonomous(), verdict: 'needs-decision' })).toBe('not-ready');
  });

  it('refuses an unknown domain, the run differing by side', () => {
    expect(autonomyBlock(autonomous({ domain: 'unknown' }))).toBe('unknown-domain');
  });

  it('refuses a ticket with no estimate', () => {
    expect(autonomyBlock(autonomous({ estimate: null }))).toBe('no-estimate');
  });

  it('refuses one above the cap and accepts one exactly at it', () => {
    expect(autonomyBlock(autonomous({ estimate: AUTONOMY_MAX_POINTS }))).toBeNull();
    expect(autonomyBlock(autonomous({ estimate: 5 }))).toBe('too-large');
  });

  it('refuses a ticket whose description was cut short for the prompt', () => {
    // The only guardrail about our own prompt, and the only one the model could not apply to itself:
    // it sees the marker but not what is behind it, and a story tail is where the criteria live.
    const cut = autonomous({ description: `Body\n${DESCRIPTION_TRUNCATED_MARK}` });

    expect(autonomyBlock(cut)).toBe('truncated');
  });

  it('names the first rule that stopped it, in the order the reader is told about', () => {
    // Everything wrong at once still answers the claim, because that is the first thing said.
    expect(autonomyBlock(ticketWith('blocked', { claimsAutonomy: false, estimate: 21 }))).toBe(
      'not-claimed',
    );
  });
});

describe('autonomousKeys', () => {
  it('is a subset of the ready keys, in list order', () => {
    const tickets = [
      autonomous({ key: 'PROJ-1' }),
      ticketWith('ready', { key: 'PROJ-2' }),
      autonomous({ key: 'PROJ-3' }),
    ];

    expect(autonomousKeys(tickets)).toEqual(['PROJ-1', 'PROJ-3']);
    expect(readyKeys(tickets)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
  });

  it('caps at the same limit the main process applies', () => {
    const many = Array.from({ length: WORK_BATCH_LIMIT + 3 }, (_unused, index) =>
      autonomous({ key: `PROJ-${index}` }),
    );

    expect(autonomousKeys(many)).toHaveLength(WORK_BATCH_LIMIT);
  });

  it('returns nothing when no ticket clears, so the button never appears', () => {
    expect(autonomousKeys([ticketWith('ready')])).toEqual([]);
  });
});

describe('describeAutonomousRun', () => {
  it('names the count, the overlap and the review that still happens', () => {
    const sentence = describeAutonomousRun(['PROJ-1', 'PROJ-2']);

    expect(sentence).toContain('2 tickets');
    expect(sentence).toContain('ready button');
    expect(sentence).toContain('reviewer');
  });
});

describe('readResult', () => {
  const stored = (ticket: Record<string, unknown>): unknown => ({
    sprintId: 7,
    sprintName: 'Sprint 7',
    analysedAt: RUN_AT,
    tickets: [ticket],
    skipped: { inProgress: 0, alreadyAnalysed: 0 },
  });

  it('turns a stored backend verdict into unclear, the verdict nobody defines', () => {
    // The whole migration of the split, and it invents nothing: the reason survives, which is where
    // the information actually was, and no run ever judged that row ready or blocked.
    const result = readResult(stored({ key: 'PROJ-1', verdict: 'backend', reason: 'No API for it' }));

    expect(result?.tickets[0]?.verdict).toBe('unclear');
    expect(result?.tickets[0]?.reason).toBe('No API for it');
  });

  it('normalises a hand-edited verdict rather than letting it reach an exhaustive lookup', () => {
    expect(readResult(stored({ key: 'PROJ-1', verdict: 'whatever' }))?.tickets[0]?.verdict).toBe(
      'unclear',
    );
  });

  it('reads a file written before the domain existed as unknown and unclaimed', () => {
    const ticket = readResult(stored({ key: 'PROJ-1', verdict: 'ready' }))?.tickets[0];

    expect(ticket?.domain).toBe('unknown');
    expect(ticket?.claimsAutonomy).toBe(false);
  });

  it('round-trips the claim under the name the store writes, not the one the model answers', () => {
    const ticket = readResult(
      stored({ key: 'PROJ-1', verdict: 'ready', domain: 'backend', claimsAutonomy: true }),
    )?.tickets[0];

    expect(ticket?.domain).toBe('backend');
    expect(ticket?.claimsAutonomy).toBe(true);
  });

  it('drops a row with no key, and keeps one with no verdict', () => {
    // A row losing its verdict used to vanish, which is the failure nobody notices; only a row that
    // cannot be worked, dismissed or refreshed still goes.
    expect(readResult(stored({ verdict: 'ready' }))?.tickets).toHaveLength(0);
    expect(readResult(stored({ key: 'PROJ-1' }))?.tickets[0]?.verdict).toBe('unclear');
  });

  it('snaps a stored estimate back onto the scale', () => {
    const ticket = readResult(stored({ key: 'PROJ-1', verdict: 'ready', estimate: 4 }))?.tickets[0];

    expect(ticket?.estimate).toBe(5);
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

/**
 * Which tab a handoff lands in.
 *
 * Invisible until it is wrong, and it was wrong in the worse of the two directions: every handoff
 * shared one id, so `runProjectCommand` found the previous session still running and handed its tab
 * back. The second ticket's prompt never ran and the only symptom was a session ignoring you.
 */
describe('workActionId', () => {
  it('gives two different tickets two different tabs', () => {
    expect(workActionId(['PROJ-1'])).not.toBe(workActionId(['PROJ-2']));
  });

  it('sends the same ticket back to the tab already working it', () => {
    // Not unique-per-click on purpose: two agents on one worktree is worse than being blocked.
    expect(workActionId(['PROJ-1'])).toBe(workActionId(['PROJ-1']));
  });

  it('reads a batch as a set, so the order it was clicked in does not open a second tab', () => {
    expect(workActionId(['PROJ-2', 'PROJ-1'])).toBe(workActionId(['PROJ-1', 'PROJ-2']));
  });

  it('keeps the reserved prefix, which is what exempts the tab from reconciliation', () => {
    // `isUnreachable` tests it with `startsWith`: lose it and a settings save closes a running agent.
    expect(workActionId(['PROJ-1']).startsWith(RESERVED_ACTION_PREFIX)).toBe(true);
  });
});

/*
 * What a run is given, and what it is not.
 *
 * The one filter in the app whose mistakes are invisible: dropping too much produces a short list,
 * and a short list is indistinguishable from a short sprint. Hence a pure function with its counts
 * coming back beside the selection, and hence these tests.
 */
describe('selectIssues', () => {
  const issue = (
    key: string,
    stage: 'todo' | 'in-progress' | 'done',
    accountId: string,
  ): Parameters<typeof selectIssues>[0][number] => ({
    key,
    summary: `Summary of ${key}`,
    status: stage === 'in-progress' ? 'In review' : 'To Do',
    stage,
    assignee: accountId.length > 0 ? 'Someone' : '',
    accountId,
    description: 'Body',
  });

  const sprint = [
    issue('PROJ-1', 'todo', 'me'),
    issue('PROJ-2', 'in-progress', 'me'),
    issue('PROJ-3', 'todo', 'someone-else'),
    issue('PROJ-4', 'todo', ''),
  ];

  it('skips what is in progress, and counts it', () => {
    const { analysed, skipped } = selectIssues(sprint);

    expect(analysed.map((entry) => entry.key)).toEqual(['PROJ-1', 'PROJ-3', 'PROJ-4']);
    expect(skipped).toEqual({ inProgress: 1, alreadyAnalysed: 0 });
  });

  it('reads the stage and not the status name, which is per-project and renamed at will', () => {
    // "In review" is in progress on this board; a filter matching the words "in progress" would send
    // it to the model, and would send nothing at all on a board whose statuses are in French.
    const [skippedIssue] = selectIssues([issue('PROJ-9', 'in-progress', 'me')]).analysed;
    expect(skippedIssue).toBeUndefined();
  });

  it('keeps every ticket that is not in progress, whoever holds it', () => {
    // The `mine` scope was removed in 5.8.1: an assignee no longer decides what a run reads, and an
    // unassigned ticket is analysed like any other.
    const { analysed } = selectIssues([
      issue('PROJ-3', 'todo', 'someone-else'),
      issue('PROJ-4', 'todo', ''),
    ]);
    expect(analysed.map((entry) => entry.key)).toEqual(['PROJ-3', 'PROJ-4']);
  });

  it('leaves `done` alone, the sprint search having already excluded it', () => {
    // Two authorities on the same exclusion is how the two would drift.
    const { analysed } = selectIssues([issue('PROJ-8', 'done', 'me')]);
    expect(analysed.map((entry) => entry.key)).toEqual(['PROJ-8']);
  });

  it('skips what a stored verdict already covers, and counts it', () => {
    // The whole point of the second button: three tickets dropped into a running sprint cost a run of
    // three, not of twelve.
    const { analysed, skipped } = selectIssues(sprint, new Set(['PROJ-1']));

    expect(analysed.map((entry) => entry.key)).toEqual(['PROJ-3', 'PROJ-4']);
    expect(skipped).toEqual({ inProgress: 1, alreadyAnalysed: 1 });
  });

  it('matches a stored key whatever its case, the file being hand-editable', () => {
    const { skipped } = selectIssues([issue('proj-1', 'todo', 'me')], new Set(['PROJ-1']));
    expect(skipped.alreadyAnalysed).toBe(1);
  });

  it('counts a ticket that is both under in progress alone', () => {
    // The order between the two rules is the contract: counting it twice would put more skipped
    // tickets on screen than the sprint holds, and counting it under the second would make the two
    // modes report different `inProgress` numbers for the same sprint.
    const { skipped } = selectIssues([issue('PROJ-2', 'in-progress', 'me')], new Set(['PROJ-2']));
    expect(skipped).toEqual({ inProgress: 1, alreadyAnalysed: 0 });
  });

  it('is given everything when no key is passed, which is what a full run is', () => {
    const { analysed, skipped } = selectIssues(sprint, new Set());
    expect(analysed).toHaveLength(3);
    expect(skipped.alreadyAnalysed).toBe(0);
  });
});

describe('describeCoverage', () => {
  it('says nothing when the run left nothing out', () => {
    // A line reading "0 skipped" is a line the eye has to read every time to learn nothing.
    expect(describeCoverage({ inProgress: 0, alreadyAnalysed: 0 })).toBe('');
  });

  it('counts what was skipped', () => {
    expect(describeCoverage({ inProgress: 2, alreadyAnalysed: 0 })).toContain('2 in progress skipped');
  });

  it('says how much of the list an earlier run produced', () => {
    // Without it, an incremental run reads as a full one: same list, same age line, and nothing
    // saying that nine of those verdicts are a week old.
    expect(describeCoverage({ inProgress: 0, alreadyAnalysed: 9 })).toContain(
      '9 kept from an earlier run',
    );
  });

  it('states both, an incremental run having two reasons to be short', () => {
    const line = describeCoverage({ inProgress: 2, alreadyAnalysed: 9 });
    expect(line).toContain('2 in progress skipped');
    expect(line).toContain('9 kept from an earlier run');
  });
});

/*
 * The age of one verdict inside a list that no longer has a single one.
 *
 * It exists because an incremental run merges: the bar says when the sprint was last read, which
 * after a merge is not when most of its rows were concluded.
 */
describe('describeTicketAge', () => {
  const now = new Date('2026-09-18T12:00:00Z');
  const at = (analysedAt: string): TriagedTicket => ({ ...ticketWith('ready'), analysedAt });

  it('says nothing when the row is as old as the result, which is every full run', () => {
    expect(describeTicketAge(at('2026-09-18T10:00:00Z'), '2026-09-18T10:00:00Z', now)).toBe('');
  });

  it('dates a row an earlier run produced', () => {
    expect(describeTicketAge(at('2026-09-16T12:00:00Z'), '2026-09-18T12:00:00Z', now)).toBe(
      'analysed 2 d ago',
    );
  });

  it('says nothing for a row stored before the stamp existed', () => {
    // Dating it from the result is the exact claim the stamp exists to stop.
    expect(describeTicketAge(at(''), '2026-09-18T12:00:00Z', now)).toBe('');
  });
});

describe('describeEmptyResult', () => {
  it('says a sprint is empty when it really is', () => {
    expect(describeEmptyResult({ inProgress: 0, alreadyAnalysed: 0 })).toBe('No ticket in this sprint.');
  });

  it('says a sprint was filtered down to nothing, which looks identical on screen', () => {
    const message = describeEmptyResult({ inProgress: 9, alreadyAnalysed: 0 });
    expect(message).toContain('9 already in progress');
    expect(message).not.toContain('No ticket in this sprint');
  });
});
