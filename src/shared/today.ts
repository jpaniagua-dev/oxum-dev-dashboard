/**
 * The Today tab: what is waiting for its user, one card per source.
 *
 * Shared because three places read the same shapes: the main process builds the digest, the store
 * re-reads it from disk through the same parser, and the renderer draws it.
 */

/** A source the Today tab can show. */
export type TodayChannel = 'pulls' | 'tickets' | 'calendar' | 'mail' | 'teams' | 'tipee';

/** Every channel, in display order. */
export const TODAY_CHANNELS: readonly TodayChannel[] = [
  'pulls',
  'tickets',
  'calendar',
  'mail',
  'teams',
  'tipee',
];

/** Which channels this machine shows. Stored per account, so a home and a work PC differ. */
export type TodayChannels = Readonly<Record<TodayChannel, boolean>>;

/**
 * Pull requests and tickets are on, everything else is off.
 *
 * The first two cost nothing: the tab reads what the other tabs already hold. The others reach an
 * account (a Microsoft 365 connector, a time tracking site) that a fresh install has no reason to
 * assume it has.
 */
export const DEFAULT_TODAY_CHANNELS: TodayChannels = {
  pulls: true,
  tickets: true,
  calendar: false,
  mail: false,
  teams: false,
  tipee: false,
};

export const TODAY_CHANNEL_LABELS: Readonly<Record<TodayChannel, string>> = {
  pulls: 'Pull requests',
  tickets: 'Tickets',
  calendar: 'Calendar',
  mail: 'Mail',
  teams: 'Teams',
  tipee: 'Time tracking',
};

/** The channels the Microsoft 365 digest feeds. */
export const DIGEST_CHANNELS: readonly TodayChannel[] = ['calendar', 'mail', 'teams'];

/**
 * Reads a stored value. The two free channels are on unless explicitly off; the others only on an
 * explicit `true`, so a hand-edited `"yes"` cannot start a run against an account.
 */
export function sanitizeTodayChannels(value: unknown): TodayChannels {
  const input = isRecord(value) ? value : {};
  return {
    pulls: input['pulls'] !== false,
    tickets: input['tickets'] !== false,
    calendar: input['calendar'] === true,
    mail: input['mail'] === true,
    teams: input['teams'] === true,
    tipee: input['tipee'] === true,
  };
}

/** Whether any channel fed by the Microsoft 365 digest is on. */
export function wantsDigest(channels: TodayChannels): boolean {
  return DIGEST_CHANNELS.some((channel) => channels[channel]);
}

/* ------------------------------------------------------------------ *
 * Microsoft 365 digest
 * ------------------------------------------------------------------ */

const M365 = 'mcp__claude_ai_Microsoft_365__';

/** The read tools the digest calls, and the only ones its run is allowed. */
export const DIGEST_TOOLS = {
  me: `${M365}get_me`,
  calendar: `${M365}outlook_calendar_search`,
  mail: `${M365}outlook_email_search`,
  messages: `${M365}chat_message_search`,
  chats: `${M365}teams_list_chats`,
} as const;

/**
 * Tools of the same connector that write, refused by name on top of the allow-list.
 *
 * The allow-list is what keeps the run read-only under `dontAsk`; this is the second lock, for the
 * day a flag changes meaning. The built-in tools are refused too: `--tools` would have been the
 * shorter way, and it hides the connector's tools along with them.
 */
export const DIGEST_DENIED_TOOLS: readonly string[] = [
  `${M365}outlook_send_mail`,
  `${M365}outlook_send_draft`,
  `${M365}outlook_create_draft`,
  `${M365}outlook_forward_mail`,
  `${M365}outlook_batch_delete_messages`,
  `${M365}outlook_trash_thread`,
  `${M365}teams_send_chat_message`,
  `${M365}teams_send_channel_message`,
  `${M365}teams_reply_channel_message`,
  'Bash',
  'PowerShell',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
];

/**
 * The command line of a digest run, after the binary.
 *
 * Each flag was measured against the real CLI, and three obvious ones are absent on purpose:
 * `--strict-mcp-config`, `--restricted` and `--tools` all remove the claude.ai connectors, so the
 * tools cannot be found. `--permission-mode dontAsk` is what makes the allow-list binding: without
 * it, a user whose own settings say `auto` gets any tool approved. `--setting-sources project`, run
 * from an empty folder, keeps the user's hooks and permission mode out of it.
 */
export function digestArgs(prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'project',
    '--disable-slash-commands',
    '--allowedTools',
    ...Object.values(DIGEST_TOOLS),
    '--disallowedTools',
    ...DIGEST_DENIED_TOOLS,
    '--no-session-persistence',
    '--model',
    'haiku',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
}

