import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readTagWorkflows,
  tagMatches,
  tagTriggersIn,
  workflowsForTag,
  type TagWorkflow,
} from '../src/main/git/tag-workflows.js';

describe('tagTriggersIn', () => {
  it("reads this repository's own release trigger", () => {
    // The case the confirmation exists for: pushing v* here builds and publishes a release.
    const yaml = readFileSync(join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');

    expect(tagTriggersIn(yaml)).toEqual(['v*']);
  });

  it('reads tags given as a block list, quoted or not, comments aside', () => {
    const yaml = [
      'name: Publish',
      'on:',
      '  push:',
      '    tags:',
      "      - 'v*'   # releases",
      '      - release-*',
      '  workflow_dispatch:',
    ].join('\n');

    expect(tagTriggersIn(yaml)).toEqual(['v*', 'release-*']);
  });

  it('counts a bare push as every tag, in each of its spellings', () => {
    expect(tagTriggersIn('on: push\n')).toBe('any');
    expect(tagTriggersIn('on: [push, pull_request]\n')).toBe('any');
    expect(tagTriggersIn('on:\n  push:\n  pull_request:\n')).toBe('any');
    expect(tagTriggersIn('"on":\n  push: {}\n')).toBe('any');
  });

  it('does not count a push filtered on branches only, which GitHub skips for tags', () => {
    expect(tagTriggersIn('on:\n  push:\n    branches: [main]\n')).toBeNull();
  });

  it('reads tags-ignore as any tag, the cautious answer', () => {
    expect(tagTriggersIn('on:\n  push:\n    tags-ignore: [nightly]\n')).toBe('any');
  });

  it('ignores workflows that do not run on push at all', () => {
    expect(tagTriggersIn('on:\n  pull_request:\n    branches: [main]\n')).toBeNull();
    expect(tagTriggersIn('on: workflow_dispatch\n')).toBeNull();
    expect(tagTriggersIn('name: no trigger\n')).toBeNull();
  });
});

describe('tagMatches', () => {
  it('follows the filter syntax GitHub documents', () => {
    expect(tagMatches('v*', 'v11.0.0')).toBe(true);
    expect(tagMatches('v*', 'release-1')).toBe(false);
    expect(tagMatches('v[12].*', 'v2.0')).toBe(true);
    expect(tagMatches('v[12].*', 'v3.0')).toBe(false);
    // `*` stops at a slash, `**` does not.
    expect(tagMatches('release/*', 'release/a/b')).toBe(false);
    expect(tagMatches('release/**', 'release/a/b')).toBe(true);
    // A dot is literal, not "any character".
    expect(tagMatches('v1.0', 'v1x0')).toBe(false);
  });
});

describe('workflowsForTag', () => {
  const release: TagWorkflow = {
    file: 'release.yml',
    name: 'Release',
    patterns: ['v*', '!v*-rc*'],
  };
  const anything: TagWorkflow = { file: 'ci.yml', name: 'CI', patterns: 'any' };

  it('keeps the workflows a tag starts, a later negation winning over an earlier pattern', () => {
    expect(workflowsForTag([release, anything], 'v2.0.0').map((w) => w.file)).toEqual([
      'release.yml',
      'ci.yml',
    ]);
    expect(workflowsForTag([release], 'v2.0.0-rc1')).toEqual([]);
    expect(workflowsForTag([release], 'nightly')).toEqual([]);
  });
});

describe('readTagWorkflows', () => {
  it('reads the workflows folder, names each one, and skips those tags do not start', () => {
    const repo = mkdtempSync(join(tmpdir(), 'oxum-workflows-'));
    try {
      const folder = join(repo, '.github', 'workflows');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'release.yml'), "name: Release\non:\n  push:\n    tags: ['v*']\n");
      writeFileSync(join(folder, 'pr.yaml'), 'name: PR\non:\n  pull_request:\n');
      writeFileSync(join(folder, 'notes.txt'), 'on: push\n');

      expect(readTagWorkflows(repo)).toEqual([
        { file: 'release.yml', name: 'Release', patterns: ['v*'] },
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reads a repository with no workflows as none', () => {
    expect(readTagWorkflows(tmpdir())).toEqual([]);
  });
});
