import type { IssueStage, IssueTransition, JiraIssue, Sprint } from '@shared/contracts.js';

const TIMEOUT_MS = 20_000;
/** A sprint with more issues than this is not a list you read in a strip anyway. */
const MAX_RESULTS = 60;

export interface JiraCredentials {
  readonly siteUrl: string;
  readonly email: string;
  readonly token: string;
}

/**
 * Which search endpoint this site answers on.
 *
 * Jira Cloud replaced `POST /rest/api/3/search` with `GET /rest/api/3/search/jql`, and instances have been
 * migrated on their own schedule. Rather than guess, the first call tries the current one and falls back
 * once on the legacy path, then remembers the answer for the rest of the run.
 */
let endpoint: 'jql' | 'legacy' | null = null;

/** Fields asked for, kept to what the list actually shows: anything more is payload for nothing. */
const FIELDS = 'summary,status,assignee,issuetype,updated';

/**
 * Runs a JQL search and returns the issues.
 *
 * Basic auth with the account email and an API token, which is what Jira Cloud offers for a personal
 * integration. Errors come back as a message rather than a thrown exception: a wrong token or an expired
 * site must show up as a readable line in the tab, not as a crash in the main process.
 */
export async function searchIssues(
  credentials: JiraCredentials,
  jql: string,
  myAccountEmail: string,
): Promise<{ issues: JiraIssue[]; error: string | null }> {
  const base = credentials.siteUrl.replace(/\/+$/, '');
  if (base.length === 0 || credentials.email.length === 0 || credentials.token.length === 0) {
    return { issues: [], error: 'Incomplete Jira connection' };
  }

  const attempts: ('jql' | 'legacy')[] = endpoint === null ? ['jql', 'legacy'] : [endpoint];
  let lastError = 'Jira injoignable';

  for (const attempt of attempts) {
    const response = await request(base, credentials, jql, attempt);
    if (response.status === 'ok') {
      endpoint = attempt;
      return { issues: parseIssues(response.body, base, myAccountEmail), error: null };
    }
    lastError = response.message;
    // Only a missing endpoint is worth retrying on the other path; a 401 would fail identically.
    if (!response.retryOtherEndpoint) {
      break;
    }
  }
  return { issues: [], error: lastError };
}

async function request(
  base: string,
  credentials: JiraCredentials,
  jql: string,
  variant: 'jql' | 'legacy',
): Promise<
  | { status: 'ok'; body: unknown }
  | { status: 'error'; message: string; retryOtherEndpoint: boolean }
> {
  const auth = Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json' };

  const url =
    variant === 'jql'
      ? `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${MAX_RESULTS}&fields=${FIELDS}`
      : `${base}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${MAX_RESULTS}&fields=${FIELDS}`;

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) {
      return { status: 'ok', body: await response.json() };
    }
    return {
      status: 'error',
      message: describeStatus(response.status),
      retryOtherEndpoint: response.status === 404 || response.status === 410,
    };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      retryOtherEndpoint: false,
    };
  }
}

/** Messages worth acting on, rather than a bare status code. */
function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return 'Jira refused the authentication: check the email and the token';
    case 403:
      return 'Jira refused access: the account lacks the rights';
    case 400:
      return 'JQL query refused: check the project keys';
    default:
      return `Jira answered ${status}`;
  }
}

/**
 * Turns a search response into issues.
 *
 * Exported for testing. The status **category** is what decides the stage: status names are per-project
 * and renamed freely, while `statusCategory.key` is one of `new`, `indeterminate`, `done` everywhere.
 */
export function parseIssues(body: unknown, siteUrl: string, myEmail: string): JiraIssue[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const raw = (body as { issues?: unknown }).issues;
  if (!Array.isArray(raw)) {
    return [];
  }

  const issues: JiraIssue[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const issue = entry as Record<string, unknown>;
    const key = typeof issue.key === 'string' ? issue.key : '';
    if (key.length === 0) {
      continue;
    }
    const fields = (typeof issue.fields === 'object' && issue.fields !== null
      ? issue.fields
      : {}) as Record<string, unknown>;

    const status = asRecord(fields.status);
    const assignee = asRecord(fields.assignee);
    const email = typeof assignee.emailAddress === 'string' ? assignee.emailAddress : '';

    issues.push({
      key,
      summary: typeof fields.summary === 'string' ? fields.summary : '',
      status: typeof status.name === 'string' ? status.name : '',
      stage: asStage(asRecord(status.statusCategory).key),
      type: typeof asRecord(fields.issuetype).name === 'string'
        ? (asRecord(fields.issuetype).name as string)
        : '',
      assignee: typeof assignee.displayName === 'string' ? assignee.displayName : '',
      // Compared on the email of the very account whose token is being used: the only identity both
      // sides of this call agree on without an extra request.
      isMine: myEmail.length > 0 && email.toLowerCase() === myEmail.toLowerCase(),
      url: `${siteUrl.replace(/\/+$/, '')}/browse/${key}`,
      updatedAt: typeof fields.updated === 'string' ? fields.updated : '',
    });
  }
  return issues;
}

