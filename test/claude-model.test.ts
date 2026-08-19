import { describe, expect, it } from 'vitest';
import {
  CLAUDE_MODEL_PATTERN,
  isValidModel,
  modelArgs,
  modelFlag,
  normalizeModel,
} from '../src/shared/claude-model.js';

/**
 * One of the three Claude Code runs reaches a shell, so this is where a model name stops being a
 * preference and becomes an argument. The rest of these pin the empty case, which is not "unset" but
 * "use whatever Claude Code is set to", and is spelled by the **absence** of the flag.
 */

describe('CLAUDE_MODEL_PATTERN', () => {
  it('accepts an alias, a full name and a pinned one with brackets', () => {
    for (const value of ['opus', 'sonnet', 'haiku', 'fable', 'claude-fable-5', 'claude-opus-5[1m]']) {
      expect(CLAUDE_MODEL_PATTERN.test(value)).toBe(true);
    }
  });

  it('refuses anything a shell would read as more than a word', () => {
    for (const value of ['sonnet 4', 'sonnet; id', 'sonnet && id', '$MODEL', '`id`', '-sonnet', '']) {
      expect(CLAUDE_MODEL_PATTERN.test(value)).toBe(false);
    }
  });
});

describe('isValidModel', () => {
  it('treats empty as valid, empty being how the default is spelled', () => {
    expect(isValidModel('')).toBe(true);
    expect(isValidModel('   ')).toBe(true);
  });

  it('flags what the store would drop, which is the whole point of showing it in the form', () => {
    expect(isValidModel('sonnet 4')).toBe(false);
  });
});

describe('normalizeModel', () => {
  it('keeps a model name and trims it', () => {
    expect(normalizeModel('  sonnet ')).toBe('sonnet');
  });

  it('turns anything else into the default rather than into an argument', () => {
    expect(normalizeModel('sonnet; rm -rf ~')).toBe('');
    expect(normalizeModel('')).toBe('');
  });
});

describe('modelArgs', () => {
  it('omits the flag entirely when there is no model', () => {
    // Not `['--model', '']`. The CLI rejects a blank model, so an empty flag would turn "use the
    // default" into a run that fails before it starts.
    expect(modelArgs('')).toEqual([]);
  });

  it('passes the model as its own argument', () => {
    expect(modelArgs('sonnet')).toEqual(['--model', 'sonnet']);
  });
});

describe('modelFlag', () => {
  it('is empty when there is no model, so it concatenates to nothing', () => {
    expect(modelFlag('')).toBe('');
    expect(`claude${modelFlag('')} --print`).toBe('claude --print');
  });

  it('quotes the value, which is what keeps a pinned name from being read as a glob', () => {
    // `claude-opus-5[1m]` unquoted is a bracket expression to bash. Quoted it is a model name.
    expect(modelFlag('claude-opus-5[1m]')).toBe(' --model "claude-opus-5[1m]"');
  });

  it('drops a value that is not a model rather than quoting it and hoping', () => {
    expect(modelFlag('sonnet"; id #')).toBe('');
  });
});
