import { describe, expect, it } from 'vitest';
import type { AutomationRule } from '../src/shared/automation.js';
import {
  blankRule,
  describeRuleCount,
  ruleStatus,
  textLabelFor,
} from '../src/renderer/ui/automation-panel.js';

function rule(patch: Partial<AutomationRule> = {}): AutomationRule {
  return { ...blankRule(), name: 'Approved pull requests', ...patch };
}

describe('the pill of a rule', () => {
  it('says Off for a switched-off rule, and asks for a name when it has none', () => {
    expect(ruleStatus(rule({ enabled: false }), true)).toMatchObject({ label: 'Off', tone: 'neutral' });
    expect(ruleStatus(rule({ enabled: false, name: ' ' }), true).title).toContain('Name the rule');
  });

  it('says an event rule is arming until its first check, then on', () => {
    expect(ruleStatus(rule({ enabled: true, armed: false }), true)).toMatchObject({ label: 'Arming', tone: 'busy' });
    expect(ruleStatus(rule({ enabled: true, armed: true }), true)).toMatchObject({ label: 'On', tone: 'ok' });
  });

  it('never says a scheduled rule is arming, since a schedule adopts nothing', () => {
    const scheduled = rule({ enabled: true, armed: false, trigger: 'schedule', atMinute: 9 * 60 });
    expect(ruleStatus(scheduled, true).label).toBe('On');
  });

  it('says a schedule with neither a time nor an interval never runs', () => {
    const scheduled = rule({ enabled: true, trigger: 'schedule', atMinute: null, everyMinutes: null });
    expect(ruleStatus(scheduled, true)).toMatchObject({ label: 'Never runs', tone: 'error' });
  });

  it('says what the engine will refuse: a command under a closed switch, a skill naming none', () => {
    const shell = rule({ enabled: true, armed: true, action: { kind: 'shell', text: 'npm test', projectId: null, skill: '' } });
    expect(ruleStatus(shell, false)).toMatchObject({ label: 'Will refuse', tone: 'error' });
    expect(ruleStatus(shell, true).label).toBe('On');
    const skill = rule({ enabled: true, armed: true, action: { kind: 'skill', text: '', projectId: null, skill: '' } });
    expect(ruleStatus(skill, true)).toMatchObject({ label: 'Will refuse', tone: 'error' });
  });
});

describe('the rest of the card', () => {
  it('names the text field after what the action does with it', () => {
    expect(textLabelFor('notify')).toBe('Message');
    expect(textLabelFor('agent')).toBe('Prompt');
    expect(textLabelFor('shell')).toBe('Command');
    expect(textLabelFor('skill')).toBe('Arguments');
  });

  it('counts the rules and the live ones', () => {
    expect(describeRuleCount([rule({ enabled: true })])).toBe('1 rule, 1 on');
    expect(describeRuleCount([rule({ enabled: true }), rule(), rule()])).toBe('3 rules, 1 on');
  });
});
