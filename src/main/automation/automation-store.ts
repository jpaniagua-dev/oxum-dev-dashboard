import { readFile, writeFile } from 'node:fs/promises';
import type { AutomationRule, TriggerKind } from '@shared/automation.js';
import { TRIGGER_KINDS } from '@shared/automation.js';

/**
 * The rules, their ledgers and when each scheduled one last ran.
 *
 * Its own file for the reason `triage.json` and `auto-runs.json` have one: this is a result and a
 * record, not a preference, and a settings save must never be able to drop it. Losing it here would
 * not lose a setting, it would re-arm every rule and replay a morning's worth of notifications.
 */

export interface AutomationData {
  readonly rules: readonly AutomationRule[];
  /** Per rule, the target ids currently true and already acted on. */
  readonly ledger: Readonly<Record<string, readonly string[]>>;
  /** Per scheduled rule, when it last ran, as an ISO instant. */
  readonly lastRun: Readonly<Record<string, string>>;
}

const EMPTY: AutomationData = { rules: [], ledger: {}, lastRun: {} };

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asPositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function asTrigger(value: unknown): TriggerKind | null {
  return TRIGGER_KINDS.find((kind) => kind === value) ?? null;
}

/**
 * Reads one rule, or `null` for a row that cannot be acted on.
 *
 * Dropped rather than repaired, the house rule, and here it earns its place twice over: a rule is a
 * thing that STARTS AN AGENT on its own, so a half-understood row is not something to guess at. A
 * missing id or an unknown trigger is unrunnable; everything else falls back to something inert.
 */
export function parseRule(payload: unknown): AutomationRule | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const row = payload as Record<string, unknown>;
  const id = asString(row['id']);
  const trigger = asTrigger(row['trigger']);
  if (id.length === 0 || trigger === null) {
    return null;
  }
  const action = typeof row['action'] === 'object' && row['action'] !== null
    ? (row['action'] as Record<string, unknown>)
    : {};
  const kind = action['kind'];
  return {
    id,
    name: asString(row['name'], 'Rule'),
    /*
     * Disabled unless the file says `true`.
     *
     * The direction to be wrong in, and the only one: a rule read from a file this app did not write
     * this version of is a rule whose meaning may have drifted, and one that starts agents by itself
     * must not be switched on by a value that merely failed to be `false`.
     */
    enabled: row['enabled'] === true,
    trigger,
    atMinute: asPositive(row['atMinute']),
    everyMinutes: asPositive(row['everyMinutes']),
    action: {
      kind: kind === 'agent' || kind === 'shell' ? kind : 'notify',
      text: asString(action['text']),
      projectId: typeof action['projectId'] === 'string' ? action['projectId'] : null,
    },
    /*
     * Unarmed unless the file says otherwise, which is also the safe direction.
     *
     * An unarmed rule spends one tick adopting what is already true and says nothing. A wrongly
     * armed one announces everything that is true the moment it is read, which after a corrupted
     * file would be a burst of notifications about a week-old state.
     */
    armed: row['armed'] === true,
  };
}

function parseLedger(payload: unknown): Record<string, readonly string[]> {
  if (typeof payload !== 'object' || payload === null) {
    return {};
  }
  const out: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      out[key] = value.filter((entry): entry is string => typeof entry === 'string');
    }
  }
  return out;
}

function parseLastRun(payload: unknown): Record<string, string> {
  if (typeof payload !== 'object' || payload === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

export function parseAutomations(payload: unknown): AutomationData {
  if (typeof payload !== 'object' || payload === null) {
    return EMPTY;
  }
  const root = payload as Record<string, unknown>;
  const rules = Array.isArray(root['rules'])
    ? root['rules'].map(parseRule).filter((rule): rule is AutomationRule => rule !== null)
    : [];
  return { rules, ledger: parseLedger(root['ledger']), lastRun: parseLastRun(root['lastRun']) };
}

export class AutomationStore {
  private data: AutomationData = EMPTY;

  constructor(private readonly file: string) {}

  async load(): Promise<AutomationData> {
    try {
      this.data = parseAutomations(JSON.parse(await readFile(this.file, 'utf-8')));
    } catch {
      // Missing or unreadable is "no rules yet", which is every first launch.
      this.data = EMPTY;
    }
    return this.data;
  }

  all(): AutomationData {
    return this.data;
  }

  /**
   * Replaces the whole record and writes it.
   *
   * Awaited by every caller that then spawns something, which is the ordering the feedback pass
   * already records: recording after the spawn leaves a window where the file says a rule has not
   * fired while it is firing, and the next tick is seconds away.
   */
  async save(next: AutomationData): Promise<AutomationData> {
    this.data = next;
    await writeFile(this.file, JSON.stringify(next, null, 2), 'utf-8');
    return this.data;
  }
}
