import { describe, expect, it } from 'vitest';
import { buildJql, parseIssues, parseTransitions } from '../src/main/jira/jira-service.js';
import {
  ASSIGNEE_NONE,
  assigneesOf,
  boardColumns,
  boardUrl,
  filterByAssignee,
  presentStage,
  transitionTo,
} from '../src/renderer/ui/jira-board.js';
import {
  ISSUE_KEY_PATTERN,
  type IssueStage,
  type IssueTransition,
  type JiraIssue,
} from '../src/shared/contracts.js';

const SITE = 'https://example.atlassian.net';
const ME = 'dev@example.com';

/** Shape of a Jira Cloud search response, reduced to the fields the list reads. */
const BODY = {
  issues: [
    {
      key: 'PROJ-1674',
      fields: {
        summary: 'User profile detail page',
        status: { name: 'In progress', statusCategory: { key: 'indeterminate' } },
        assignee: { displayName: 'Julio P.', emailAddress: 'dev@example.com' },
        issuetype: { name: 'Story' },
        updated: '2026-08-04T15:00:00.000+0200',
      },
    },
    {
      key: 'PROJ-1651',
      fields: {
        summary: 'Invoice list filters',
        status: { name: 'To do', statusCategory: { key: 'new' } },
        assignee: null,
        issuetype: { name: 'Task' },
        updated: '2026-08-01T09:00:00.000+0200',
      },
    },
  ],
};

describe('parseIssues', () => {
  it('reads keys, summaries and statuses', () => {
    const issues = parseIssues(BODY, SITE, ME);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      key: 'PROJ-1674',
      summary: 'User profile detail page',
      status: 'In progress',
      stage: 'in-progress',
      type: 'Story',
      assignee: 'Julio P.',
      isMine: true,
      url: 'https://example.atlassian.net/browse/PROJ-1674',
    });
  });

  it('derives the stage from the status category, not the status name', () => {
    // Status names are per-project and renamed at will; only the category is stable across boards.
    expect(parseIssues(BODY, SITE, ME)[1]?.stage).toBe('todo');
    const custom = {
      issues: [
        { key: 'X-1', fields: { status: { name: 'Ready for QA', statusCategory: { key: 'indeterminate' } } } },
      ],
    };
    expect(parseIssues(custom, SITE, ME)[0]?.stage).toBe('in-progress');
  });

  it('handles an unassigned issue', () => {
    const issue = parseIssues(BODY, SITE, ME)[1];
    expect(issue?.assignee).toBe('');
    expect(issue?.isMine).toBe(false);
  });

  it('compares the assignee email case-insensitively', () => {
    const body = {
      issues: [{ key: 'X-2', fields: { assignee: { emailAddress: 'Dev@Example.com' } } }],
    };
    expect(parseIssues(body, SITE, ME)[0]?.isMine).toBe(true);
  });

  it('claims nothing when the account email is unknown', () => {
    const body = { issues: [{ key: 'X-3', fields: { assignee: { emailAddress: '' } } }] };
    expect(parseIssues(body, SITE, '')[0]?.isMine).toBe(false);
  });

  it('survives a response that is not a search result', () => {
    expect(parseIssues(null, SITE, ME)).toEqual([]);
    expect(parseIssues({}, SITE, ME)).toEqual([]);
    expect(parseIssues({ issues: 'nope' }, SITE, ME)).toEqual([]);
    expect(parseIssues({ issues: [{ fields: {} }] }, SITE, ME)).toEqual([]);
  });

  it('does not double the slash in an issue URL', () => {
    expect(parseIssues({ issues: [{ key: 'A-1' }] }, `${SITE}/`, ME)[0]?.url).toBe(
      'https://example.atlassian.net/browse/A-1',
    );
  });
});

describe('buildJql', () => {
  it('scopes both searches to the configured projects', () => {
    const jql = buildJql(['PROJ', 'WEB']);
    expect(jql.sprint).toContain('project in ("PROJ", "WEB")');
    expect(jql.mine).toContain('project in ("PROJ", "WEB")');
  });

  it('asks Jira itself which sprint is current', () => {
    // `openSprints()` is what avoids having to find a board and its active sprint by hand.
    expect(buildJql(['PROJ']).sprint).toContain('sprint in openSprints()');
  });

  it('keeps `My issues` inside the open sprints too', () => {
    // Without the clause it answered "everything assigned to me", backlog included, and the current
    // sprint's rows fell off the end of the list.
    expect(buildJql(['PROJ']).mine).toContain('sprint in openSprints()');
  });

  it('leaves out what is already done', () => {
    expect(buildJql(['PROJ']).sprint).toContain('statusCategory != Done');
    expect(buildJql(['PROJ']).mine).toContain('statusCategory != Done');
  });

  it('asks for the current user rather than a hardcoded name', () => {
    expect(buildJql(['PROJ']).mine).toContain('assignee = currentUser()');
  });

  it('drops the project clause when nothing is configured', () => {
    // Better a site-wide search than a JQL syntax error, which returns no explanation at all.
    expect(buildJql([]).sprint.startsWith('sprint in openSprints()')).toBe(true);
  });

  it('cannot be broken out of by a quote in a project key', () => {
    expect(buildJql(['PR"OJ']).sprint).toContain('"PROJ"');
  });
});

