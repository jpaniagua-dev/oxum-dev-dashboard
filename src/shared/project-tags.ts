import type { ProjectConfig } from './contracts.js';

/**
 * Tags, as a value.
 *
 * A tag is a **string held by a project**, not an entity with an id declared somewhere else. There is
 * no tag registry in the settings and there must not be one: a registry buys two things, an atomic
 * rename and a colour per tag, and this app needs neither. The colour is out by design (a tag is a
 * plain fact, and this interface spends colour on states that claim something is wrong), and a rename
 * across a handful of projects is a rewrite of one field on each of them. What a registry would cost
 * is real: a second shape to sanitise, orphans to collect when a project leaves, and two sources that
 * can disagree about which tags exist.
 *
 * So the vocabulary is **derived** from what the projects carry (`tagVocabulary`), which is what feeds
 * the suggestions in the settings and, later, the filter bar. Nothing can be out of sync with usage
 * because usage is the only record.
 *
 * Pure and in `shared/` for the reason `project-order.ts` is: the main process sanitises with it on the
 * way in, the renderer edits drafts with it, and the rules below (folding by case, deduplication,
 * caps) are the kind that look obvious and are wrong in one branch out of four. Verified by test, not
 * by eye.
 */

/**
 * Longest tag kept, in characters.
 *
 * A tag is read in a chip beside a project name in a table row, so its length is a layout constraint
 * and not a storage one. Anything past this is a sentence, and a sentence in a chip pushes the
 * columns that carry the row's actual state off the screen.
 */
export const MAX_TAG_LENGTH = 24;

/**
 * Most tags kept on one project.
 *
 * Same reason as the length: past a handful of chips the project cell is wider than the status it is
 * supposed to introduce. The cap is enforced on the way in rather than in the editor alone, because a
 * hand-edited `settings.json` reaches the table without passing through any form.
 */
export const MAX_TAGS_PER_PROJECT = 8;

/**
 * Normalises one tag, or answers empty when there is nothing left of it.
 *
 * Commas are stripped rather than kept: the editor separates tags on a comma, so a tag holding one
 * would be split on its way back in and would not survive a round trip. Case is **preserved**, since
 * it is the display form and `Backend` is what the user typed; comparison folds it instead
 * (`tagKey`), which is what stops `Backend` and `backend` from being two chips saying the same thing.
 */
export function normalizeTag(raw: string): string {
  return raw
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TAG_LENGTH)
    .trim();
}

/** The form two tags are compared on: same word, whatever the case or the spacing. */
export function tagKey(tag: string): string {
  return normalizeTag(tag).toLocaleLowerCase();
}

/** Whether the list already holds that tag, comparing by key and not by spelling. */
export function hasTag(tags: readonly string[], tag: string): boolean {
  const key = tagKey(tag);
  return key.length > 0 && tags.some((entry) => tagKey(entry) === key);
}

/**
 * Coerces arbitrary JSON into a project's tag list.
 *
 * The boundary guard, called from `asProjects`. Order is preserved because it is the order of the
 * chips, and the first spelling of a duplicate wins: a file holding `["Backend", "backend"]` keeps one
 * chip, and it keeps the one written first rather than the one written last.
 */
export function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: string[] = [];
  const keys = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const tag = normalizeTag(entry);
    const key = tag.toLocaleLowerCase();
    if (tag.length === 0 || keys.has(key)) {
      continue;
    }
    keys.add(key);
    result.push(tag);
    if (result.length >= MAX_TAGS_PER_PROJECT) {
      break;
    }
  }
  return result;
}

/**
 * Reads what was typed in the tag field as a list of tags.
 *
 * Splitting on the comma is what makes `backend, dotnet` one gesture instead of two, and it is also
 * what lets a whole list be pasted in. Whitespace alone is **not** a separator: `design system` is one
 * tag, and a dashboard whose tags cannot hold a space would push the user to invent an encoding.
 */
export function parseTagInput(raw: string): string[] {
  return sanitizeTags(raw.split(','));
}

/**
 * Adds a tag, keeping the list valid.
 *
 * Returns the list unchanged when the tag is empty, already there, or the cap is reached. Silence is
 * deliberate: the caller is a keystroke in a chip field, and the honest answer to a duplicate is that
 * nothing happened, the chip being already on screen to say so.
 */
export function addTag(tags: readonly string[], tag: string): string[] {
  const normalized = normalizeTag(tag);
  if (normalized.length === 0 || hasTag(tags, normalized) || tags.length >= MAX_TAGS_PER_PROJECT) {
    return [...tags];
  }
  return [...tags, normalized];
}

/** Removes a tag, comparing by key so the chip goes whatever case it was clicked in. */
export function removeTag(tags: readonly string[], tag: string): string[] {
  const key = tagKey(tag);
  return tags.filter((entry) => tagKey(entry) !== key);
}

/**
 * Adds the tag if it is absent, removes it if it is there.
 *
 * The gesture a menu or a chip toggle needs, so the two sides of it cannot drift apart.
 */
export function toggleTag(tags: readonly string[], tag: string): string[] {
  return hasTag(tags, tag) ? removeTag(tags, tag) : addTag(tags, tag);
}

/**
 * Every tag in use, once each, in alphabetical order.
 *
 * This is the vocabulary: the suggestions offered while tagging, and what the filter bar will list.
 * Sorted rather than left in project order, because it is read as a list of words and not as a
 * projection of the table. Duplicates fold by key and the first spelling met wins, which makes the
 * result depend on the project order and therefore stay stable between two calls.
 */
export function tagVocabulary(
  projects: readonly { readonly tags: readonly string[] }[],
): string[] {
  const seen = new Map<string, string>();
  for (const project of projects) {
    for (const tag of project.tags) {
      const key = tagKey(tag);
      if (key.length > 0 && !seen.has(key)) {
        seen.set(key, normalizeTag(tag));
      }
    }
  }
  return [...seen.values()].sort((left, right) => left.localeCompare(right));
}

/**
 * Suggestions for one project: the vocabulary minus what it already carries.
 *
 * Typed on the stored shape because that is what both callers hold — the settings form edits drafts of
 * `ProjectConfig`, and a future filter reads the same list.
 */
export function tagSuggestions(
  projects: readonly Pick<ProjectConfig, 'tags'>[],
  own: readonly string[],
): string[] {
  return tagVocabulary(projects).filter((tag) => !hasTag(own, tag));
}
