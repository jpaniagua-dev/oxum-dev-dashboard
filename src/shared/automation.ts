import type { JiraIssue, ProjectRow, RepoPulls } from './contracts.js';

/**
 * Rules that act on their own, on facts this app already knows.
 *
 * The design turns on one choice, and everything else follows from it: **a rule observes a fact that
 * has become true, it does not diff two states.** Diffing needs a "before", and the app restarts and
 * loses it; worse, a diff cannot tell "this became true while I was closed" from "this was already
 * true". Evaluating a condition over the CURRENT state and keeping a ledger of what has been acted
 * on gives edge detection and the anti-loop guard with one mechanism instead of two that can
 * disagree.
 *
 * **The ledger holds facts that are still true, and drops the rest.** That is the second half of the
 * idea and the first draft got it wrong: a ledger that remembered for ever meant a dev server broke,
 * was fixed, broke again, and said nothing the second time, because its entry was still sitting
 * there from the first. An alert that fires once in the lifetime of an app is one nobody relies on.
 * Keeping only what is currently true makes a rule fire once per CONTINUOUS period during which its
 * fact holds, which is what "tell me when this happens" means in every one of these cases: a pull
 * request stays approved until it merges, a server stays broken until it builds, an issue stays
 * assigned until it is not. It also bounds the ledger for free, since it can never hold more than
 * what is true right now.
 *
 * ⚠️ **The cost of that choice, and it has to be paid explicitly**: on the very first evaluation
 * everything already true would fire at once, which on a morning with nine approved pull requests is
 * nine notifications for news a week old. A rule therefore starts **disarmed**: its first pass
 * records what is true and acts on none of it, and only what appears afterwards fires. `armed` is
 * stored, so this happens once in a rule's life and not once per launch.
 *
 * The triggers are a CLOSED LIST and the engine is generic, which is the honest division. The
 * schedule, the guard, the ledger, the templating and the actions know no special case; the triggers
 * are named because this app knows a named set of facts. The alternative is a predicate language
 * over an untyped state blob, which is a DSL, and there is no DSL here to extend.
 */

/* ------------------------------------------------------------------ *
 * What a rule watches
 * ------------------------------------------------------------------ */

export type TriggerKind =
  | 'pull-approved'
  | 'pull-checks-red'
  | 'server-broken'
  | 'issue-assigned'
  | 'schedule';

export const TRIGGER_KINDS: readonly TriggerKind[] = [
  'pull-approved',
  'pull-checks-red',
  'server-broken',
  'issue-assigned',
  'schedule',
];

/** What the settings window says each one watches, in one line. */
export function describeTrigger(kind: TriggerKind): string {
  switch (kind) {
    case 'pull-approved':
      return 'A followed pull request is approved';
    case 'pull-checks-red':
      return "A followed pull request's checks fail";
    case 'server-broken':
      return 'A dev server crashes, or its build or lint fails';
    case 'issue-assigned':
      return 'A sprint issue becomes assigned to you';
    case 'schedule':
      return 'A time of day, whatever has or has not happened';
  }
}

/**
 * Whether a trigger rides the existing polls or needs the clock.
 *
 * The one thing the two families must never share is an answer to "is it time". Event rules are
 * evaluated when a poll reports; `schedule` is the only kind with a timer behind it, and it is the
 * only reason that timer exists.
 */
export function isScheduled(kind: TriggerKind): boolean {
  return kind === 'schedule';
}

/* ------------------------------------------------------------------ *
 * What a rule does
 * ------------------------------------------------------------------ */

/**
 * What a firing does. `skill` is `agent` with the prompt built for you: a slash command chosen from
 * the installed skills, followed by its arguments. It opens the same kind of tab, in the same folder,
 * so the skill runs with the context every handoff gets.
 */
export type ActionKind = 'notify' | 'agent' | 'shell' | 'skill';

