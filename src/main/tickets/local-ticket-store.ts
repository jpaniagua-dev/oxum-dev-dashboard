import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IssueStage } from '@shared/contracts.js';
import {
  LOCAL_STAGES,
  nextTicketKey,
  parseTicket,
  serializeTicket,
  splitTicketFile,
  ticketDraftProblem,
  ticketFileName,
  type LocalTicket,
  type LocalTicketDraft,
  type LocalTicketsState,
} from '@shared/local-tickets.js';

/**
 * The local tickets on disk: a folder of Markdown files.
 *
 * Read whole on every call. The folder is small, and it is edited by hand and by agents as well as
 * by this app, so a cached list would be a list that disagrees with the files the moment somebody
 * saves one in an editor.
 */
export class LocalTicketStore {
  /** The highest number ever handed out this session, so a key is not reused within it. */
  private issued = 0;

  constructor(private readonly folder: () => string) {}

  async read(): Promise<LocalTicketsState> {
    const dir = this.folder();
    const tickets: LocalTicket[] = [];
    const problems: string[] = [];
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.md'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        problems.push(`${dir}: ${(error as Error).message}`);
      }
    }
    const seen = new Set<string>();
    for (const name of names.sort()) {
      const file = join(dir, name);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        problems.push(`${name}: ${(error as Error).message}`);
        continue;
      }
      const ticket = parseTicket(text, file);
      if (typeof ticket === 'string') {
        problems.push(`${name}: ${ticket}`);
        continue;
      }
      if (seen.has(ticket.key)) {
        // Shown as a problem rather than picked: which of the two is the ticket is the reader's call.
        problems.push(`${name}: ${ticket.key} is already used by another file`);
        continue;
      }
      seen.add(ticket.key);
      tickets.push(ticket);
    }
    return { dir, tickets, problems };
  }

  async create(draft: LocalTicketDraft): Promise<LocalTicket> {
    const problem = ticketDraftProblem(draft);
    if (problem !== null) {
      throw new Error(problem);
    }
    const dir = this.folder();
    await mkdir(dir, { recursive: true });
    const state = await this.read();
    const key = nextTicketKey(
      state.tickets.map((ticket) => ticket.key),
      this.issued,
    );
    this.issued = Number(key.split('-')[1]);
    const now = new Date().toISOString();
    const ticket = {
      key,
      summary: draft.summary,
      type: draft.type,
      stage: draft.stage,
      created: now,
      updated: now,
    };
    const file = join(dir, ticketFileName(key, draft.summary));
    const body = draft.description.trim().length > 0 ? `${draft.description.trim()}\n` : '';
    // `wx`: a file already there under that name is never overwritten.
    await writeFile(file, serializeTicket(ticket, body), { encoding: 'utf8', flag: 'wx' });
    return { ...ticket, file };
  }

  /** Moves a ticket to another column. Only its frontmatter changes; the body is kept as written. */
  async move(key: string, stage: IssueStage): Promise<LocalTicket> {
    if (!LOCAL_STAGES.includes(stage)) {
      throw new Error('That column does not exist');
    }
    const ticket = await this.find(key);
    const text = await readFile(ticket.file, 'utf8');
    const parts = splitTicketFile(text);
    if (parts === null) {
      throw new Error(`${ticket.file} lost its frontmatter`);
    }
    const next = { ...ticket, stage, updated: new Date().toISOString() };
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const temp = `${ticket.file}.${process.pid}.tmp`;
    // The header is rewritten in the file's own line endings, the body appended exactly as read.
    await writeFile(temp, serializeTicket(next, '').replace(/\n/g, eol) + parts.body, 'utf8');
    await rename(temp, ticket.file);
    return next;
  }

  async find(key: string): Promise<LocalTicket> {
    const ticket = (await this.read()).tickets.find((entry) => entry.key === key);
    if (ticket === undefined) {
      throw new Error(`${key} is no longer in ${this.folder()}`);
    }
    return ticket;
  }
}
