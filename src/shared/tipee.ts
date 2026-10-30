/**
 * The time tracking card of the Today tab, read from a Tipee instance.
 *
 * Tipee publishes no API: the calls below are the ones its web app makes, so every answer is
 * checked for the fields this card uses and anything else is reported rather than guessed. Read
 * only: this app never clocks in or out.
 */

/** Where the day stands, as Tipee counts it. */
export interface TipeeStatus {
  /** Whether a timecheck is open right now. */
  readonly clockedIn: boolean;
  /** When the open timecheck started, ISO, or null. */
  readonly since: string | null;
  readonly dueMinutes: number;
  readonly doneMinutes: number;
  readonly balanceMinutes: number;
  /** Corrections of the day still waiting for a manager. */
  readonly pending: number;
}

export interface TipeeState {
  /** False until an address, a username and a password are all set. */
  readonly configured: boolean;
  readonly status: TipeeStatus | null;
  readonly checkedAt: string | null;
  readonly error: string | null;
}

/** An instance address as typed, reduced to `https://host`, or empty when it is not one. */
export function sanitizeTipeeUrl(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

/** The login form's CSRF token, or null when the form changed. */
export function readCsrfToken(html: string): string | null {
  const tag = /<input[^>]*name="_csrf_token"[^>]*>/.exec(html)?.[0];
  const token = tag === undefined ? undefined : /value="([^"]*)"/.exec(tag)?.[1];
  return token === undefined || token.length === 0 ? null : token;
}

/** Minutes in an ISO 8601 duration such as `PT8H`, `PT3H37M` or Tipee's negative `PT-4H-23M`. */
export function parseIsoMinutes(value: unknown): number {
  const match = typeof value === 'string' ? /^(-)?PT(?:(-?\d+)H)?(?:(-?\d+)M)?/.exec(value) : null;
  if (match === null) {
    return 0;
  }
  const minutes = Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return match[1] === undefined ? minutes : -minutes;
}

/**
 * The status out of `resources.show-status` and one `workdays.show` row.
 *
 * `next_action` is the only reliable "clocked in": `out` means the button would clock out. The open
 * interval's start is read from the timechecks, whose ranges are `start/end` with `-` while open.
 */
export function parseTipeeStatus(show: unknown, row: unknown, date: string): TipeeStatus | null {
  const clock = isRecord(show) ? show['clock'] : undefined;
  if (!isRecord(clock) || (clock['next_action'] !== 'in' && clock['next_action'] !== 'out')) {
    return null;
  }
  const record = isRecord(row) ? row : {};
  const worktimes = Array.isArray(record['worktimes']) ? record['worktimes'] : [];
  const worktime = worktimes.find(
    (item): item is Record<string, unknown> => isRecord(item) && item['date'] === date,
  );
  const timechecks = (Array.isArray(record['timechecks']) ? record['timechecks'] : []).filter(
    isRecord,
  );
  const open = timechecks
    .map((timecheck) => String(timecheck['time_range'] ?? '').split('/'))
    .filter(([, end]) => end === undefined || end === '' || end === '-')
    .map(([start]) => start ?? '')
    .filter((start) => !Number.isNaN(Date.parse(start)))
    .sort()
    .pop();
  const clockedIn = clock['next_action'] === 'out';
  return {
    clockedIn,
    since: clockedIn && open !== undefined ? new Date(open).toISOString() : null,
    dueMinutes: parseIsoMinutes(worktime?.['due']),
    doneMinutes: parseIsoMinutes(worktime?.['done']),
    balanceMinutes: parseIsoMinutes(worktime?.['balance']),
    pending: timechecks.filter((timecheck) => timecheck['type'] === 'proposal').length,
  };
}

/** `7 h 05`, `-0 h 30`: hours and minutes the way a timesheet reads them. */
export function describeMinutes(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  const absolute = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(absolute / 60)} h ${String(absolute % 60).padStart(2, '0')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