export interface AutomationAction {
  readonly kind: ActionKind;
  /**
   * The notification's text, the agent's prompt, or the shell command. Templated with `{{name}}`.
   *
   * One field for all three rather than a shape per kind, because every one of them is "some text,
   * with the target's facts substituted in", and three near-identical shapes is three places to
   * forget the substitution.
   */
  readonly text: string;
  /** Which project the tab opens in. Ignored by `notify`, and `null` means the first configured. */
  readonly projectId: string | null;
  /**
   * For `skill` only: the skill's name, without its slash (`test-dev`). `text` is then its arguments.
   * Empty for every other kind, and a `skill` action with none is refused in words when it fires.
   */
  readonly skill: string;
}

export interface AutomationRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly trigger: TriggerKind;
  /**
   * For `schedule` only: minutes past midnight, local time, or `null` for an interval.
   *
   * Minutes past midnight and not a cron string, deliberately. The expressions actually wanted here
   * are "every N minutes" and "at HH:MM", and a cron parser is a subsystem with an edge case per
   * field. Dorothy hand-rolled a partial one that understands exactly one shape and silently falls
   * back to "an hour from now" for every other, which is worse than not offering cron at all.
   */
  readonly atMinute: number | null;
  /** For `schedule` only, when `atMinute` is null. */
  readonly everyMinutes: number | null;
  /**
   * For `schedule` only: the days the rule may run, `0` for Sunday to `6` for Saturday, as
   * `Date.getDay` counts them. Empty means every day, which is what every rule written before this
   * field means too.
   */
  readonly weekdays: readonly number[];
  /**
   * Where what the rule's run writes ends up (a skill's report folder), or empty.
   *
   * The app does not run the skill and cannot know where it writes, so the rule says it; the rule's
   * card then opens the newest file there. A setting of the rule rather than a contract with the
   * skill, so any skill that writes a file can be followed without the app learning its format.
   */
  readonly outputFolder: string;
  readonly action: AutomationAction;
  /**
   * False until the first evaluation has recorded what was already true.
   *
   * Stored, so a rule adopts the existing state once in its life rather than once per launch.
   */
  readonly armed: boolean;
}

/* ------------------------------------------------------------------ *
 * Targets
 * ------------------------------------------------------------------ */

/**
 * One thing a rule can fire about, and the facts it offers a template.
 *
 * The id is what the ledger keys on, so it has to be stable across polls and unique across triggers:
 * a pull request and an issue could otherwise collide on a number. Hence the kind prefix.
 */
export interface AutomationTarget {
  readonly id: string;
  /** What the row says, for a notification with no template of its own. */
  readonly label: string;
  readonly fields: Readonly<Record<string, string>>;
  /** The project this concerns, when it has one: an agent or a shell tab needs a folder. */
  readonly projectId: string | null;
}

/**
 * Everything a rule may look at, handed in whole.
 *
 * One argument rather than a parameter per trigger, so adding a trigger that reads something new is
 * a field here and a branch in `targetsFor`, and never a change to every call site.
 */
export interface AutomationWorld {
  readonly rows: readonly ProjectRow[];
  readonly pulls: readonly RepoPulls[];
  readonly issues: readonly JiraIssue[];
}

/** The phases that mean a dev server needs somebody. `stopped` is not one: stopping is a gesture. */
const BROKEN_PHASES = new Set(['crashed', 'build-error', 'lint-error']);

/**
 * Everything a trigger considers true right now.
 *
 * Pure, and the heart of the feature. A rule fires on the members of this set that its ledger has
 * not seen; nothing here knows about ledgers, arming or actions.
 */