/**
 * The sentence that asks for the calls.
 *
 * No quote, percent sign or ampersand anywhere: an npm-installed CLI is a `.cmd`, and `runCli`
 * refuses those characters on its way through `cmd.exe`. Dates are local wall-clock days, which is
 * what both searches read a zone-less value as.
 */
export function digestPrompt(now: Date): string {
  const today = localDay(now);
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const tomorrow = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  return [
    'Make exactly these five tool calls, all in one turn, then reply with the single word OK.',
    'Do not summarise the results.',
    `1. ${DIGEST_TOOLS.me} with no arguments.`,
    `2. ${DIGEST_TOOLS.calendar} with query set to *, afterDateTime ${today}T00:00:00,`,
    `beforeDateTime ${tomorrow}T00:00:00, order oldest, limit 25.`,
    `3. ${DIGEST_TOOLS.mail} with order newest, afterDateTime ${yesterday}T00:00:00, limit 25.`,
    `4. ${DIGEST_TOOLS.messages} with query set to *, afterDateTime ${yesterday}T00:00:00, limit 25.`,
    `5. ${DIGEST_TOOLS.chats} with limit 25.`,
  ].join(' ');
}

/** One meeting of the day, in the mailbox's own wall-clock time. */
export interface DigestEvent {
  readonly subject: string;
  /** `YYYY-MM-DDTHH:mm`, wall clock in `timeZone`. Never reinterpreted as UTC. */
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
  readonly isAllDay: boolean;
  readonly isCancelled: boolean;
  /** `busy`, `tentative`, `free`, `oof`, `workingElsewhere`, as Outlook says it. */
  readonly showAs: string;
  readonly location: string;
  readonly url: string;
}

export interface DigestMail {
  readonly subject: string;
  readonly sender: string;
  /** ISO timestamp, UTC. */
  readonly receivedAt: string;
  readonly isRead: boolean;
  readonly important: boolean;
  /** The start of the body, as the search returns it. */
  readonly preview: string;
  readonly url: string;
}

/** One message of a conversation, as shown in the card. */
export interface ChatLine {
  readonly from: string;
  /** ISO timestamp, UTC. */
  readonly at: string;
  readonly text: string;
  readonly url: string;
}

/**
 * One Teams conversation waiting for a reply: somebody else wrote after my last message.
 *
 * "Waiting for a reply" and not "unread", deliberately: the connector exposes no read state for a
 * chat or a message, checked on both the search and a full message read. What it does give is who
 * wrote last, and a conversation where that is somebody else is the one that needs me.
 */
export interface DigestChat {
  readonly chatId: string;
  readonly title: string;
  /** Messages since my last one. */
  readonly count: number;
  readonly lastFrom: string;
  /** ISO timestamp, UTC. */
  readonly lastAt: string;
  readonly preview: string;
  readonly url: string;
  /** The messages since my last one, oldest first, the last few only. */
  readonly lines: readonly ChatLine[];
}

/** How many messages of one conversation the card shows. */
const LINES_PER_CHAT = 4;

/** What a section could not read, kept per section so one failure leaves the others standing. */
export type DigestSection = 'calendar' | 'mail' | 'teams';

/**
 * The shape of a stored digest. Raised when a field the cards need is added, so a file written
 * before is read again rather than shown with that field empty all day.
 */
export const DIGEST_VERSION = 3;

export interface TodayDigest {
  readonly version: number;
  /** ISO timestamp of the run. */
  readonly fetchedAt: string;
  /** The day the run asked about, `YYYY-MM-DD` local, so yesterday's digest is not shown as today's. */
  readonly day: string;
  readonly events: readonly DigestEvent[];
  readonly mail: readonly DigestMail[];
  /** How many mails the search matched in all, when the connector said. */
  readonly mailTotal: number | null;
  readonly chats: readonly DigestChat[];
  readonly errors: Readonly<Partial<Record<DigestSection, string>>>;
}

/** Everything the renderer needs about the digest. */
export interface TodayDigestState {
  readonly digest: TodayDigest | null;
  readonly running: boolean;
  /** ISO timestamp the current run started at, for the elapsed clock. */
  readonly startedAt: string | null;
  /** Why the last run produced nothing, naming the command. */
  readonly error: string | null;
}

/** One tool call of a run, as the transcript recorded it. */
export interface ToolCall {
  readonly name: string;
  readonly isError: boolean;
  /** Each text piece of the result. The connector puts one JSON object in each. */
  readonly pieces: readonly string[];
}

