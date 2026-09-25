import type {
  AutomationFiring,
  AutomationRule,
  AutomationWorld,
} from '@shared/automation.js';
import { evaluate, fillTemplate, isDue } from '@shared/automation.js';
import type { AutomationData, AutomationStore } from './automation-store.js';

/**
 * What turns a decision into something happening.
 *
 * Every side effect is a **port**, handed in rather than imported, for the reason the feedback
 * watcher's are: a test that cannot assert "this tick started nothing" is not a test of a feature
 * whose entire job is to start things without being asked. An imported `notify` or an imported
 * terminal manager cannot be asked that question.
 */
export interface AutomationPorts {
  readonly notify: (title: string, body: string) => void;
  /** Opens a coding agent in a tab with this prompt. Answers false when it could not. */
  readonly runAgent: (prompt: string, projectId: string | null, title: string) => boolean;
  /** Opens a shell tab running this command. Answers false when it could not. */
  readonly runShell: (command: string, projectId: string | null, title: string) => boolean;
  readonly now: () => Date;
}

export interface AutomationGate {
  /** The master switch. Off by default, and nothing runs at all while it is off. */
  readonly enabled: boolean;
  /**
   * Whether a rule may run a shell command, which is a second and larger grant.
   *
   * Separate from `enabled` deliberately. A notification on a timer is a message; a command line on
   * a timer, with no click anywhere, is this app running something nobody read at the moment it ran.
   * Every other agent run here begins with a button. These do not, which is the whole argument for
   * two switches rather than one.
   */
  readonly shellEnabled: boolean;
}

export interface AutomationTickResult {
  readonly data: AutomationData;
  /** What actually ran, for the row to report. Empty on a quiet tick, which is almost every one. */
  readonly ran: readonly string[];
  /** Why something did not run, when it was refused rather than absent. */
  readonly refusals: readonly string[];
}

/**
 * One pass over the rules.
 *
 * Event rules and scheduled ones are decided by two different mechanisms and joined here, which is
 * the only place they meet: `evaluate` reads the world, `isDue` reads the clock, and neither knows
 * the other exists. That separation is the answer to "what time is it", which must have exactly one
 * owner per family.
 */
export class AutomationRunner {
  /** Held for the duration of a tick. Not `singleFlight`, whose trailing re-run would fire twice. */
  private busy = false;

  constructor(
    private readonly store: AutomationStore,
    private readonly gate: () => AutomationGate,
    private readonly ports: AutomationPorts,
  ) {}