export function targetsFor(kind: TriggerKind, world: AutomationWorld): readonly AutomationTarget[] {
  switch (kind) {
    case 'pull-approved':
      return pullTargets(world, (pull) => pull.review === 'approved');
    case 'pull-checks-red':
      return pullTargets(world, (pull) => pull.checks === 'failing');
    case 'server-broken':
      return world.rows
        .filter((row) => BROKEN_PHASES.has(row.server.phase))
        .map((row) => ({
          /*
           * The phase is in the id, so a crash and a failed build are two different things to be
           * told about rather than one "broken".
           *
           * Repeats are NOT what this buys: a build that fails twice with the same phase has the
           * same id both times. What makes the second failure fire is the ledger dropping the entry
           * while the server was healthy, which is `evaluate`'s doing and not this key's.
           */
          id: `server:${row.project.id}:${row.server.phase}`,
          label: `${row.project.label} is ${row.server.phase}`,
          fields: {
            project: row.project.label,
            phase: row.server.phase,
            path: row.project.path,
          },
          projectId: row.project.id,
        }));
    case 'issue-assigned':
      return world.issues
        .filter((issue) => issue.isMine)
        .map((issue) => ({
          id: `issue:${issue.key}`,
          label: `${issue.key} ${issue.summary}`,
          fields: {
            key: issue.key,
            summary: issue.summary,
            status: issue.status,
            url: issue.url,
          },
          projectId: null,
        }));
    case 'schedule':
      /*
       * A scheduled rule has no target, and returning one anyway is what would break it.
       *
       * The ledger is keyed on the target, so a schedule firing on a constant id would be recorded
       * once and never fire again; firing on a changing id would make the ledger grow for ever. It
       * is not on this path at all: `dueAt` decides, and the ledger is untouched.
       */
      return [];
  }
}

function pullTargets(
  world: AutomationWorld,
  match: (pull: RepoPulls['pulls'][number]) => boolean,
): readonly AutomationTarget[] {
  const targets: AutomationTarget[] = [];
  for (const repo of world.pulls) {
    /*
     * A repository that failed to answer is skipped, never read as "it has no pull requests".
     *
     * The same guard the merge watcher is built on and for the same reason: an errored poll hands
     * back an empty list, which is indistinguishable from every pull request having closed at once.
     * Here the consequence is milder (a missed notification rather than a closed ticket), but the
     * shape of the mistake is identical and it is the one this codebase keeps paying for.
     */
    if (repo.error !== null) {
      continue;
    }
    // No GitHub remote, so no pull request can exist and no target can be named: the id is built
    // from the slug, and `null#12` would be a ledger key that collides across every such project.
    if (repo.slug === null) {
      continue;
    }
    const slug = repo.slug;
    for (const pull of repo.pulls) {
      if (!match(pull)) {
        continue;
      }
      targets.push({
        id: `pull:${slug}#${String(pull.number)}`,
        label: `${slug}#${String(pull.number)} ${pull.title}`,
        fields: {
          repo: slug,
          number: String(pull.number),
          title: pull.title,
          url: pull.url,
          branch: pull.branch,
          author: pull.authorLogin,
        },
        projectId: repo.projectId,
      });
    }
  }
  return targets;
}

/* ------------------------------------------------------------------ *
 * Templating
 * ------------------------------------------------------------------ */

/**
 * Substitutes `{{name}}` from a target's fields.
 *
 * An unknown name is **left as written** rather than blanked. A rule whose template says `{{titel}}`
 * should read as a typo on screen, not as a sentence that quietly lost half its meaning: a
 * notification saying "PR  was approved" is one nobody can debug.
 */
export function fillTemplate(text: string, fields: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => fields[name] ?? whole);
}

/* ------------------------------------------------------------------ *
 * The clock, for scheduled rules only
 * ------------------------------------------------------------------ */

/**
 * Whether a scheduled rule is due, given when it last ran.
 *
 * Two shapes and no third. `atMinute` is a time of day in LOCAL minutes past midnight, which is due
 * once the clock has passed it and the rule has not run today; `everyMinutes` is a plain elapsed
 * test. A rule that has never run is due immediately in the interval form and waits for its hour in
 * the daily one, which is the reading that cannot surprise: an interval means "repeatedly, starting
 * now", an hour means "at that hour".
 */
