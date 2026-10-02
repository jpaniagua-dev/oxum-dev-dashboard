import { describe, expect, it } from 'vitest';
import {
  parseTriggerResult,
  presentEnum,
  readExtensionAction,
  readRoutine,
  readRoutineList,
  routineItems,
  routineRunLink,
  shellSafeText,
  toolResults,
} from '../src/shared/extensions.js';
import { triggerPrompt } from '../src/main/extensions/routines.js';
import { describeSince, verbLabel } from '../src/renderer/ui/extensions-panel.js';

const TRIGGER = {
  id: 'trig_01Example',
  name: 'Weekly digest',
  cron_expression: '0 6 * * 4',
  enabled: true,
  next_run_at: '2026-10-08T06:10:00Z',
  last_fired_at: '2026-10-01T06:11:00Z',
  last_run: {
    status: 'ROUTINE_RUN_STATUS_SUCCEEDED',
    failure_reason: 'ROUTINE_RUN_FAILURE_REASON_UNSPECIFIED',
    session_id: 'session_01Example',
    fired_at: 'x',
  },
  derived_state: { model: 'example-model', prompt: 'Post to https://hooks.example.com/SECRET-TOKEN' },
  job_config: { secret: 'SECRET-TOKEN' },
  session_request: { prompt: 'SECRET-TOKEN' },
  suspension_reason: '',
  ended_reason: '',
};

describe('routines', () => {
  it('keeps the whitelist and nothing of the instructions', () => {
    const routine = readRoutine(TRIGGER);
    expect(routine).toEqual({
      id: 'trig_01Example',
      name: 'Weekly digest',
      cron: '0 6 * * 4',
      enabled: true,
      nextRunAt: '2026-10-08T06:10:00Z',
      lastFiredAt: '2026-10-01T06:11:00Z',
      lastStatus: 'succeeded',
      lastFailure: null,
      lastSessionId: 'session_01Example',
      model: 'example-model',
      stopped: null,
    });
    expect(JSON.stringify(routineItems(readRoutineList({ data: [TRIGGER] })))).not.toContain('SECRET');
  });

  it('reads an API enum as words, and its UNSPECIFIED as nothing', () => {
    expect(presentEnum('ROUTINE_RUN_STATUS_TIMED_OUT')).toBe('timed out');
    expect(presentEnum('ROUTINE_RUN_FAILURE_REASON_UNSPECIFIED')).toBeNull();
    expect(presentEnum('paused by the owner')).toBe('paused by the owner');
    expect(presentEnum('')).toBeNull();
  });

  it('refuses an entry without a usable id', () => {
    expect(readRoutineList({ data: [{ name: 'x' }, { ...TRIGGER, id: 'bad id;' }, TRIGGER] })).toHaveLength(1);
    expect(readRoutineList(null)).toEqual([]);
  });

  it('reads the tool result, status line first', () => {
    expect(parseTriggerResult('HTTP 200\n{"data":[]}')).toEqual({ status: 200, body: { data: [] } });
    expect(parseTriggerResult('HTTP 404\nnot json')).toEqual({ status: 404, body: null });
    expect(parseTriggerResult('{"data":[]}')).toBeNull();
  });

  it('takes the data from the transcript, not from the model', () => {
    const transcript = [
      '{"type":"system","subtype":"init"}',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'HTTP 200\n{"fake":1}' }] } }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'HTTP 200\n{"data":[]}' }] }] },
      }),
      '{"type":"result","result":"OK"}',
    ].join('\n');
    expect(toolResults(transcript)).toEqual(['HTTP 200\n{"data":[]}']);
  });

  it('links only a session id claude.ai/code addresses', () => {
    expect(routineRunLink('session_01Example')).toBe('https://claude.ai/code/session_01Example');
    expect(routineRunLink('cse_01Example')).toBeNull();
    expect(routineRunLink(null)).toBeNull();
  });

  it('asks for exactly one call', () => {
    expect(triggerPrompt({ action: 'update', id: 'trig_1', enabled: false })).toBe(
      'Use action "update", trigger_id "trig_1" and body {"enabled": false}. Call the RemoteTrigger tool exactly once with those arguments, then reply with the single word OK.',
    );
    expect(triggerPrompt({ action: 'list' })).toMatch(/^Use action "list"\./);
  });

  it('labels the verbs the way a routine means them', () => {
    const [item] = routineItems([readRoutine(TRIGGER)!]);
    expect(item?.verbs).toEqual(['toggle', 'run', 'edit', 'open']);
    expect(item && verbLabel(item, 'toggle')).toBe('Pause');
    expect(item && verbLabel(item, 'edit')).toBe('Change in a terminal');
  });

  it('drops what a shell would expand from a name', () => {
    expect(shellSafeText('Beer "day" $HOME %PATH% `x` !')).toBe('Beer day HOME PATH x');
  });

  it('validates the routine actions', () => {
    expect(readExtensionAction({ type: 'run', id: 'claude:routine:trig_1' })).toEqual({ type: 'run', id: 'claude:routine:trig_1' });
    expect(readExtensionAction({ type: 'schedule-session', id: null })).toEqual({ type: 'schedule-session', id: null });
    expect(readExtensionAction({ type: 'schedule-session', id: 3 })).toBeNull();
  });

  it('says how old a read is', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    expect(describeSince('2026-10-02T11:59:50Z', now)).toBe('just now');
    expect(describeSince('2026-10-02T10:00:00Z', now)).toBe('2 h ago');
  });
});