/**
 * The tool calls of a `stream-json` transcript, results included.
 *
 * Read from the transcript and never from the model's reply: given no tool, the model was measured
 * writing a call and a plausible result as plain text, fake ids included.
 */
export function readToolCalls(transcript: string): ToolCall[] {
  const names = new Map<string, string>();
  const calls: ToolCall[] = [];
  for (const line of transcript.split(/\r?\n/)) {
    if (!line.startsWith('{')) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event) || !isRecord(event['message'])) {
      continue;
    }
    const content = event['message']['content'];
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!isRecord(part)) {
        continue;
      }
      if (event['type'] === 'assistant' && part['type'] === 'tool_use') {
        if (typeof part['id'] === 'string' && typeof part['name'] === 'string') {
          names.set(part['id'], part['name']);
        }
      } else if (event['type'] === 'user' && part['type'] === 'tool_result') {
        const name =
          typeof part['tool_use_id'] === 'string' ? names.get(part['tool_use_id']) : undefined;
        if (name === undefined) {
          continue;
        }
        const value = part['content'];
        const pieces =
          typeof value === 'string'
            ? [value]
            : Array.isArray(value)
              ? value.flatMap((piece) =>
                  isRecord(piece) && typeof piece['text'] === 'string' ? [piece['text']] : [],
                )
              : [];
        calls.push({ name, isError: part['is_error'] === true, pieces });
      }
    }
  }
  return calls;
}

/**
 * The digest, out of a run's tool calls or out of the file it was stored in.
 *
 * Never throws, and only listed fields survive: the store re-reads its own file through here, so a
 * file edited by hand is held to the rules a fresh answer is.
 */
export function parseDigest(
  calls: readonly ToolCall[],
  fetchedAt: string,
  day: string,
): TodayDigest {
  const errors: Partial<Record<DigestSection, string>> = {};
  const me = firstRecord(findCall(calls, DIGEST_TOOLS.me));
  const myEmail = asText(me?.['mail']).toLowerCase();

  const calendar = readSection(calls, DIGEST_TOOLS.calendar, 'calendar', errors);
  const mail = readSection(calls, DIGEST_TOOLS.mail, 'mail', errors);
  const messages = readSection(calls, DIGEST_TOOLS.messages, 'teams', errors);
  const chats = recordsOf(findCall(calls, DIGEST_TOOLS.chats));

  return {
    version: DIGEST_VERSION,
    fetchedAt,
    day,
    events: calendar.items
      .map(readEvent)
      .filter((event): event is DigestEvent => event !== null && onDay(event, day)),
    mail: mail.items.map(readMail).filter((entry): entry is DigestMail => entry !== null),
    mailTotal: mail.total,
    chats: groupChats(messages.items, chats, myEmail),
    errors,
  };
}

/** Rebuilds a stored digest, or null when the file is not one. */
export function readStoredDigest(value: unknown): TodayDigest | null {
  if (
    !isRecord(value) ||
    value['version'] !== DIGEST_VERSION ||
    typeof value['fetchedAt'] !== 'string' ||
    typeof value['day'] !== 'string'
  ) {
    return null;
  }
  const events = arrayOf(value['events']).map(readStoredEvent).filter(isPresent);
  const mail = arrayOf(value['mail']).map(readStoredMail).filter(isPresent);
  const chats = arrayOf(value['chats']).map(readStoredChat).filter(isPresent);
  const errors: Partial<Record<DigestSection, string>> = {};
  const storedErrors = isRecord(value['errors']) ? value['errors'] : {};
  for (const section of ['calendar', 'mail', 'teams'] as const) {
    const message = storedErrors[section];
    if (typeof message === 'string' && message.length > 0) {
      errors[section] = message;
    }
  }
  return {
    version: DIGEST_VERSION,
    fetchedAt: value['fetchedAt'],
    day: value['day'],
    events,
    mail,
    mailTotal: typeof value['mailTotal'] === 'number' ? value['mailTotal'] : null,
    chats,
    errors,
  };
}

