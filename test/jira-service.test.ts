import { describe, expect, it } from 'vitest';
import { buildJql, parseIssues, parseTransitions } from '../src/main/jira/jira-service.js';
import { boardUrl, orderIssues, presentStage } from '../src/renderer/ui/jira-list.js';
import type { IssueStage, JiraIssue } from '../src/shared/contracts.js';

const SITE = 'https://example.atlassian.net';
const ME = 'dev@example.com';

/** Shape of a Jira Cloud search response, reduced to the fields the list reads. */
const BODY = {
  issues: [
    {
      key: 'PROJ-1674',
      fields: {
        summary: 'User profile detail page',
        status: { name: 'En cours', statusCategory: { key: 'indeterminate' } },
        assignee: { displayName: 'Julio P.', emailAddress: 'dev@example.com' },
        issuetype: { name: 'Story' },
        updated: '2026-08-04T15:00:00.000+0200',
      },
    },
    {
      key: 'PROJ-1651',
      fields: {
        summary: 'Invoice list filters',
        status: { name: 'À faire', statusCategory: { key: 'new' } },
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
      status: 'En cours',
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
    expect(buildJql(['TE"C']).sprint).toContain('"PROJ"');
  });
});

describe('parseTransitions', () => {
  it('labels a transition by the status it lands on', () => {
    // The transition's own name is a verb ("Start progress"); the destination is what the user chooses.
    const body = {
      transitions: [
        { id: '21', name: 'Start progress', to: { name: 'En cours' } },
        { id: '31', name: 'Done', to: { name: 'Terminé' } },
      ],
    };
    expect(parseTransitions(body)).toEqual([
      { id: '21', label: 'En cours' },
      { id: '31', label: 'Terminé' },
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
    expect(presentStage('in-progress', 'En review')).toMatchObject({ label: 'En review', tone: 'busy' });
    expect(presentStage('todo', 'À faire')).toMatchObject({ tone: 'neutral' });
    expect(presentStage('done', 'Terminé')).toMatchObject({ tone: 'ok' });
  });

  it('never shows an empty pill', () => {
    expect(presentStage('unknown', '').label).toBe('sans statut');
  });
});

describe('orderIssues', () => {
  /** Only the two fields the ordering reads; the rest of an issue is irrelevant here. */
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

  it('puts what is in progress first', () => {
    const ordered = orderIssues([
      issue('PROJ-1', 'todo'),
      issue('PROJ-2', 'done'),
      issue('PROJ-3', 'in-progress'),
    ]);
    expect(ordered.map((entry) => entry.key)).toEqual(['PROJ-3', 'PROJ-1', 'PROJ-2']);
  });

  it('keeps the order the JQL returned inside a group', () => {
    /*
     * The point of a stable sort on a single key: the search already ordered these (`updated DESC` in
     * "Mes tickets"), so lifting the in-progress group must not reshuffle anything else. Without
     * stability this is where a second, invisible ordering rule would creep in.
     */
    const ordered = orderIssues([
      issue('PROJ-9', 'todo'),
      issue('PROJ-4', 'in-progress'),
      issue('PROJ-7', 'todo'),
      issue('PROJ-2', 'in-progress'),
    ]);
    expect(ordered.map((entry) => entry.key)).toEqual(['PROJ-4', 'PROJ-2', 'PROJ-9', 'PROJ-7']);
  });

  it('ranks an unknown category after the real work but before what is finished', () => {
    const ordered = orderIssues([
      issue('PROJ-1', 'done'),
      issue('PROJ-2', 'unknown'),
      issue('PROJ-3', 'todo'),
    ]);
    expect(ordered.map((entry) => entry.key)).toEqual(['PROJ-3', 'PROJ-2', 'PROJ-1']);
  });

  it('does not touch the list it was given', () => {
    // The panel is rebuilt from pushed state on every poll; sorting that array in place would mutate
    // what the main process sent.
    const source = [issue('PROJ-1', 'todo'), issue('PROJ-2', 'in-progress')];
    orderIssues(source);
    expect(source.map((entry) => entry.key)).toEqual(['PROJ-1', 'PROJ-2']);
  });
});

describe('boardUrl', () => {
  it('builds the project shortcut Jira resolves for any project style', () => {
    /*
     * `/browse/<KEY>` on purpose, and pinned here so nobody "improves" it into a board path. A board
     * path needs the numeric board id AND the project style, neither of which this app holds: a team-managed project is
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