export function isDue(rule: AutomationRule, lastRunAt: string | null, now: Date): boolean {
  if (!canRun(rule) || rule.trigger !== 'schedule') {
    return false;
  }
  // A day the rule is not set for is simply not a day it runs; the next allowed day picks it up.
  if (rule.weekdays.length > 0 && !rule.weekdays.includes(now.getDay())) {
    return false;
  }
  const last = lastRunAt === null ? null : new Date(lastRunAt);
  const lastAt = last === null || Number.isNaN(last.getTime()) ? null : last;

  if (rule.atMinute !== null) {
    const minuteNow = now.getHours() * 60 + now.getMinutes();
    if (minuteNow < rule.atMinute) {
      return false;
    }
    if (lastAt === null) {
      return true;
    }
    // Ran already today, whatever the hour: a daily rule fires once a day and a restart at 10:00
    // must not run the 09:00 rule a second time.
    return !sameDay(lastAt, now);
  }

  if (rule.everyMinutes !== null && rule.everyMinutes > 0) {
    if (lastAt === null) {
      return true;
    }
    return now.getTime() - lastAt.getTime() >= rule.everyMinutes * 60_000;
  }

  // Neither shape set: a rule that cannot say when it wants to run never runs, rather than running
  // on every tick. The settings form refuses to save one, and this is the second gate.
  return false;
}

/** Week days as stored: integers 0 to 6, once each, in order. Anything else is dropped. */
export function sanitizeWeekdays(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const days = new Set<number>();
  for (const day of value) {
    if (Number.isInteger(day) && day >= 0 && day <= 6) {
      days.add(day as number);
    }
  }
  return [...days].sort((left, right) => left - right);
}

/**
 * A skill name as a slash command takes it (`test-dev`, `plugin:skill`), or empty. It lands in an
 * agent's prompt inside a shell argument, so nothing but letters, digits and `-_.:` survives.
 */
