import {
  AUTONOMY_MAX_POINTS,
  DESCRIPTION_TRUNCATED_MARK,
  STORY_POINT_SCALE,
} from '@shared/contracts.js';

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
    'You are triaging a sprint for a developer who works on both the front-end and the back-end of',
    'these projects, deciding what can be built right now.',
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
    '- "unclear": the description does not contain enough to act on. A ticket that only says "to be',
    '  discussed", or that is nothing but a screenshot, belongs here rather than in "needs-decision":',
    '  the fix is a sentence of specification, not an arbitration.',
    '- "blocked": stopped by something else, such as being on hold, or waiting on another ticket.',
    '',
    'A ticket that is mostly buildable with one blocked point is "needs-decision", not "ready":',
    'a verdict of "ready" is a promise that clicking it starts work, and a wrong promise there is',
    'worse than a cautious one.',
    '',
    'A ticket the front-end cannot build because an endpoint or a field does not exist yet is',
    '"blocked", and not a verdict of its own: name the missing field or endpoint in "reason". A ticket',
    'whose work simply belongs to a server is judged like any other, "ready" when it is specified and',
    'buildable, and the server side is said in "domain" rather than in the verdict. Those two used to',
    'share one label and they are not the same answer: one stops being true the day somebody ships an',
    'endpoint, the other never does.',
    '',
    'Say which side of the stack each ticket is on, in "domain", using exactly one of:',
    '',
    '- "front-end": the change lives in a client application and needs no server change.',
    '- "backend": the change lives in a service or its database and needs no client change.',
    '- "full-stack": it needs both, in the same ticket.',
    '- "unknown": you cannot tell from what you were given. Answer this rather than guessing: a wrong',
    '  side is worse than no side, because it decides which workflow an unattended run would follow.',
    '',
    'Answer "autonomous" as well, true or false: whether an agent could take this ticket from the',
    'board to an open pull request with nobody looking at anything in between.',
    '',
    'The run it would perform, end to end and without stopping to ask: move the ticket to in progress',
    'in Jira, create a worktree and a branch, write the code, check it against the existing tests, the',
    'lint and the build, and for a front-end ticket render it on a dev server, then commit, push, open',
    'a pull request with the usual reviewers, and for a front-end ticket announce it in the team chat.',
    '',
    'Answer true only when every one of these holds:',
    '',
    '- Nothing is left to decide. No option to arbitrate, no wording to choose, no mockup to wait for.',
    '- Everything needed is in the ticket or in the code you can read. No credential, no data set, no',
    '  environment and no third-party access that is not already there.',
    '- The result can be checked by the agent itself: an existing test, a type check, a build, or a',
    '  page it can open on the dev server. A ticket whose only proof of success is somebody looking at',
    '  it and saying it feels right is not autonomous.',
    '- No visual or editorial judgement. "Add the column X with the label Y" is autonomous, "improve',
    '  the layout of this screen" is not, however small it is.',
    '- One repository. The workflow makes one branch and one pull request, so a change that has to land',
    '  in two places at once is not autonomous even when both halves are obvious.',
    '- No step a human has to perform anyway: a migration to run by hand, a secret to set, a',
    '  deployment, a message to write.',
    '- Nothing destructive that closing the pull request would not undo.',
    `- It is worth ${AUTONOMY_MAX_POINTS} story points or fewer on the scale below.`,
    '',
    'A pull request opened this way is still read by a reviewer: what "autonomous" removes is the',
    'checking in during the work, not the review at the end. Answer false whenever you hesitate. A',
    'ticket wrongly marked false costs one click; a ticket wrongly marked true costs an afternoon of',
    'somebody unpicking a branch nobody watched.',
    '',
    'Estimate every ticket in story points as well, on this scale and no other value:',
    `${STORY_POINT_SCALE.join(', ')}.`,
    '',
    'Read the scale as effort for one developer on the side of the stack the ticket is on,',
    'uncertainty included: 1 is a change with one obvious place to make it, 3 is a day of work with no',
    'unknown, 8 is a feature spanning',
    'several screens or one whose shape is still fuzzy, and 21 is a ticket to split rather than',
    'start. Estimate the work the ticket describes even when the verdict is not "ready": what a',
    'blocked ticket will cost once it is unblocked is exactly what makes it worth scheduling. Answer',
    '0 only when there is genuinely nothing to size, and it will be read as "no estimate".',
    '',
    'Answer with JSON only, no prose around it, no code fence:',
    '',
    '[{"key":"PROJ-123","verdict":"ready","domain":"front-end","autonomous":true,' +
      '"reason":"one sentence","question":"","next":"","estimate":3}]',
    '',
    '"reason" is one sentence saying what the verdict rests on.',
    '"domain" is one of the four sides above.',
    '"autonomous" is true or false, against the criteria above.',
    '"question" is filled only for "needs-decision", empty otherwise.',
    '"next" says what answering the question, or lifting the blocker, sets in motion: who does',
    'what, and whether it is a front-end change or work for someone else. That is the half that',
    'makes a question worth reading rather than postponing. One sentence, empty for "ready".',
    '"estimate" is one number from the scale above.',
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
  return `${text.slice(0, DESCRIPTION_LIMIT)}\n${DESCRIPTION_TRUNCATED_MARK}`;
}
