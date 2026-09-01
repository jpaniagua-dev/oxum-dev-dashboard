import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAG_COLOR,
  MAX_TAGS_PER_PROJECT,
  MAX_TAG_LENGTH,
  TAG_COLORS,
  addTag,
  hasTag,
  normalizeTag,
  parseTagInput,
  removeTag,
  sanitizeTagColors,
  sanitizeTags,
  tagColorOf,
  tagKey,
  tagSuggestions,
  tagVocabulary,
  toggleTag,
  withAssignedTagColors,
  withTagColor,
} from '../src/shared/project-tags.js';

describe('normalizeTag', () => {
  it('trims and collapses the whitespace inside a tag', () => {
    expect(normalizeTag('  design   system  ')).toBe('design system');
  });

  it('keeps the case, which is the display form', () => {
    // Folding to lower case here would rewrite what the user typed; comparison folds instead.
    expect(normalizeTag('Backend')).toBe('Backend');
  });

  it('turns a comma into a separator-free space', () => {
    // The editor splits on the comma, so a tag holding one would not survive a round trip.
    expect(normalizeTag('back,end')).toBe('back end');
  });

  it('caps the length and does not leave a trailing space behind the cut', () => {
    const long = `${'a'.repeat(MAX_TAG_LENGTH - 1)} bbb`;
    const tag = normalizeTag(long);
    expect(tag).toHaveLength(MAX_TAG_LENGTH - 1);
    expect(tag.endsWith(' ')).toBe(false);
  });

  it('answers empty for a tag made of nothing but separators', () => {
    expect(normalizeTag(' , , ')).toBe('');
  });
});

describe('tagKey', () => {
  it('folds case and spacing so one word is one tag', () => {
    expect(tagKey('  BACK end ')).toBe(tagKey('back End'));
  });
});

describe('sanitizeTags', () => {
  it('answers an empty list for anything that is not an array', () => {
    // The shape a configuration written before tags existed has: absent.
    expect(sanitizeTags(undefined)).toEqual([]);
    expect(sanitizeTags('backend')).toEqual([]);
    expect(sanitizeTags({ 0: 'backend' })).toEqual([]);
  });

  it('keeps the order and drops the entries that are not strings', () => {
    expect(sanitizeTags(['backend', 42, null, 'front'])).toEqual(['backend', 'front']);
  });

  it('keeps the first spelling of a duplicate', () => {
    // A hand-edited file holding both must end up with one chip, and with the one written first.
    expect(sanitizeTags(['Backend', 'backend', 'BACKEND'])).toEqual(['Backend']);
  });

  it('caps the count so a hand-edited file cannot flood a row', () => {
    const many = Array.from({ length: MAX_TAGS_PER_PROJECT + 5 }, (_, index) => `tag-${index}`);
    expect(sanitizeTags(many)).toHaveLength(MAX_TAGS_PER_PROJECT);
  });
});

describe('parseTagInput', () => {
  it('splits on the comma and not on the space', () => {
    // `design system` is one tag: a dashboard whose tags cannot hold a space invites an encoding.
    expect(parseTagInput('backend, design system ,dotnet')).toEqual([
      'backend',
      'design system',
      'dotnet',
    ]);
  });

  it('answers an empty list for a field holding only separators', () => {
    expect(parseTagInput(' , ')).toEqual([]);
  });
});

describe('addTag / removeTag / toggleTag', () => {
  it('adds a tag at the end', () => {
    expect(addTag(['backend'], 'front')).toEqual(['backend', 'front']);
  });

  it('refuses a duplicate whatever its case', () => {
    expect(addTag(['Backend'], 'backend')).toEqual(['Backend']);
  });

  it('refuses an empty tag and refuses to go past the cap', () => {
    expect(addTag(['backend'], '  ')).toEqual(['backend']);
    const full = Array.from({ length: MAX_TAGS_PER_PROJECT }, (_, index) => `tag-${index}`);
    expect(addTag(full, 'one-more')).toEqual(full);
  });

  it('removes a tag whatever the case it was clicked in', () => {
    expect(removeTag(['Backend', 'front'], 'BACKEND')).toEqual(['front']);
  });

  it('toggles both ways', () => {
    expect(toggleTag(['backend'], 'backend')).toEqual([]);
    expect(toggleTag([], 'backend')).toEqual(['backend']);
  });

  it('never mutates the list it is given', () => {
    // The settings form holds drafts and re-reads them to repaint: a mutation in place would let a
    // chip disappear from the model while staying on screen.
    const tags = ['backend'];
    addTag(tags, 'front');
    removeTag(tags, 'backend');
    expect(tags).toEqual(['backend']);
  });
});