export function sanitizeSkillName(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const name = value.trim().replace(/^\//, '');
  return /^[\w.:-]{1,80}$/.test(name) ? name : '';
}

/** An absolute folder path as typed, trimmed, or empty. Whether it exists is checked when opened. */
export function sanitizeOutputFolder(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const folder = value.trim();
  const absolute = /^[a-zA-Z]:[\\/]/.test(folder) || folder.startsWith('\\\\') || folder.startsWith('/');
  return absolute && folder.length <= 1024 ? folder : '';
}

/**
 * The file a rule's latest output is: the newest report-like file of the folder, else its newest
 * file, or null when it holds none.
 *
 * Report-like first, because a run writes its state as it goes and its report at the end: during a
 * run the newest file is often the state, which is not what "open the output" means. Hidden files
 * never count. Only the folder itself is read, never below it.
 */
export function pickLatestOutput(
  entries: readonly { name: string; isFile: boolean; mtimeMs: number }[],
): string | null {
  const files = entries.filter((entry) => entry.isFile && !entry.name.startsWith('.'));
  const newest = (list: typeof files): string | null =>
    list.length === 0 ? null : [...list].sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.name ?? null;
  const reports = files.filter((entry) => /\.(md|html?|txt|pdf)$/i.test(entry.name));
  return newest(reports) ?? newest(files);
}

/** The prompt a `skill` action sends: the slash command, then its arguments when there are any. */
export function skillPrompt(skill: string, args: string): string {
  return `/${skill} ${args}`.trim();
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/* ------------------------------------------------------------------ *
 * What a tick decides
 * ------------------------------------------------------------------ */

export interface AutomationFiring {
  readonly ruleId: string;
  /**
   * What the reader called this rule, which is what its tab is named after.
   *
   * Carried on the firing rather than looked up by id at the far end: the runner would otherwise
   * need the rule list to name a tab, and a port that has to be handed the whole world to write a
   * title is a port that knows too much.
   */
  readonly ruleName: string;
  readonly target: AutomationTarget;
  readonly action: AutomationAction;
  /** The action's text with the target's fields substituted, ready to run. */
  readonly text: string;
}

export interface AutomationDecision {
  /** What to run, in rule order. Empty on a quiet tick, which is almost every tick. */
  readonly firings: readonly AutomationFiring[];
  /**
   * Each rule's ledger as it should now stand: every target of that rule that is true right now.
   *
   * A REPLACEMENT and not an addition, which is the whole of the edge detection. What has stopped
   * being true is absent, so the next time it comes back it is new again. Returned rather than
   * written here, so the pure layer stays pure and a test can assert "this tick adopted six and
   * fired none", which is the claim that matters at boot.
   */
  readonly seen: Readonly<Record<string, readonly string[]>>;
  /** Rules that were disarmed and have now adopted their existing state. */
  readonly armed: readonly string[];
}

/**
 * One evaluation of every event rule.
 *
 * Returns what to do and what to remember, and does neither. `ledger` is what each rule has already
 * acted on; anything in a rule's targets that is not in it either fires, or is adopted in silence
 * when the rule is not yet armed.
 */
/**
 * Whether a rule is allowed to do anything at all.
 *
 * The name is required, and that is not tidiness. A rule's name is what its tab, its card and its
 * report are called, so an unnamed one produces a session nobody can tell from another and a log
 * line that says nothing happened to nothing. The form refuses to enable one; this is the second
 * gate, for a rule that reached the file another way.
 */
export function canRun(rule: AutomationRule): boolean {
  return rule.enabled && rule.name.trim().length > 0;
}

export function evaluate(
  rules: readonly AutomationRule[],
  world: AutomationWorld,
  ledger: Readonly<Record<string, readonly string[]>>,
): AutomationDecision {
  const firings: AutomationFiring[] = [];
  const seen: Record<string, readonly string[]> = {};
  const armed: string[] = [];

  for (const rule of rules) {
    if (!canRun(rule) || isScheduled(rule.trigger)) {
      continue;
    }
    const targets = targetsFor(rule.trigger, world);
    const known = new Set(ledger[rule.id] ?? []);
    const fresh = targets.filter((target) => !known.has(target.id));

    /*
     * The ledger is rewritten to what is true NOW, every tick, even a tick that fires nothing.
     *
     * This is the line that makes a recurring alert recur: a target that has stopped being true
     * simply is not in the new list, so when it comes back it is fresh again. Written before the
     * `fresh.length === 0` shortcut would have been, because a tick where nothing is new is exactly
     * when things fall OUT, and skipping it would freeze the ledger at its high-water mark.
     */
    seen[rule.id] = targets.map((target) => target.id);

    if (fresh.length === 0) {
      continue;
    }
    if (rule.armed) {
      for (const target of fresh) {
        firings.push({
          ruleId: rule.id,
          ruleName: rule.name,
          target,
          action: rule.action,
          text: fillTemplate(rule.action.text, target.fields),
        });
      }
    } else {
      armed.push(rule.id);
    }
  }

  return { firings, seen, armed };
}

/**
 * A rule's prompt, made safe to sit inside the double quotes these command templates use.
 *
 * ⚠️ **This is the one place in the feature where free text reaches a shell, and it is worth being
 * precise about why it is only escaped rather than refused.** The ticket handoff appends its prompt
 * the same way and says in its own note that the quotes suffice *because* nothing a colleague wrote
 * reaches that line: a vetted issue key and a repository name through `safeRepoName`. A rule's
 * prompt is not that. It is free text, written by the person who owns the machine, in a settings
 * form, and it lands in `bash -ic "..."` where `$`, a backtick and a double quote all mean
 * something.
 *
 * So the backslash, the double quote, the dollar and the backtick are escaped, and newlines are
 * folded to spaces: a prompt is one argument, and a line break in it would end the command and run
 * the rest as a second one. What is NOT attempted is making this safe against a hostile author,
 * which would mean refusing the feature: whoever edits these rules already has a terminal.
 */
export function quotePrompt(text: string): string {
  return text
    .replace(/[\\$`"]/g, (char) => `\\${char}`)
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}