describe('parseTransitions', () => {
  it('labels a transition by the status it lands on, and carries its category', () => {
    // The transition's own name is a verb ("Start progress"); the destination is what the user chooses.
    // The category comes along so a transition can also be picked by meaning, whatever the site named it.
    const body = {
      transitions: [
        {
          id: '21',
          name: 'Start progress',
          to: { name: 'In progress', statusCategory: { key: 'indeterminate' } },
        },
        { id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } },
      ],
    };
    expect(parseTransitions(body)).toEqual([
      { id: '21', label: 'In progress', stage: 'in-progress' },
      { id: '31', label: 'Done', stage: 'done' },
    ]);
  });

  it('reports an unknown stage rather than guessing one from the name', () => {
    // A payload with no destination carries no category either, and inferring "in progress" from the
    // word "progress" is exactly the name matching the category exists to avoid.
    expect(parseTransitions({ transitions: [{ id: '7', name: 'Start progress' }] })).toEqual([
      { id: '7', label: 'Start progress', stage: 'unknown' },
    ]);
  });

  it('falls back to the transition name when there is no destination', () => {
    expect(parseTransitions({ transitions: [{ id: '5', name: 'Revoir' }] })[0]?.label).toBe('Revoir');
  });

  it('drops a transition without an id, which cannot be applied', () => {
    expect(parseTransitions({ transitions: [{ name: 'Nowhere' }] })).toEqual([]);
  });

  it('returns nothing for a response that is not a transition list', () => {
    expect(parseTransitions(null)).toEqual([]);
    expect(parseTransitions({})).toEqual([]);
    expect(parseTransitions({ transitions: 'nope' })).toEqual([]);
  });
});

describe('presentStage', () => {
  it('shows the status as written, with a tone from the category', () => {
    expect(presentStage('in-progress', 'In review')).toMatchObject({ label: 'In review', tone: 'busy' });
    expect(presentStage('todo', 'To do')).toMatchObject({ tone: 'neutral' });
    expect(presentStage('done', 'Done')).toMatchObject({ tone: 'ok' });
  });

  it('never shows an empty pill', () => {
    expect(presentStage('unknown', '').label).toBe('no status');
  });
});

describe('boardColumns', () => {
  /** Only the two fields the layout reads; the rest of an issue is irrelevant here. */
  function issue(key: string, stage: IssueStage): JiraIssue {
    return {
      key,
      summary: '',
      status: '',
      stage,
      type: '',
      assignee: '',
      isMine: false,
      url: '',
      updatedAt: '',
    };
  }

  it('always draws the three known stages, empty or not', () => {
    // A column that disappears when it empties takes the board's shape with it, and "nothing is in
    // progress" is an answer worth seeing rather than a gap to interpret.
    const columns = boardColumns([issue('PROJ-1', 'todo')]);
    expect(columns.map((column) => column.stage)).toEqual(['todo', 'in-progress', 'done']);
    expect(columns[1]?.issues).toEqual([]);
  });

  it('adds a fourth column only when something is uncategorised', () => {
    expect(boardColumns([issue('PROJ-1', 'todo')]).map((c) => c.stage)).not.toContain('unknown');
    const strays = boardColumns([issue('PROJ-1', 'todo'), issue('PROJ-2', 'unknown')]);
    expect(strays.map((column) => column.stage)).toEqual([
      'todo',
      'in-progress',
      'done',
      'unknown',
    ]);
  });

  it('never drops an issue, whatever its stage', () => {
    // The rule that matters: an issue on no column is a real ticket hidden from a board read as the
    // whole picture. Same failure as a session with no tab, different surface.
    const source = [
      issue('PROJ-1', 'todo'),
      issue('PROJ-2', 'unknown'),
      issue('PROJ-3', 'done'),
      issue('PROJ-4', 'in-progress'),
    ];
    const placed = boardColumns(source).flatMap((column) => column.issues.map((i) => i.key));
    expect(placed.sort()).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']);
  });

  it('keeps the order the search returned inside a column', () => {
    // The JQL already ordered these (`updated DESC` in the personal view). Re-sorting here would be a
    // second authority on an order that already means something.
    const columns = boardColumns([
      issue('PROJ-9', 'todo'),
      issue('PROJ-4', 'in-progress'),
      issue('PROJ-7', 'todo'),
    ]);
    expect(columns[0]?.issues.map((entry) => entry.key)).toEqual(['PROJ-9', 'PROJ-7']);
  });

  it('does not touch the list it was given', () => {
    // The panel is rebuilt from pushed state on every poll; sorting that array in place would mutate
    // what the main process sent.
    const source = [issue('PROJ-1', 'todo'), issue('PROJ-2', 'in-progress')];
    boardColumns(source);
    expect(source.map((entry) => entry.key)).toEqual(['PROJ-1', 'PROJ-2']);
  });
});

