/**
 * The prompt handed to the headless Claude Code run, and the shape of what it is asked to send back.
 *
 * Kept pure and separate from the process launch so it can be read and tested without spawning
 * anything: the prompt IS the contract with the model, and a silent change to it changes every
 * verdict the tab shows.
 */

/** One ticket as it goes into the prompt. Descriptions are long, so they are capped per ticket. */
export interface PromptTicket {
  readonly key: string;
  readonly summary: string;
  readonly status: string;
  readonly assignee: string;
  readonly description: string;
}

/**
 * How much of a description reaches the model.
 *
 * A consolidated story runs to a couple of thousand characters and the tail is usually its
 * "Sources" section; twenty of them uncapped is a prompt nobody can afford. The cut is announced in
 * the text so the model knows it is reading an extract rather than a short ticket.
 */
export const DESCRIPTION_LIMIT = 1200;

export function buildTriagePrompt(sprintName: string, tickets: readonly PromptTicket[]): string {
  return [
    'You are triaging a sprint for a front-end developer, deciding what can be built right now.',
    '',
    `Sprint: ${sprintName}`,
    `Tickets: ${tickets.length}`,
    '',
    'You may read the code in the working directory to check a claim before making it. Prefer',
    'reading over guessing: whether a column can be added usually depends on whether the API',
    'exposes the field, and the schema is on disk. Do not write, run or change anything.',
    '',
    'Classify every ticket into exactly one verdict:',
    '',
    '- "ready": buildable now. The specification is unambiguous, the code and the data it needs',
    '  already exist, and no human decision is pending.',
    '- "needs-decision": buildable, but a question has to be answered first. Use this when the',
    '  ticket offers two options, asks for a mockup or a validation, or leaves an ambiguity that',
    '  would change the result. Put the question in the "question" field, closed and answerable in',
    '  one line.',
    '- "backend": the front-end cannot do it because the API does not expose what it needs, or the',
    '  work belongs to a server. Name the missing field or endpoint in "reason" when you found it.',
    '- "unclear": the description does not contain enough to act on. A ticket that only says "to be',
    '  discussed", or that is nothing but a screenshot, belongs here rather than in "needs-decision":',
    '  the fix is a sentence of specification, not an arbitration.',
    '- "blocked": stopped by something else, such as being on hold, or waiting on another ticket.',
    '',
    'A ticket that is mostly buildable with one blocked point is "needs-decision", not "ready":',
    'a verdict of "ready" is a promise that clicking it starts work, and a wrong promise there is',
    'worse than a cautious one.',
    '',
    'Answer with JSON only, no prose around it, no code fence:',
    '',
    '[{"key":"PROJ-123","verdict":"ready","reason":"one sentence","question":""}]',
    '',
    '"reason" is one sentence. "question" is filled only for "needs-decision", empty otherwise.',
    'Include every ticket exactly once, using the keys exactly as given.',
    '',
    'Tickets:',
    '',
    ...tickets.map(describeTicket),
  ].join('\n');
}

function describeTicket(ticket: PromptTicket): string {
  const description = trimDescription(ticket.description);
  return [
    `## ${ticket.key}: ${ticket.summary}`,
    `Status: ${ticket.status}`,
    `Assignee: ${ticket.assignee.length > 0 ? ticket.assignee : 'unassigned'}`,
    description.length > 0 ? description : '(no description)',
    '',
  ].join('\n');
}

/** Cuts a description to the budget, saying so, so the model does not read an extract as the whole. */
export function trimDescription(description: string): string {
  const text = description.trim();
  if (text.length <= DESCRIPTION_LIMIT) {
    return text;
  }
  return `${text.slice(0, DESCRIPTION_LIMIT)}\n[description truncated]`;
}
