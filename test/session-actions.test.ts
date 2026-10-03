import { describe, expect, it } from 'vitest';
import { canRerunSession } from '../src/shared/session-actions.js';

describe('canRerunSession', () => {
  it('offers rerun only for a configured Watch/Server action', () => {
    expect(canRerunSession({ role: 'server', projectId: 'web', actionId: 'run' })).toBe(true);
    expect(canRerunSession({ role: 'task', projectId: 'web', actionId: 'test' })).toBe(false);
    expect(canRerunSession({ role: null, projectId: 'web', actionId: null })).toBe(false);
  });

  it('refuses an orphaned server session without a project or action', () => {
    expect(canRerunSession({ role: 'server', projectId: null, actionId: 'run' })).toBe(false);
    expect(canRerunSession({ role: 'server', projectId: 'web', actionId: null })).toBe(false);
  });
});
