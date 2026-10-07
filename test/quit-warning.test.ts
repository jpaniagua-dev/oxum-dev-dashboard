import { describe, expect, it } from 'vitest';
import { quitWarning } from '../src/main/quit-warning.js';

describe('quitWarning', () => {
  it('asks nothing when nothing would be lost, open editors included', () => {
    // An editor with everything saved is not counted at all: the caller passes unsaved files only.
    expect(quitWarning(0, 0)).toBeNull();
  });

  it('names servers, unsaved files, or both, with what each one costs', () => {
    expect(quitWarning(1, 0)).toEqual({
      message: '1 server started by the dashboard will be stopped.',
      detail: 'Servers started from an external terminal are not affected.',
    });
    expect(quitWarning(0, 2)).toEqual({
      message: '2 files have unsaved changes.',
      detail: 'Quitting now loses those changes.',
    });
    expect(quitWarning(2, 1)?.message).toBe(
      '2 servers started by the dashboard will be stopped, and 1 file has unsaved changes.',
    );
  });
});
