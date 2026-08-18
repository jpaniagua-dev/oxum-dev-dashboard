import { describe, expect, it } from 'vitest';
import { pickStoryPointField } from '../src/main/jira/jira-service.js';
import {
  describeStart,
  nearestStoryPoints,
  pickActiveSprint,
  pickStartTransition,
  type StartReport,
} from '../src/main/jira/jira-start.js';
import type { IssueTransition, Sprint } from '../src/shared/contracts.js';

const sprint = (id: number, name: string, state: string): Sprint => ({
  id,
  name,
  state,
  boardName: 'Board',
});

describe('pickActiveSprint', () => {
  it('reads the state and never the position in the list', () => {
    // `listSprints` sorts active first for display. Relying on that ordering would make this silently
    // wrong the day the sort changes for a display reason, and a ticket would land in another iteration.
    const sprints = [sprint(2, 'Sprint 2', 'future'), sprint(1, 'Sprint 1', 'active')];
    expect(pickActiveSprint(sprints)?.id).toBe(1);
  });

  it('reports no active sprint rather than falling back to the next one', () => {
    // A board between sprints is a real situation. Moving a ticket into a sprint nobody has started is
    // not what "the current sprint" means, so the step is skipped and said to be skipped.
    expect(pickActiveSprint([sprint(3, 'Sprint 3', 'future')])).toBeNull();
    expect(pickActiveSprint([])).toBeNull();
  });
});

describe('pickStartTransition', () => {
  const transition = (id: string, label: string, stage: IssueTransition['stage']): IssueTransition => ({
    id,
    label,
    stage,
  });

  it('chooses by category, so a status named in any language still matches', () => {
    // The whole reason the category travels with the transition: a board that calls it "Développement"
    // has no in-progress transition at all as far as name matching is concerned.
    const transitions = [
      transition('11', 'À faire', 'todo'),
      transition('21', 'Développement', 'in-progress'),
      transition('31', 'Terminé', 'done'),
    ];
    expect(pickStartTransition(transitions)?.id).toBe('21');
  });

  it('prefers the destination that says in progress when a workflow offers several', () => {
    // A board that can go straight to review has two indeterminate destinations. Jira's own order is a
    // defensible answer, but the one that actually says it is a better one.
    const transitions = [
      transition('41', 'In review', 'in-progress'),
      transition('21', 'In progress', 'in-progress'),
    ];
    expect(pickStartTransition(transitions)?.id).toBe('21');
  });

  it('takes the first in workflow order when no name helps', () => {
    const transitions = [
      transition('41', 'Ready for QA', 'in-progress'),
      transition('51', 'Staged', 'in-progress'),
    ];
    expect(pickStartTransition(transitions)?.id).toBe('41');
  });

  it('returns nothing when the workflow offers no in-progress move', () => {
    // The common case is a ticket already in progress, which is the state that was asked for, so this is
    // a skip and not a failure. A workflow needing two steps lands here too, and must not be guessed at.
    expect(pickStartTransition([transition('31', 'Done', 'done')])).toBeNull();
    expect(pickStartTransition([])).toBeNull();
  });
});