describe('transitionTo', () => {
  function move(id: string, label: string, stage: IssueStage): IssueTransition {
    return { id, label, stage };
  }

  it('chooses on the destination category and never on its name', () => {
    // The whole point: a board whose columns are called "Ready for QA" or "Developpement" still
    // works, because the category is the only part of a workflow that means the same thing anywhere.
    const transitions = [move('21', 'Ready for QA', 'in-progress'), move('31', 'Shipped', 'done')];
    expect(transitionTo(transitions, 'in-progress')?.id).toBe('21');
    expect(transitionTo(transitions, 'done')?.id).toBe('31');
  });

  it('answers null when the workflow offers no way there', () => {
    // A real answer and not a failure to handle: a ticket in Done often has no path back to To do,
    // and the caller says so rather than sending a move Jira would refuse.
    expect(transitionTo([move('31', 'Shipped', 'done')], 'todo')).toBeNull();
    expect(transitionTo([], 'done')).toBeNull();
  });

  it('takes the first of two ways into the same category', () => {
    // Nothing on a dragged card could express a preference between them.
    const transitions = [move('11', 'Start', 'in-progress'), move('12', 'Reopen', 'in-progress')];
    expect(transitionTo(transitions, 'in-progress')?.id).toBe('11');
  });
});

describe('filtering the board', () => {
  function issue(fields: Partial<JiraIssue> & { key: string }): JiraIssue {
    return {
      summary: '',
      status: '',
      stage: 'todo',
      type: '',
      assignee: '',
      isMine: false,
      url: '',
      updatedAt: '',
      ...fields,
    };
  }

  const sprint = [
    issue({ key: 'PROJ-999', assignee: 'Alex Martin', status: 'In review', stage: 'in-progress' }),
    issue({ key: 'PROJ-1000', assignee: '', status: 'To do' }),
    issue({ key: 'PROJ-12', assignee: 'Julio Paniagua', status: 'In progress', stage: 'in-progress' }),
    issue({ key: 'PROJ-1001', assignee: 'Alex Martin', status: 'To do' }),
  ];

  it('lists the assignees present, and only them', () => {
    // Read off the issues rather than from a user directory: the question is who is on this sprint.
    // The unassigned issue contributes no name, its option being a state and not a person.
    expect(assigneesOf(sprint)).toEqual(['Alex Martin', 'Julio Paniagua']);
  });

  it('filters on a person, on nobody, and on everybody', () => {
    expect(filterByAssignee(sprint, '').map((entry) => entry.key)).toHaveLength(4);
    expect(filterByAssignee(sprint, 'Alex Martin').map((entry) => entry.key)).toEqual([
      'PROJ-999',
      'PROJ-1001',
    ]);
    // The case an `=== assignee` comparison gets wrong by accident: an unassigned issue carries an
    // empty string, and `''` is also the value that means "no filter at all".
    expect(filterByAssignee(sprint, ASSIGNEE_NONE).map((entry) => entry.key)).toEqual(['PROJ-1000']);
  });

  it('does not touch the list it was given', () => {
    const source = [...sprint];
    filterByAssignee(source, 'Alex Martin');
    expect(source.map((entry) => entry.key)).toEqual(sprint.map((entry) => entry.key));
  });
});

describe('ISSUE_KEY_PATTERN', () => {
  it('accepts a real key and refuses anything that could reach a shell', () => {
    /*
     * This pattern is the only thing between the Jira list and a command line: the key is
     * interpolated into `dev <KEY>` inside an interactive bash. It is anchored and narrow on purpose,
     * so what it lets through cannot be a flag, a path, or a second command.
     */
    expect(ISSUE_KEY_PATTERN.test('PROJ-1601')).toBe(true);
    expect(ISSUE_KEY_PATTERN.test('WEB_API-42')).toBe(true);

    for (const bad of [
      'PROJ-1601; rm -rf /',
      'PROJ-1601 && whoami',
      '$(whoami)',
      '--version',
      'proj-412',
      'PROJ-',
      '-1601',
      'PROJ-1601\n',
    ]) {
      expect(ISSUE_KEY_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('boardUrl', () => {
  it('builds the project shortcut Jira resolves for any project style', () => {
    /*
     * `/browse/<KEY>` on purpose, and pinned here so nobody "improves" it into a board path. A board
     * path needs the numeric board id AND the project style, neither of which this app holds: PROJ is
     * team-managed (`/jira/software/projects/...`) while a company-managed project uses
     * `/jira/software/c/projects/...`, so a hardcoded guess would 404 half the time.
     */
    expect(boardUrl('https://example.atlassian.net', 'PROJ')).toBe(
      'https://example.atlassian.net/browse/PROJ',
    );
  });

  it('tolerates a trailing slash on the site and a sloppy key', () => {
    // The store already trims and uppercases what it saves, but this function is also called with a
    // value straight from a settings draft.
    expect(boardUrl('https://example.atlassian.net/', ' proj ')).toBe(
      'https://example.atlassian.net/browse/PROJ',
    );
  });

  it('encodes the key rather than pasting it into a URL', () => {
    expect(boardUrl('https://x.atlassian.net', 'A B')).toBe('https://x.atlassian.net/browse/A%20B');
  });
});
