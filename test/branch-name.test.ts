import { describe, expect, it } from 'vitest';
import { MAX_SLUG_LENGTH, branchNameFor } from '../src/shared/branch-name.js';

/**
 * The name a ticket's branch gets, which two sides have to agree on.
 *
 * The main process creates the branch and the Jira tab's menu names it beforehand, so a disagreement
 * here is a menu promising one branch while the checkout makes another. That is the reason this is a
 * shared pure function and the reason it is tested rather than eyeballed.
 */
describe('branchNameFor', () => {
  it('builds KEY-slug, the shape the team already writes by hand', () => {
    expect(branchNameFor('PROJ-123', 'Migrate to Angular 22')).toBe('PROJ-123-migrate-to-angular-22');
  });

  it('uppercases the key and lowercases the slug', () => {
    // Not cosmetic: a branch differing only by case is a different branch on Linux and the same one
    // on Windows, which is the worst of both. Jira hands the key back in whatever case it was asked.
    expect(branchNameFor('proj-9', 'Fix The Thing')).toBe('PROJ-9-fix-the-thing');
  });

  it('collapses punctuation into single hyphens', () => {
    expect(branchNameFor('PROJ-1', 'Fix: the "user" (again) & really!')).toBe(
      'PROJ-1-fix-the-user-again-really',
    );
  });

  it('never ends on a hyphen, including when the cut lands on one', () => {
    // The slice happens before the final trim precisely so a cut on a separator does not leave the
    // hyphen behind. A trailing hyphen is a name git accepts and nobody wants to retype.
    const summary = `${'a'.repeat(MAX_SLUG_LENGTH - 1)} bbbb`;
    const name = branchNameFor('PROJ-1', summary);
    expect(name.endsWith('-')).toBe(false);
    expect(name.startsWith('PROJ-1-')).toBe(true);
  });

  it('caps the slug so the name stays typable', () => {
    const name = branchNameFor('PROJ-1', 'one two three four five six seven eight nine ten eleven');
    // The key and its separator, plus at most the cap.
    expect(name.length).toBeLessThanOrEqual('PROJ-1-'.length + MAX_SLUG_LENGTH);
  });

  it('falls back to the bare key when the summary yields nothing', () => {
    // A summary made only of punctuation would otherwise produce `PROJ-1-`, and an empty one the same.
    // The bare key is a perfectly usable branch name.
    expect(branchNameFor('PROJ-1', '!!! ...')).toBe('PROJ-1');
    expect(branchNameFor('PROJ-1', '')).toBe('PROJ-1');
    expect(branchNameFor('PROJ-1', '   ')).toBe('PROJ-1');
  });

  it('drops accents and non-latin characters rather than passing them through', () => {
    // Summaries are written in French here. Anything not a letter or a digit becomes a separator, so
    // the result stays something a person can retype on any keyboard.
    expect(branchNameFor('PROJ-7', 'Créer la période fiscale')).toBe('PROJ-7-cr-er-la-p-riode-fiscale');
  });

  it('trims the key, which arrives from a payload rather than from a form', () => {
    expect(branchNameFor('  PROJ-4  ', 'Something')).toBe('PROJ-4-something');
  });
});