describe('nearestStoryPoints', () => {
  it('keeps a value already on the scale', () => {
    expect(nearestStoryPoints(1)).toBe(1);
    expect(nearestStoryPoints(8)).toBe(8);
    expect(nearestStoryPoints(21)).toBe(21);
  });

  it('snaps a value the scale does not carry', () => {
    // A model handed a numeric field answers 4, 6 or 7.5 often enough that this has to be handled.
    expect(nearestStoryPoints(6)).toBe(5);
    expect(nearestStoryPoints(7.5)).toBe(8);
    expect(nearestStoryPoints(30)).toBe(21);
  });

  it('breaks a tie upwards', () => {
    // 4 sits exactly between 3 and 5. An estimate nobody was sure about costs less over-promised than
    // under-promised, so the larger point wins.
    expect(nearestStoryPoints(4)).toBe(5);
  });

  it('reads a numeric string, which is what JSON sometimes carries', () => {
    expect(nearestStoryPoints('3')).toBe(3);
  });

  it('refuses anything that is not a positive number rather than defaulting', () => {
    // There is no safe default: the number is written to a ticket and planned against, so "no estimate"
    // has to stay expressible. Zero is the value the prompt tells the model to use for exactly that.
    expect(nearestStoryPoints(0)).toBeNull();
    expect(nearestStoryPoints(-3)).toBeNull();
    expect(nearestStoryPoints('big')).toBeNull();
    expect(nearestStoryPoints(undefined)).toBeNull();
    expect(nearestStoryPoints(null)).toBeNull();
  });
});

describe('pickStoryPointField', () => {
  it('prefers the team-managed built-in over a custom field of the same meaning', () => {
    // A site can carry both, and only one of them is the field the board adds up.
    const body = [
      { id: 'customfield_10016', name: 'Story Points', schema: { type: 'number' } },
      { id: 'customfield_10020', name: 'Story point estimate', schema: { type: 'number' } },
    ];
    expect(pickStoryPointField(body)).toBe('customfield_10020');
  });

  it('ignores a same-named field that is not numeric', () => {
    // A text field left behind by an import. A PUT of a number into it either fails or stores something
    // the board cannot sum.
    const body = [{ id: 'customfield_10016', name: 'Story Points', schema: { type: 'string' } }];
    expect(pickStoryPointField(body)).toBeNull();
  });

  it('reports nothing rather than guessing a customfield number', () => {
    // The id is allocated per site: there is no number to fall back to, and the caller skips the estimate.
    expect(pickStoryPointField([{ id: 'summary', name: 'Summary' }])).toBeNull();
    expect(pickStoryPointField(null)).toBeNull();
  });
});

describe('describeStart', () => {
  const report = (over: Partial<StartReport> = {}): StartReport => ({
    key: 'PROJ-1',
    done: [],
    skipped: [],
    failed: [],
    ...over,
  });

  it('says nothing happened when nothing was asked', () => {
    expect(describeStart([])).toBe('');
  });

  it('confirms a clean run in one line', () => {
    expect(describeStart([report({ done: ['assigned to you'] })])).toBe('Jira updated');
    expect(describeStart([report(), report({ key: 'PROJ-2' })])).toBe('Jira updated for 2 tickets');
  });

  it('names failures and counts them, because the writes happened out of sight', () => {
    // A ticket assigned but never moved is one you have to go and look at, so "some writes failed"
    // would be useless: the point of reporting at all is knowing which ticket and which step.
    const message = describeStart([
      report({ done: ['assigned to you'], failed: ['sprint: Forbidden'] }),
      report({ key: 'PROJ-2', done: ['assigned to you'] }),
    ]);
    expect(message).toContain('1 of 2');
    expect(message).toContain('PROJ-1 (sprint: Forbidden)');
  });

  it('collapses one skip reason shared by every ticket', () => {
    // Eight tickets skipping the estimate for the same missing field is one fact; repeating it eight
    // times buries whatever else is on the line.
    const skipped = ['estimate (this site has no story point field)'];
    expect(describeStart([report({ skipped }), report({ key: 'PROJ-2', skipped })])).toBe(
      'Jira updated for 2 tickets, except estimate (this site has no story point field)',
    );
  });

  it('lets a failure hide an expected skip rather than the other way round', () => {
    // A skip is something the tab knew it could not do; a failure is something that went wrong. Only one
    // of the two is worth the width when both are present.
    const message = describeStart([
      report({ failed: ['status: Forbidden'], skipped: ['estimate (the analysis gave none)'] }),
    ]);
    expect(message).toContain('status: Forbidden');
    expect(message).not.toContain('the analysis gave none');
  });
});