  /**
   * Evaluates the event rules against a fresh world.
   *
   * Called from the polls, never from a timer. The payload is the authority on what is true, so a
   * cadence of its own would be free to disagree with the state it depends on, which is the argument
   * the feedback watcher already records.
   *
   * ⚠️ **It never throws.** It rides another feature's poll, and an exception here would take the
   * project rows or the pull request list down with it.
   */
  async tick(world: AutomationWorld): Promise<AutomationTickResult> {
    const gate = this.gate();
    const data = this.store.all();
    if (!gate.enabled || this.busy) {
      return { data, ran: [], refusals: [] };
    }
    this.busy = true;
    try {
      const decision = evaluate(data.rules, world, data.ledger);
      const armed = new Set(decision.armed);
      const next: AutomationData = {
        rules:
          armed.size === 0
            ? data.rules
            : data.rules.map((rule) => (armed.has(rule.id) ? { ...rule, armed: true } : rule)),
        ledger: { ...data.ledger, ...decision.seen },
        lastRun: data.lastRun,
      };

      /*
       * The record is flushed BEFORE anything runs, and the write is awaited.
       *
       * The ordering the feedback pass pays for in its own note: recording afterwards leaves a
       * window in which the file says a target has not been acted on while an agent is already
       * acting on it, and the next poll is seconds away. Two agents on one worktree is the outcome
       * worse than being blocked.
       */
      const saved = await this.store.save(next);

      const ran: string[] = [];
      const refusals: string[] = [];
      for (const firing of decision.firings) {
        const outcome = this.perform(firing, gate);
        if (outcome.ok) {
          ran.push(outcome.message);
        } else {
          refusals.push(outcome.message);
        }
      }
      return { data: saved, ran, refusals };
    } catch (error) {
      // Swallowed on purpose, and reported rather than thrown: see the note on this method.
      return {
        data,
        ran: [],
        refusals: [`The automation tick failed: ${String(error)}`],
      };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Runs whichever scheduled rules are due.
   *
   * The one timer in this feature, and the only reason it exists. A scheduled rule touches no
   * ledger: there is no target to remember, so `lastRun` is the whole of its state, and `isDue`
   * reads it.
   */
  async tickSchedule(): Promise<AutomationTickResult> {
    const gate = this.gate();
    const data = this.store.all();
    if (!gate.enabled || this.busy) {
      return { data, ran: [], refusals: [] };
    }
    this.busy = true;
    try {
      const now = this.ports.now();
      const due = data.rules.filter((rule) => isDue(rule, data.lastRun[rule.id] ?? null, now));
      if (due.length === 0) {
        return { data, ran: [], refusals: [] };
      }

      const lastRun = { ...data.lastRun };
      for (const rule of due) {
        lastRun[rule.id] = now.toISOString();
      }
      // Flushed before the spawn, same rule as above: a crash between the two must not leave a rule
      // that runs again on the next tick, every tick.
      const saved = await this.store.save({ ...data, lastRun });

      const ran: string[] = [];
      const refusals: string[] = [];
      for (const rule of due) {
        // No target, so no fields: a scheduled rule's text is written out in full, and a `{{name}}`
        // in it stays as written, which `fillTemplate` already guarantees.
        const outcome = this.perform(
          {
            ruleId: rule.id,
            ruleName: rule.name,
            target: { id: `schedule:${rule.id}`, label: rule.name, fields: {}, projectId: null },
            action: rule.action,
            text: fillTemplate(rule.action.text, {}),
          },
          gate,
        );
        (outcome.ok ? ran : refusals).push(outcome.message);
      }
      return { data: saved, ran, refusals };
    } catch (error) {
      return { data, ran: [], refusals: [`The scheduled tick failed: ${String(error)}`] };
    } finally {
      this.busy = false;
    }
  }

  /** Runs one firing through the ports, and says in one sentence what happened. */
  private perform(firing: AutomationFiring, gate: AutomationGate): { ok: boolean; message: string } {
    const where = firing.action.projectId ?? firing.target.projectId;
    switch (firing.action.kind) {
      case 'notify':
        this.ports.notify(firing.target.label, firing.text);
        return { ok: true, message: `Notified: ${firing.target.label}` };
      case 'agent':
        return this.ports.runAgent(firing.text, where, firing.ruleName)
          ? { ok: true, message: `Started an agent on ${firing.target.label}` }
          : { ok: false, message: `Could not start an agent on ${firing.target.label}` };
      case 'shell':
        /*
         * Refused in words rather than skipped in silence.
         *
         * A rule configured to run a command while the switch is off is a rule whose author expects
         * something to happen. Saying nothing would look exactly like a rule that never matched.
         */
        if (!gate.shellEnabled) {
          return {
            ok: false,
            message: 'Running a command from a rule is turned off in the settings',
          };
        }
        return this.ports.runShell(firing.text, where, firing.ruleName)
          ? { ok: true, message: `Ran a command for ${firing.target.label}` }
          : { ok: false, message: `Could not run the command for ${firing.target.label}` };
    }
  }
}

/**
 * Clears one rule's memory of one target, so it can fire on it again.
 *
 * The manual gesture the guard needs. The ledger is what stops a loop, so nothing may clear it on a
 * rule of its own; but a notification dismissed by mistake, or a rule fixed after it fired wrongly,
 * would otherwise be stuck for as long as the fact stays true. Pure, so the menu entry and a test
 * see the same function.
 */
export function forgetTarget(
  ledger: Readonly<Record<string, readonly string[]>>,
  ruleId: string,
  targetId: string,
): Record<string, readonly string[]> {
  const known = ledger[ruleId] ?? [];
  return { ...ledger, [ruleId]: known.filter((id) => id !== targetId) };
}

/** Forgets a whole rule's memory, which re-arms it against everything currently true. */
export function forgetRule(
  ledger: Readonly<Record<string, readonly string[]>>,
  ruleId: string,
): Record<string, readonly string[]> {
  const next = { ...ledger };
  delete next[ruleId];
  return next;
}

export type { AutomationRule };
