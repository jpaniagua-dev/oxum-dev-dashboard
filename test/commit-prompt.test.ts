import { describe, expect, it } from 'vitest';
import {
  MAX_DIFF_CHARS,
  buildCommitPrompt,
  capDiff,
  readCommitMessage,
} from '../src/main/git/commit-prompt.js';

const BASE = {
  diff: 'diff --git a/src/a.ts b/src/a.ts\n+const a = 1;\n',
  recentSubjects: ['PROJ-1: add the list', 'PROJ-2: fix the sort'],
  branch: 'PROJ-3-thousands-separator',
  amend: false,
};

describe('buildCommitPrompt', () => {
  it('names the branch, which is where a ticket key actually lives', () => {
    // A convention wanting `PROJ-123: ...` cannot be followed from a diff: the key is in the branch
    // name and nowhere else in what the run is given.
    expect(buildCommitPrompt(BASE)).toContain('Branch: PROJ-3-thousands-separator');
  });

  it('tells the run to follow the repository\'s own conventions', () => {
    // The load-bearing sentence: the run starts in the repository, so its CLAUDE.md is already
    // loaded, and this is what makes the app follow a convention it has never read.
    expect(buildCommitPrompt(BASE)).toContain('CLAUDE.md');
  });

  it('shows recent subjects as form only, never as content to reuse', () => {
    const prompt = buildCommitPrompt(BASE);
    expect(prompt).toContain('- PROJ-1: add the list');
    expect(prompt).toContain('examples of form only');
  });

  it('drops the subject section entirely for a repository with no commits', () => {
    // Rather than an empty heading: a section announcing examples and listing none reads as "there is
    // no convention here", which is a claim this has no business making.
    const prompt = buildCommitPrompt({ ...BASE, recentSubjects: [] });
    expect(prompt).not.toContain('examples of form only');
  });

  it('asks for the message alone, since the answer goes straight into a textarea', () => {
    const prompt = buildCommitPrompt(BASE);
    expect(prompt).toContain('no preamble');
    expect(prompt).toContain('no code fence');
  });

  it('forbids any signature or attribution', () => {
    expect(buildCommitPrompt(BASE)).toContain('Do not sign the message');
  });

  it('says the message replaces the last commit when amending', () => {
    expect(buildCommitPrompt({ ...BASE, amend: true })).toContain('replaces the last commit');
    expect(buildCommitPrompt(BASE)).toContain('for the staged changes');
  });

  it('announces a truncated diff rather than truncating it silently', () => {
    // A run told it is looking at part of a change describes the part it saw. One that believes it has
    // everything writes a confident summary of a fraction, which is the failure worth paying a line for.
    const prompt = buildCommitPrompt({ ...BASE, diff: 'x'.repeat(MAX_DIFF_CHARS + 10) });
    expect(prompt).toContain('truncated');
  });

  it('says nothing about truncation when there was none', () => {
    expect(buildCommitPrompt(BASE)).not.toContain('truncated');
  });
});

describe('capDiff', () => {
  it('leaves a diff that fits exactly at the limit alone', () => {
    const exact = 'x'.repeat(MAX_DIFF_CHARS);
    expect(capDiff(exact)).toEqual({ text: exact, truncated: false });
  });

  it('cuts at the limit and reports it', () => {
    const result = capDiff('x'.repeat(MAX_DIFF_CHARS + 1));
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(MAX_DIFF_CHARS);
  });
});

describe('readCommitMessage', () => {
  it('keeps a subject, a blank line and a body', () => {
    // The blank line is the body separator; a cleanup that collapsed it would turn a message into one
    // long subject as far as git is concerned.
    expect(readCommitMessage('PROJ-3: separate thousands\n\nThe list read as one number.')).toBe(
      'PROJ-3: separate thousands\n\nThe list read as one number.',
    );
  });

  it('unwraps a fence that surrounds the whole answer', () => {
    expect(readCommitMessage('```\nPROJ-3: separate thousands\n```')).toBe(
      'PROJ-3: separate thousands',
    );
    expect(readCommitMessage('```text\nPROJ-3: separate thousands\n```')).toBe(
      'PROJ-3: separate thousands',
    );
  });

  it('leaves a fence in the middle alone, that being body content', () => {
    const message = 'PROJ-3: separate thousands\n\nBefore:\n```\n1000\n```';
    expect(readCommitMessage(message)).toBe(message);
  });

  it('refuses an empty answer instead of clearing the draft', () => {
    expect(readCommitMessage('   \n  ')).toBeNull();
  });

  it('refuses an answer too long to be a commit message', () => {
    // A clean run that answered with an essay about the diff. Reported rather than pasted, the
    // textarea possibly holding something worth keeping.
    expect(readCommitMessage('x'.repeat(5000))).toBeNull();
  });

  it('strips trailing spaces without touching the blank line between paragraphs', () => {
    expect(readCommitMessage('subject   \n\nbody   ')).toBe('subject\n\nbody');
  });
});
