import type { AutomationRule, TriggerKind } from '@shared/automation.js';
import { TRIGGER_KINDS, describeTrigger, isScheduled } from '@shared/automation.js';
import type { AutomationState, Project } from '@shared/contracts.js';
import { clearChildren, createElement, createIcon, createIconButton } from './dom.js';

/**
 * Rules that act on their own.
 *
 * The panel is a list and an editor, with no master-detail: a rule is six fields, which fits beside
 * its neighbours, and a third column for something you can read in a line would be the Git tab's
 * grammar applied where it buys nothing.
 *
 * ⚠️ **Everything here is disabled while the feature is off**, and the reason is stated on screen
 * rather than left to be discovered. This is the only surface in the app whose controls arm
 * something that then runs with nobody watching, so a form that looked live while the switch was off
 * would be the worst possible version of "a button that does nothing".
 */

export interface AutomationActions {
  readonly onSave: (rules: readonly AutomationRule[]) => void;
  /** Lets a rule act on a target again, or on all of them when the id is null. */
  readonly onForget: (ruleId: string, targetId: string | null) => void;
  /** Empties the activity list. The ledger is untouched: see the note on the channel. */
  readonly onClearLog: () => void;
}

export interface AutomationPanelState {
  readonly state: AutomationState | null;
  readonly projects: readonly Project[];
  readonly enabled: boolean;
  readonly shellEnabled: boolean;
}

