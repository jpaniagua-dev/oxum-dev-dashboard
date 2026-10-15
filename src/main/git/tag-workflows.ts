import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Which GitHub Actions workflows a pushed tag would start.
 *
 * Read so the confirmation in front of a tag push can say "this starts release.yml" instead of a
 * generic warning: on this very repository, pushing `v*` builds and publishes a release. There is no
 * YAML parser in the app and one is not worth adding for this, so the reading is a **deliberately
 * narrow** look at the one block that matters, `on: push`, and it errs on the side of saying "may
 * start". That is also why the push is confirmed every time, detection or not: a workflow this
 * reading misses must not turn into a push with no question asked.
 */

/** A workflow and what its `on: push` says about tags. */
export interface TagWorkflow {
  /** File name under `.github/workflows`. */
  readonly file: string;
  /** Its `name:`, or the file name when it has none. */
  readonly name: string;
  /** `'any'` when every tag push starts it, otherwise its `tags:` patterns in order. */
  readonly patterns: 'any' | readonly string[];
}

/**
 * What a workflow file's `on:` says about tag pushes: `'any'`, its patterns, or `null` for none.
 *
 * GitHub's rules, reduced to what changes the answer:
 * - `on: push`, or `push` in a list, filters nothing: tag pushes start it;
 * - a `push:` block with `tags:` starts on those patterns; with `tags-ignore:` on the others (read
 *   as `'any'`, the cautious answer);
 * - a `push:` block with only `branches:` (or `branches-ignore:`) does **not** run for tags, GitHub
 *   skipping the ref type that is not filtered when only the other one is;
 * - a `push:` block with neither runs for every push, tags included.
 *
 * Pure and exported for testing.
 */
export function tagTriggersIn(yaml: string): 'any' | string[] | null {
  const lines = yaml
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, '').replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#'));

  const onIndex = lines.findIndex((line) => /^["']?on["']?\s*:/.test(line));
  if (onIndex === -1) {
    return null;
  }
  const inline = (lines[onIndex] ?? '').replace(/^["']?on["']?\s*:/, '').trim();
  if (inline.length > 0) {
    return /\bpush\b/.test(inline) ? 'any' : null;
  }

  const block = childBlock(lines, onIndex);
  const pushIndex = block.findIndex((line) => /^\s*push\s*:/.test(line));
  if (pushIndex === -1) {
    return null;
  }
  const pushInline = (block[pushIndex] ?? '').replace(/^\s*push\s*:/, '').trim();
  if (pushInline.length > 0 && pushInline !== '{}' && pushInline !== 'null') {
    // A flow mapping on one line (`push: { tags: [v*] }`) is rare enough to read cautiously.
    return 'any';
  }

  const filters = childBlock(block, pushIndex);
  const key = (name: string): number =>
    filters.findIndex((line) => new RegExp(`^\\s*${name}\\s*:`).test(line));
  const tags = key('tags');
  if (tags !== -1) {
    return listAt(filters, tags);
  }
  if (key('tags-ignore') !== -1) {
    return 'any';
  }
  if (key('branches') !== -1 || key('branches-ignore') !== -1) {
    return null;
  }
  return 'any';
}

/** The lines indented under `lines[index]`, up to the next one at its level or above. */
function childBlock(lines: readonly string[], index: number): string[] {
  const indent = indentOf(lines[index] ?? '');
  const block: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (indentOf(line) <= indent) {
      break;
    }
    block.push(line);
  }
  return block;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The values of a list key, inline (`tags: [v*, 'r-*']`) or as `- item` lines below it. */
function listAt(lines: readonly string[], index: number): string[] {
  const inline = (lines[index] ?? '').replace(/^\s*[\w-]+\s*:/, '').trim();
  if (inline.length > 0) {
    return inline
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map(unquote)
      .filter((value) => value.length > 0);
  }
  return childBlock(lines, index)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .map((line) => unquote(line.slice(1)))
    .filter((value) => value.length > 0);
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

/**
 * Whether a tag name matches a GitHub filter pattern.
 *
 * GitHub's filter syntax: `*` is any run of characters but `/`, `**` any run at all, `?` and `+` make
 * the previous character optional or repeatable (which is what they already mean in a regular
 * expression), `[...]` is a class. Everything else is literal. Pure and exported for testing.
 */
export function tagMatches(pattern: string, tag: string): boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] ?? '';
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if ('?+[]'.includes(char)) {
      source += char;
    } else {
      source += char.replace(/[.^$(){}|\\]/g, '\\$&');
    }
  }
  try {
    return new RegExp(`^${source}$`).test(tag);
  } catch {
    // A pattern this reading cannot turn into a regex is treated as matching: the cautious answer.
    return true;
  }
}

/**
 * The workflows a push of `tag` would start, patterns read in order as GitHub does: a later `!`
 * pattern excludes what an earlier one included. Pure and exported for testing.
 */
export function workflowsForTag(workflows: readonly TagWorkflow[], tag: string): TagWorkflow[] {
  return workflows.filter((workflow) => {
    if (workflow.patterns === 'any') {
      return true;
    }
    let matched = false;
    for (const pattern of workflow.patterns) {
      if (pattern.startsWith('!')) {
        if (tagMatches(pattern.slice(1), tag)) {
          matched = false;
        }
      } else if (tagMatches(pattern, tag)) {
        matched = true;
      }
    }
    return matched;
  });
}

/**
 * Reads the repository's workflows that react to tag pushes at all.
 *
 * Synchronous file reads, like the sequencer markers: a handful of small files, read once per push
 * confirmation. A repository with no `.github/workflows` is the common case and reads as none.
 */
export function readTagWorkflows(repoPath: string): TagWorkflow[] {
  const folder = join(repoPath, '.github', 'workflows');
  let files: string[];
  try {
    files = readdirSync(folder).filter((file) => /\.ya?ml$/i.test(file));
  } catch {
    return [];
  }
  const workflows: TagWorkflow[] = [];
  for (const file of files.sort()) {
    try {
      const text = readFileSync(join(folder, file), 'utf8');
      const patterns = tagTriggersIn(text);
      if (patterns !== null) {
        const name = /^name\s*:\s*(.+)$/m
          .exec(text)?.[1]
          ?.trim()
          .replace(/^["']|["']$/g, '');
        workflows.push({ file, name: name ?? file, patterns });
      }
    } catch {
      // An unreadable file says nothing either way; the confirmation is asked regardless.
    }
  }
  return workflows;
}