describe('hasTag', () => {
  it('compares by key, and answers false for an empty tag', () => {
    expect(hasTag(['Backend'], 'backend')).toBe(true);
    expect(hasTag(['Backend'], '  ')).toBe(false);
  });
});

describe('tagVocabulary', () => {
  it('lists every tag once, alphabetically', () => {
    const projects = [
      { tags: ['front', 'angular'] },
      { tags: ['backend', 'front'] },
      { tags: [] },
    ];
    expect(tagVocabulary(projects)).toEqual(['angular', 'backend', 'front']);
  });

  it('folds two spellings into the first one met', () => {
    // Which spelling wins follows the project order, which is the display order and therefore stable.
    expect(tagVocabulary([{ tags: ['Backend'] }, { tags: ['backend'] }])).toEqual(['Backend']);
  });
});

describe('tagSuggestions', () => {
  it('offers what the project does not already carry', () => {
    const projects = [{ tags: ['backend', 'dotnet'] }, { tags: ['front'] }];
    expect(tagSuggestions(projects, ['front'])).toEqual(['backend', 'dotnet']);
  });
});

describe('sanitizeTagColors', () => {
  it('answers an empty map for anything that is not a plain object', () => {
    expect(sanitizeTagColors(undefined)).toEqual({});
    expect(sanitizeTagColors(['blue'])).toEqual({});
    expect(sanitizeTagColors('blue')).toEqual({});
  });

  it('folds the key, the colour belonging to the tag and not to a spelling', () => {
    expect(sanitizeTagColors({ '  BACK end ': 'green' })).toEqual({ 'back end': 'green' });
  });

  it('drops a colour outside the palette rather than defaulting it', () => {
    // A stored `#ff00bb` is exactly as unusable as no value: the palette is defined in the stylesheet
    // for both themes, so a hex here would paint something nobody chose for the dark one.
    expect(sanitizeTagColors({ backend: '#ff00bb', front: 'blue' })).toEqual({ front: 'blue' });
  });

  it('drops an entry whose key is not a tag', () => {
    expect(sanitizeTagColors({ '   ': 'blue' })).toEqual({});
  });
});

describe('withAssignedTagColors', () => {
  it('gives the first six tags six different colours, with nothing chosen', () => {
    const projects = TAG_COLORS.map((_, index) => ({ tags: [`tag-${index}`] }));
    const colors = withAssignedTagColors({}, projects);
    expect(new Set(Object.values(colors)).size).toBe(TAG_COLORS.length);
  });

  it('does not depend on the project order', () => {
    // Same workspace, saved twice: the tags must not change colour because a row was dragged.
    const a = [{ tags: ['front'] }, { tags: ['backend'] }];
    const b = [{ tags: ['backend'] }, { tags: ['front'] }];
    expect(withAssignedTagColors({}, a)).toEqual(withAssignedTagColors({}, b));
  });

  it('leaves an assigned colour alone', () => {
    const colors = withAssignedTagColors({ backend: 'red' }, [{ tags: ['backend', 'front'] }]);
    expect(colors.backend).toBe('red');
    expect(colors.front).toBeDefined();
  });

  it('keeps the colour of a tag nobody uses any more', () => {
    // What makes a tag deleted by mistake come back the colour it had. Pruning would buy nothing.
    expect(withAssignedTagColors({ gone: 'blue' }, [{ tags: [] }])).toEqual({ gone: 'blue' });
  });

  it('reuses colours past the palette rather than inventing one', () => {
    const projects = Array.from({ length: TAG_COLORS.length + 2 }, (_, index) => ({
      tags: [`tag-${index}`],
    }));
    const colors = withAssignedTagColors({}, projects);
    expect(Object.keys(colors)).toHaveLength(TAG_COLORS.length + 2);
    for (const color of Object.values(colors)) {
      expect(TAG_COLORS).toContain(color);
    }
  });
});

describe('tagColorOf / withTagColor', () => {
  it('falls back rather than throwing for a tag with no colour yet', () => {
    // Happens for one frame: a tag typed a moment ago whose save has not come back.
    expect(tagColorOf({}, 'backend')).toBe(DEFAULT_TAG_COLOR);
  });

  it('reads and writes through the folded key', () => {
    const colors = withTagColor({}, 'Backend', 'green');
    expect(colors).toEqual({ backend: 'green' });
    expect(tagColorOf(colors, 'BACKEND')).toBe('green');
  });

  it('refuses to write under an empty key', () => {
    expect(withTagColor({}, '  ', 'green')).toEqual({});
  });

  it('never mutates the map it is given', () => {
    const colors = { backend: 'blue' } as const;
    withTagColor(colors, 'backend', 'red');
    expect(colors.backend).toBe('blue');
  });
});