/**
 * The transitions this issue can take right now.
 *
 * Asked of Jira rather than derived from a list of statuses: a workflow decides which moves are legal
 * from where, and only Jira knows. Each transition carries an id, which is what the move is made with.
 */
export async function readTransitions(
  credentials: JiraCredentials,
  key: string,
): Promise<{ transitions: IssueTransition[]; error: string | null }> {
  const result = await call(credentials, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  if (result.status === 'error') {
    return { transitions: [], error: result.message };
  }
  return { transitions: parseTransitions(result.body), error: null };
}

/** Reads a transition list. Exported for testing: the useful name is nested, not at the top level. */
export function parseTransitions(body: unknown): IssueTransition[] {
  const raw = asRecord(body).transitions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const transitions: IssueTransition[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const id = typeof record.id === 'string' ? record.id : '';
    if (id.length === 0) {
      continue;
    }
    // The transition's own name is a verb ("Start progress"); the status it lands on is what the user
    // actually cares about, so it wins when present.
    const target = asRecord(record.to);
    const label = typeof target.name === 'string' && target.name.length > 0
      ? target.name
      : typeof record.name === 'string'
        ? record.name
        : id;
    transitions.push({ id, label });
  }
  return transitions;
}

/** Moves an issue through a transition. */
export async function applyTransition(
  credentials: JiraCredentials,
  key: string,
  transitionId: string,
): Promise<{ ok: boolean; message: string }> {
  const result = await call(
    credentials,
    `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    { method: 'POST', body: { transition: { id: transitionId } } },
  );
  return result.status === 'ok'
    ? { ok: true, message: `${key} moved` }
    : { ok: false, message: result.message };
}

/**
 * Assigns an issue to an account.
 *
 * Jira wants an `accountId`, not an email: emails are hidden by privacy settings on many sites, so the
 * id is the only identifier that always works. `readMyAccountId` gets it from the token's own account.
 */
export async function assignIssue(
  credentials: JiraCredentials,
  key: string,
  accountId: string,
): Promise<{ ok: boolean; message: string }> {
  const result = await call(
    credentials,
    `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`,
    { method: 'PUT', body: { accountId } },
  );
  return result.status === 'ok'
    ? { ok: true, message: `${key} assigned` }
    : { ok: false, message: result.message };
}

/** The account id behind the token, needed to assign anything. */
export async function readMyAccountId(
  credentials: JiraCredentials,
): Promise<{ accountId: string; error: string | null }> {
  const result = await call(credentials, '/rest/api/3/myself');
  if (result.status === 'error') {
    return { accountId: '', error: result.message };
  }
  const id = asRecord(result.body).accountId;
  return typeof id === 'string' && id.length > 0
    ? { accountId: id, error: null }
    : { accountId: '', error: 'Jira returned no account id' };
}

/** One authenticated call, shared by every read and write above. */
async function call(
  credentials: JiraCredentials,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: 'ok'; body: unknown } | { status: 'error'; message: string }> {
  const base = credentials.siteUrl.replace(/\/+$/, '');
  const auth = Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64');
  try {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return { status: 'error', message: describeStatus(response.status) };
    }
    // A transition and an assignment both answer 204 with no body at all.
    const text = await response.text();
    return { status: 'ok', body: text.length > 0 ? JSON.parse(text) : {} };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Lists the sprints that can still be planned, for the Triage tab.
 *
 * Read through the Agile API and not through an issue's sprint field, for the reason story points
 * are not shown either: that field is a `customfield_xxxxx` whose number differs from site to site,
 * so reading it means discovering it first. A board answers the same question by name.
 *
 * Closed sprints are left out: triage is about what to build next.
 */
export async function listSprints(
  credentials: JiraCredentials,
  projectKeys: readonly string[],
): Promise<{ sprints: Sprint[]; error: string | null }> {
  const sprints: Sprint[] = [];
  const seen = new Set<number>();
  let lastError: string | null = null;

  for (const projectKey of projectKeys) {
    const boards = await call(credentials, `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}`);
    if (boards.status === 'error') {
      lastError = boards.message;
      continue;
    }
    for (const board of asArray(asRecord(boards.body)['values'])) {
      const boardRecord = asRecord(board);
      const boardId = boardRecord['id'];
      if (typeof boardId !== 'number') {
        continue;
      }
      const boardName = typeof boardRecord['name'] === 'string' ? boardRecord['name'] : projectKey;
      const answer = await call(
        credentials,
        `/rest/agile/1.0/board/${boardId}/sprint?state=active,future&maxResults=50`,
      );
      if (answer.status === 'error') {
        // A Kanban board has no sprints and answers 400; that is not an error worth showing.
        continue;
      }
      for (const value of asArray(asRecord(answer.body)['values'])) {
        const sprint = asRecord(value);
        const id = sprint['id'];
        const name = sprint['name'];
        if (typeof id !== 'number' || typeof name !== 'string' || seen.has(id)) {
          continue;
        }
        seen.add(id);
        sprints.push({
          id,
          name,
          state: typeof sprint['state'] === 'string' ? sprint['state'] : 'future',
          boardName,
        });
      }
    }
  }

  // Active first: that is the one being worked, and the list is read top down.
  sprints.sort((a, b) => rankState(a.state) - rankState(b.state) || a.name.localeCompare(b.name));
  return { sprints, error: sprints.length === 0 ? lastError : null };
}

function rankState(state: string): number {
  return state === 'active' ? 0 : 1;
}

/**
 * Reads a sprint's issues with their descriptions, for the analysis.
 *
 * A separate call from the tab's own search because it asks for `description`, which the list never
 * shows and which is the bulk of the payload. `renderedFields` is not requested: the analysis reads
 * the text, and Jira's HTML rendering would only add markup for a model to strip.
 */
export async function readSprintIssues(
  credentials: JiraCredentials,
  sprintId: number,
): Promise<{ issues: SprintIssue[]; error: string | null }> {
  const answer = await call(
    credentials,
    `/rest/agile/1.0/sprint/${sprintId}/issue?maxResults=${MAX_RESULTS}` +
      '&fields=summary,status,assignee,description',
  );
  if (answer.status === 'error') {
    return { issues: [], error: answer.message };
  }

  const issues: SprintIssue[] = [];
  for (const value of asArray(asRecord(answer.body)['issues'])) {
    const issue = asRecord(value);
    const key = issue['key'];
    if (typeof key !== 'string') {
      continue;
    }
    const fields = asRecord(issue['fields']);
    const status = asRecord(fields['status']);
    const assignee = asRecord(fields['assignee']);
    issues.push({
      key,
      summary: typeof fields['summary'] === 'string' ? fields['summary'] : '',
      status: typeof status['name'] === 'string' ? status['name'] : '',
      assignee: typeof assignee['displayName'] === 'string' ? assignee['displayName'] : '',
      description: flattenDocument(fields['description']),
    });
  }
  return { issues, error: null };
}

export interface SprintIssue {
  readonly key: string;
  readonly summary: string;
  readonly status: string;
  readonly assignee: string;
  readonly description: string;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Flattens an Atlassian Document Format body to plain text.
 *
 * ADF is a tree of nodes whose text lives in `text` leaves; walking it is enough for an analysis,
 * which needs the words and not the formatting. A `null` description is normal and common, so it
 * returns an empty string rather than being treated as a failure.
 */
export function flattenDocument(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }
  const record = asRecord(node);
  const text = record['text'];
  const own = typeof text === 'string' ? text : '';
  const children = asArray(record['content']).map(flattenDocument).join('');
  // Block nodes are separated by a newline so headings and list items do not run together.
  const separator = record['type'] === 'paragraph' || record['type'] === 'heading' ? '\n' : '';
  return `${own}${children}${separator}`;
}

function asStage(key: unknown): IssueStage {
  switch (key) {
    case 'new':
      return 'todo';
    case 'indeterminate':
      return 'in-progress';
    case 'done':
      return 'done';
    default:
      return 'unknown';
  }
}

/**
 * The two searches of the tab.
 *
 * Exported for testing, because a JQL mistake is silent: it returns the wrong issues rather than an
 * error. `openSprints()` is what makes "current sprint" a question Jira answers itself, instead of the
 * app having to find a board and its active sprint.
 */
export function buildJql(projectKeys: readonly string[]): { sprint: string; mine: string } {
  const scope =
    projectKeys.length > 0
      ? `project in (${projectKeys.map((key) => `"${key.replace(/"/g, '')}"`).join(', ')}) AND `
      : '';
  return {
    sprint: `${scope}sprint in openSprints() AND statusCategory != Done ORDER BY status ASC, key ASC`,
    mine: `${scope}assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`,
  };
}