/** Minutes past midnight as `HH:MM`, and back. The stored form is a number; the field is a clock. */
export function minutesToClock(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function clockToMinutes(value: string): number | null {
  const parts = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (parts === null) {
    return null;
  }
  const hours = Number(parts[1]);
  const minutes = Number(parts[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

/** A fresh rule, disabled and unarmed, which is the only safe pair of defaults. */
export function blankRule(): AutomationRule {
  return {
    id: `rule-${Math.random().toString(36).slice(2, 10)}`,
    /*
     * Born without a name, and that is the point.
     *
     * A default like "New rule" is a name, so the switch would accept it and the tab it spawns would
     * be called that. Empty, the switch is refused until the reader says what the rule is for, which
     * is the same sentence that ends up on the tab, the card and every line of the log.
     */
    name: '',
    enabled: false,
    trigger: 'pull-approved',
    atMinute: null,
    everyMinutes: null,
    action: { kind: 'notify', text: '', projectId: null },
    armed: false,
  };
}

/** The variables a trigger offers a template, so the form can say so instead of a manual saying it. */
export function fieldsFor(kind: TriggerKind): readonly string[] {
  switch (kind) {
    case 'pull-approved':
    case 'pull-checks-red':
      return ['repo', 'number', 'title', 'url', 'branch', 'author'];
    case 'server-broken':
      return ['project', 'phase', 'path'];
    case 'issue-assigned':
      return ['key', 'summary', 'status', 'url'];
    case 'schedule':
      return [];
  }
}

export function renderAutomationPanel(
  host: HTMLElement,
  view: AutomationPanelState,
  actions: AutomationActions,
): void {
  clearChildren(host);

  /*
   * A main column and a permanent aside.
   *
   * The log used to sit above the rules and it pushed them down for something nobody reads first: a
   * rule is the subject of this tab and its history is context. The column is always there, even
   * empty, which is the opposite of the pane grid's rule about empty cells and right here for a
   * reason that does not apply there: the rules would otherwise change width the first time
   * anything fired, and "nothing has happened yet" is itself the answer to the question this column
   * exists to answer.
   */
  const main = createElement('div', { className: 'automations__main' });
  host.append(main);

  if (!view.enabled) {
    main.append(
      createElement('p', {
        className: 'automations__off',
        text: 'Rules are turned off. Switch them on in the settings, under Rules, and this list becomes editable.',
      }),
    );
  }

  const state = view.state;
  if (state === null) {
    main.append(createElement('p', { className: 'automations__empty', text: 'Loading rules...' }));
    return;
  }

  const bar = createElement('div', { className: 'automations__bar' });
  const add = createElement('button', { className: 'button', text: 'Add a rule' });
  add.type = 'button';
  add.disabled = !view.enabled;
  add.addEventListener('click', () => {
    actions.onSave([...state.rules, blankRule()]);
  });
  bar.append(add);
  main.append(bar);

  /*
   * A refusal stays in the main column, and only the log moves.
   *
   * They read as one thing and are not: a refusal is a rule that will not work until something is
   * changed, so it belongs where the rules are and in the warning colour. The log is what has
   * already happened, which is the definition of context.
   */
  if (state.refusals.length > 0) {
    const box = createElement('div', { className: 'automations__refusals' });
    for (const line of state.refusals) {
      box.append(createElement('p', { className: 'automations__refusal', text: line }));
    }
    main.append(box);
  }

  if (state.rules.length === 0) {
    main.append(
      createElement('p', {
        className: 'automations__empty',
        text: 'No rule yet. A rule watches something this app already knows and acts on it once, on its own.',
      }),
    );
  } else {
    const list = createElement('div', { className: 'automations__list' });
    for (const rule of state.rules) {
      list.append(buildRule(rule, state, view, actions));
    }
    main.append(list);
  }

  // Always the grid's second child, empty or not.
  {
    const aside = createElement('aside', { className: 'automations__aside' });
    /*
     * A bell, and it is the only one in the app.
     *
     * The heading names what the column is rather than when it happened, because every line under it
     * already carries its own moment; a bell says "things that reached you" without a second word,
     * which is what a 220px column has room for.
     */
    const title = createElement('h4', { className: 'automations__recent-title' });
    title.append(
      createIcon('M8 2.5a3 3 0 0 1 3 3v2.2c0 .9.4 1.7 1 2.3H4c.6-.6 1-1.4 1-2.3V5.5a3 3 0 0 1 3-3zM6.6 12.2a1.6 1.6 0 0 0 2.8 0', {
        paint: 'stroke',
      }),
    );
    title.append(createElement('span', { text: 'Activity' }));

    /*
     * The cross clears the LOG and nothing else.
     *
     * Worth being exact about, because a cross next to a list is read as "forget all this": the
     * ledger that stops a rule firing twice lives behind a button that says `Let it fire again`, on
     * the rule itself, and clearing it from here would re-announce everything currently true.
     */
    const clear = createIconButton('M4 4l8 8M12 4l-8 8', {
      label: 'Clear the activity list',
      title: 'Clears this list. Rules keep what they have already acted on.',
      className: 'icon-button--row automations__clear',
    });
    clear.disabled = state.recent.length === 0;
    clear.addEventListener('click', () => {
      actions.onClearLog();
    });
    title.append(clear);
    aside.append(title);

    if (state.recent.length === 0) {
      aside.append(
        createElement('p', {
          className: 'automations__log automations__log--none',
          text: 'No activity yet. A rule reports here the moment it acts.',
        }),
      );
    }
    for (const line of state.recent) {
      aside.append(createElement('p', { className: 'automations__log', text: line }));
    }
    host.append(aside);
  }
}

function buildRule(
  rule: AutomationRule,
  state: AutomationState,
  view: AutomationPanelState,
  actions: AutomationActions,
): HTMLElement {
  const card = createElement('div', {
    className: `automation${rule.enabled ? '' : ' automation--off'}`,
  });
  const locked = !view.enabled;

  const replace = (next: AutomationRule): void => {
    actions.onSave(state.rules.map((entry) => (entry.id === rule.id ? next : entry)));
  };

  /* ---------------------------------------------------------------- head */
  const head = createElement('div', { className: 'automation__head' });

  /*
   * A rule with no name cannot be switched on.
   *
   * Refused here and again in `canRun`, the two gates this app puts in front of anything that acts
   * by itself. The name is what its tab, its card and its log lines are called, so an unnamed rule
   * produces a session indistinguishable from the next and a report that says nothing happened to
   * nothing.
   */
  const named = rule.name.trim().length > 0;
  const on = document.createElement('input');
  on.type = 'checkbox';
  on.checked = rule.enabled;
  on.disabled = locked || !named;
  on.title = named ? 'Enable this rule' : 'Name the rule first: its name is what its tab is called';
  on.setAttribute('aria-label', 'Enable this rule');
  on.addEventListener('change', () => {
    replace({ ...rule, enabled: on.checked });
  });
  head.append(on);

  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'automation__name';
  name.value = rule.name;
  name.disabled = locked;
  name.placeholder = 'Name this rule';
  name.classList.toggle('automation__name--missing', !named);
  name.setAttribute('aria-label', 'Rule name');
  // On `change` and never on `input`: a save broadcasts, the panel rebuilds, and a field rebuilt on
  // every keystroke loses the caret. Same guard the project table's rename needs.
  name.addEventListener('change', () => {
    // Clearing the name of a live rule switches it off rather than leaving it running under no
    // name: the engine would refuse it anyway, and a rule shown as on while it is ignored is worse
    // than one shown as off.
    const next = name.value;
    replace({ ...rule, name: next, enabled: next.trim().length === 0 ? false : rule.enabled });
  });
  head.append(name);

  const remove = createIconButton('M4 4l8 8M12 4l-8 8', {
    label: 'Delete this rule',
    title: 'Delete this rule',
    className: 'icon-button--row',
  });
  remove.disabled = locked;
  remove.addEventListener('click', () => {
    actions.onSave(state.rules.filter((entry) => entry.id !== rule.id));
  });
  head.append(remove);
  card.append(head);

  /* ------------------------------------------------------------- trigger */
  const when = createElement('div', { className: 'automation__row' });
  when.append(createElement('span', { className: 'automation__label', text: 'When' }));

  const trigger = document.createElement('select');
  trigger.className = 'automation__select';
  trigger.disabled = locked;
  trigger.setAttribute('aria-label', 'What this rule watches');
  for (const kind of TRIGGER_KINDS) {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = describeTrigger(kind);
    option.selected = kind === rule.trigger;
    trigger.append(option);
  }
  trigger.addEventListener('change', () => {
    const kind = TRIGGER_KINDS.find((entry) => entry === trigger.value) ?? rule.trigger;
    /*
     * Changing the trigger clears the schedule, and the main process clears the ledger.
     *
     * Two halves of one rule: what a rule watches decides what its other fields mean, so carrying
     * an old `atMinute` onto an event trigger would leave a value nothing reads and that comes back
     * if the trigger is switched again.
     */
    replace({
      ...rule,
      trigger: kind,
      atMinute: isScheduled(kind) ? rule.atMinute : null,
      everyMinutes: isScheduled(kind) ? rule.everyMinutes : null,
    });
  });
  when.append(trigger);
  card.append(when);

  if (isScheduled(rule.trigger)) {
    card.append(buildSchedule(rule, locked, replace));
  }

  /* -------------------------------------------------------------- action */
  const does = createElement('div', { className: 'automation__row' });
  does.append(createElement('span', { className: 'automation__label', text: 'Then' }));

  const kind = document.createElement('select');
  kind.className = 'automation__select automation__select--narrow';
  kind.disabled = locked;
  kind.setAttribute('aria-label', 'What this rule does');
  for (const [value, label] of [
    ['notify', 'Notify me'],
    ['agent', 'Start an agent'],
    ['shell', 'Run a command'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === rule.action.kind;
    kind.append(option);
  }
  kind.addEventListener('change', () => {
    const next = kind.value === 'agent' || kind.value === 'shell' ? kind.value : 'notify';
    replace({ ...rule, action: { ...rule.action, kind: next } });
  });
  does.append(kind);

  const where = document.createElement('select');
  where.className = 'automation__select automation__select--narrow';
  where.disabled = locked || rule.action.kind === 'notify';
  where.setAttribute('aria-label', 'Which project the tab opens in');
  const any = document.createElement('option');
  any.value = '';
  any.textContent = 'The matching project';
  any.selected = rule.action.projectId === null;
  where.append(any);
  for (const project of view.projects) {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.label;
    option.selected = project.id === rule.action.projectId;
    where.append(option);
  }
  where.addEventListener('change', () => {
    replace({
      ...rule,
      action: { ...rule.action, projectId: where.value.length === 0 ? null : where.value },
    });
  });
  does.append(where);
  card.append(does);

  const text = document.createElement('textarea');
  text.className = 'automation__text';
  text.rows = 2;
  text.value = rule.action.text;
  text.disabled = locked;
  text.setAttribute(
    'aria-label',
    rule.action.kind === 'shell' ? 'The command to run' : 'The text to send',
  );
  text.addEventListener('change', () => {
    replace({ ...rule, action: { ...rule.action, text: text.value } });
  });
  card.append(text);

  const fields = fieldsFor(rule.trigger);
  if (fields.length > 0) {
    card.append(
      createElement('p', {
        className: 'automation__hint',
        text: `Available: ${fields.map((field) => `{{${field}}}`).join(' ')}`,
      }),
    );
  }

  /*
   * The one refusal a rule can carry on its own row.
   *
   * A shell action under a switch that is off is a rule that looks configured and will never run.
   * Said here rather than only in the tick's report, because the tick only speaks when the rule
   * matches, and a rule nobody has triggered yet would be silent for days.
   */
  if (rule.action.kind === 'shell' && !view.shellEnabled) {
    card.append(
      createElement('p', {
        className: 'automation__warn',
        text: 'Running a command from a rule is turned off in the settings, so this rule will refuse.',
      }),
    );
  }

  /* -------------------------------------------------------------- memory */
  const remembered = state.ledger[rule.id] ?? [];
  if (remembered.length > 0) {
    const foot = createElement('div', { className: 'automation__foot' });
    foot.append(
      createElement('span', {
        className: 'automation__hint',
        text: `${String(remembered.length)} already acted on`,
      }),
    );
    const forget = createElement('button', {
      className: 'button button--quiet',
      text: 'Let it fire again',
    });
    forget.type = 'button';
    forget.disabled = locked;
    forget.title =
      'Forgets what this rule has acted on, so anything still true counts as new. The rule keeps its settings.';
    forget.addEventListener('click', () => {
      actions.onForget(rule.id, null);
    });
    foot.append(forget);
    card.append(foot);
  }

  if (!rule.armed && rule.enabled) {
    card.append(
      createElement('p', {
        className: 'automation__hint',
        text: 'Not armed yet: the next check records what is already true without acting on it.',
      }),
    );
  }

  return card;
}

function buildSchedule(
  rule: AutomationRule,
  locked: boolean,
  replace: (next: AutomationRule) => void,
): HTMLElement {
  const row = createElement('div', { className: 'automation__row' });
  row.append(createElement('span', { className: 'automation__label', text: 'At' }));

  const clock = document.createElement('input');
  clock.type = 'text';
  clock.className = 'automation__clock';
  clock.placeholder = '09:00';
  clock.value = rule.atMinute === null ? '' : minutesToClock(rule.atMinute);
  clock.disabled = locked;
  clock.setAttribute('aria-label', 'Time of day, as HH:MM');
  clock.addEventListener('change', () => {
    const minutes = clockToMinutes(clock.value);
    // An unreadable time clears both, so the rule says "when" in neither way and `isDue` refuses it.
    // Better a rule that does not run than one that runs at an hour nobody typed.
    replace({ ...rule, atMinute: minutes, everyMinutes: minutes === null ? rule.everyMinutes : null });
  });
  row.append(clock);

  row.append(createElement('span', { className: 'automation__label', text: 'or every' }));

  const every = document.createElement('input');
  every.type = 'number';
  every.min = '1';
  every.className = 'automation__every';
  every.value = rule.everyMinutes === null ? '' : String(rule.everyMinutes);
  every.disabled = locked;
  every.setAttribute('aria-label', 'Interval in minutes');
  every.addEventListener('change', () => {
    const minutes = Number(every.value);
    const usable = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null;
    replace({ ...rule, everyMinutes: usable, atMinute: usable === null ? rule.atMinute : null });
  });
  row.append(every);
  row.append(createElement('span', { className: 'automation__label', text: 'minutes' }));
  return row;
}