/** `YYYY-MM-DD` of a date, in the machine's own zone. */
export function localDay(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function findCall(calls: readonly ToolCall[], name: string): ToolCall | undefined {
  return calls.find((call) => call.name === name);
}

function readSection(
  calls: readonly ToolCall[],
  name: string,
  section: DigestSection,
  errors: Partial<Record<DigestSection, string>>,
): { items: Record<string, unknown>[]; total: number | null } {
  const call = findCall(calls, name);
  if (call === undefined) {
    errors[section] = 'Not read: the run did not make this call';
    return { items: [], total: null };
  }
  if (call.isError) {
    errors[section] = firstLine(call.pieces.join(' ')) || 'The connector refused the call';
    return { items: [], total: null };
  }
  const records = recordsOf(call);
  if (records.length === 0 && call.pieces.some((piece) => piece.trim().length > 0)) {
    // Text that is not JSON is the connector explaining itself ("No results", an auth error).
    const text = firstLine(call.pieces.join(' '));
    if (!/no (results|events|messages|emails)/i.test(text)) {
      errors[section] = text;
    }
  }
  // The paging marker is the one record without a `uri`: it carries the totals, not an item.
  const items = records.filter((record) => typeof record['uri'] === 'string');
  const marker = records.find((record) => typeof record['uri'] !== 'string');
  const total =
    typeof marker?.['totalResultCount'] === 'number' ? marker['totalResultCount'] : null;
  return { items, total };
}

function recordsOf(call: ToolCall | undefined): Record<string, unknown>[] {
  if (call === undefined || call.isError) {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const piece of call.pieces) {
    try {
      const parsed = JSON.parse(piece) as unknown;
      if (isRecord(parsed)) {
        out.push(parsed);
      } else if (Array.isArray(parsed)) {
        out.push(...parsed.filter(isRecord));
      }
    } catch {
      // Not JSON: the caller decides whether that text is an error.
    }
  }
  return out;
}

function firstRecord(call: ToolCall | undefined): Record<string, unknown> | undefined {
  return recordsOf(call)[0];
}

function readEvent(record: Record<string, unknown>): DigestEvent | null {
  const start = isRecord(record['start']) ? record['start'] : null;
  const end = isRecord(record['end']) ? record['end'] : null;
  const startAt = wallClock(start?.['dateTime']);
  const endAt = wallClock(end?.['dateTime']);
  if (startAt.length === 0) {
    return null;
  }
  return {
    subject: asText(record['subject']) || '(no subject)',
    start: startAt,
    end: endAt || startAt,
    timeZone: asText(start?.['timeZone']),
    isAllDay: record['isAllDay'] === true,
    isCancelled: record['isCancelled'] === true,
    showAs: asText(record['showAs']),
    location: locationOf(record['location']),
    url: httpUrl(record['webLink']),
  };
}

/**
 * Whether an event belongs to the day asked about.
 *
 * The search returns every event that overlaps the range, so a whole-day event that ended at
 * midnight this morning comes back too. All day: the day must fall in `[start, end)`. Otherwise
 * the event must end after the day starts, both read as wall-clock strings in the same zone.
 */
function onDay(event: DigestEvent, day: string): boolean {
  if (event.isAllDay) {
    return event.start.slice(0, 10) <= day && day < event.end.slice(0, 10);
  }
  return event.end > `${day}T00:00` && event.start.slice(0, 10) <= day;
}

function readMail(record: Record<string, unknown>): DigestMail | null {
  const receivedAt = asText(record['receivedDateTime']);
  if (receivedAt.length === 0) {
    return null;
  }
  return {
    subject: asText(record['subject']) || '(no subject)',
    sender: asText(record['sender']),
    receivedAt,
    isRead: record['isRead'] === true,
    important: record['importance'] === 'high',
    preview: textOf(record['summary']),
    url: httpUrl(record['webLink']),
  };
}

/**
 * The conversations where somebody else wrote last, with what they wrote since my last message.
 *
 * Only the messages the search returned are known, so a reply of mine older than the window does
 * not count: within it, the whole conversation is waiting. A conversation is named from the chat
 * list when it is there (its topic, or the other members), and from the sender otherwise.
 */
function groupChats(
  messages: readonly Record<string, unknown>[],
  chats: readonly Record<string, unknown>[],
  myEmail: string,
): DigestChat[] {
  const byId = new Map<string, (ChatLine & { readonly mine: boolean })[]>();
  for (const message of messages) {
    const from = isRecord(message['from']) ? message['from'] : {};
    const fromEmail = asText(from['email']).toLowerCase();
    const at = asText(message['createdDateTime']);
    const chatId =
      asText(message['chatId']) || asText(message['chatUri']) || asText(message['uri']);
    if (at.length === 0 || chatId.length === 0) {
      continue;
    }
    const lines = byId.get(chatId) ?? [];
    const name = asText(from['displayName']) || fromEmail;
    lines.push({
      mine: myEmail.length > 0 && fromEmail === myEmail,
      from: name,
      at,
      text: lineText(textOf(message['summary']) || textOf(message['subject']), name),
      url: httpUrl(message['webUrl']),
    });
    byId.set(chatId, lines);
  }

  const out: DigestChat[] = [];
  for (const [chatId, lines] of byId) {
    lines.sort((left, right) => left.at.localeCompare(right.at));
    const lastMine = lines.map((line) => line.mine).lastIndexOf(true);
    const waiting = lines.slice(lastMine + 1);
    const last = waiting[waiting.length - 1];
    if (last === undefined) {
      continue;
    }
    out.push({
      chatId,
      title:
        chatTitle(
          chats.find((chat) => chat['id'] === chatId),
          myEmail,
        ) || last.from,
      count: waiting.length,
      lastFrom: last.from,
      lastAt: last.at,
      preview: last.text,
      url: last.url,
      lines: waiting
        .slice(-LINES_PER_CHAT)
        .map(({ from, at, text, url }) => ({ from, at, text, url })),
    });
  }
  return out.sort((left, right) => right.lastAt.localeCompare(left.lastAt));
}

function chatTitle(chat: Record<string, unknown> | undefined, myEmail: string): string {
  if (chat === undefined) {
    return '';
  }
  const topic = asText(chat['topic']);
  if (topic.length > 0) {
    return topic;
  }
  const others = arrayOf(chat['members'])
    .filter(isRecord)
    .filter((member) => asText(member['email']).toLowerCase() !== myEmail)
    .map((member) => asText(member['displayName']))
    .filter((name) => name.length > 0);
  return others.slice(0, 3).join(', ') + (others.length > 3 ? ` +${others.length - 3}` : '');
}

/**
 * What a chat message says, without the sender's name the search puts in front of some summaries,
 * which the card already shows in bold. A message with no text is an attachment or a card.
 */
function lineText(text: string, from: string): string {
  const body = from.length > 0 && text.startsWith(`${from} `) ? text.slice(from.length + 1) : text;
  return body.length > 0 ? body : '(attachment or card)';
}

/** A body preview on one line, cut at 300 characters: the card shows it, the link opens the rest. */
function textOf(value: unknown): string {
  return asText(value).replace(/\s+/g, ' ').slice(0, 300);
}

function locationOf(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (isRecord(value)) {
    return asText(value['displayName']);
  }
  return '';
}

/** `2026-10-20T09:30:00.0000000` to `2026-10-20T09:30`, or empty when it is not that shape. */
function wallClock(value: unknown): string {
  const text = asText(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? text.slice(0, 16) : '';
}

/** Only an http(s) link is kept: it ends up behind a click that opens the browser. */
function httpUrl(value: unknown): string {
  const text = asText(value);
  return /^https?:\/\//i.test(text) ? text : '';
}

function readStoredEvent(value: unknown): DigestEvent | null {
  if (!isRecord(value) || typeof value['start'] !== 'string' || value['start'].length === 0) {
    return null;
  }
  return {
    subject: asText(value['subject']),
    start: value['start'],
    end: asText(value['end']) || value['start'],
    timeZone: asText(value['timeZone']),
    isAllDay: value['isAllDay'] === true,
    isCancelled: value['isCancelled'] === true,
    showAs: asText(value['showAs']),
    location: asText(value['location']),
    url: httpUrl(value['url']),
  };
}

function readStoredMail(value: unknown): DigestMail | null {
  if (!isRecord(value) || typeof value['receivedAt'] !== 'string') {
    return null;
  }
  return {
    subject: asText(value['subject']),
    sender: asText(value['sender']),
    receivedAt: value['receivedAt'],
    isRead: value['isRead'] === true,
    important: value['important'] === true,
    preview: textOf(value['preview']),
    url: httpUrl(value['url']),
  };
}

function readStoredChat(value: unknown): DigestChat | null {
  if (
    !isRecord(value) ||
    typeof value['chatId'] !== 'string' ||
    typeof value['lastAt'] !== 'string'
  ) {
    return null;
  }
  return {
    chatId: value['chatId'],
    title: asText(value['title']),
    count:
      typeof value['count'] === 'number' && value['count'] > 0 ? Math.floor(value['count']) : 1,
    lastFrom: asText(value['lastFrom']),
    lastAt: value['lastAt'],
    preview: textOf(value['preview']),
    url: httpUrl(value['url']),
    lines: arrayOf(value['lines'])
      .filter(isRecord)
      .filter((line) => typeof line['at'] === 'string')
      .slice(-LINES_PER_CHAT)
      .map((line) => ({
        from: asText(line['from']),
        at: asText(line['at']),
        text: textOf(line['text']),
        url: httpUrl(line['url']),
      })),
  };
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
