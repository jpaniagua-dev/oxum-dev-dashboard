import type { TerminalId } from '@shared/contracts.js';
import type { VaultCard, VaultState } from '@shared/vault.js';
import {
  EXPIRY_CHOICES,
  HINT_LIMIT,
  NAME_LIMIT,
  describeExpiry,
  describeExpiryChoice,
  expiryFrom,
} from '@shared/vault.js';
import { clearChildren, createElement, createIconButton } from './dom.js';

/**
 * The vault: secrets kept encrypted, handed to a session on a gesture.
 *
 * ⚠️ **The panel says what it does not protect, permanently and at the top.** A value typed into a
 * session is in that agent's context and in its transcript from then on, which is a fact about
 * agents and not about this app. A coffre that let its owner forget that would be worse than a
 * `.env`, because it would feel safe.
 *
 * `Copy` is the primary and `Reveal` the secondary, which is the other way round from how the
 * feature was first sketched. Copying happens entirely in the main process, so the value never
 * enters this window at all; revealing paints it on a screen that gets shared and screenshotted.
 * Same intent, strictly less exposure, so it gets the prominent button.
 */

export interface VaultActions {
  readonly onSave: (card: VaultCard, value: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onReveal: (id: string) => Promise<string>;
  readonly onSend: (id: string, terminalId: TerminalId) => void;
  readonly onCopy: (id: string) => void;
  readonly onReset: () => void;
}

export interface VaultPanelState {
  readonly state: VaultState | null;
  /** The session a `Send` would type into, or null when none is focused. */
  readonly target: TerminalId | null;
  readonly targetTitle: string;
}

/**
 * How long a revealed value stays on screen.
 *
 * Twenty seconds, and it re-masks on its own rather than waiting for a second click: the risk this
 * gesture carries is not the click, it is walking away from the click.
 */
export const REVEAL_MS = 20_000;

/** A fresh card, unnamed and with no expiry, so nothing is chosen on the reader's behalf. */
export function blankCard(now: Date): VaultCard {
  return {
    id: `card-${Math.random().toString(36).slice(2, 10)}`,
    name: '',
    hint: '',
    createdAt: now.toISOString(),
    expiresAt: null,
  };
}

interface Draft {
  name: string;
  hint: string;
  value: string;
  minutes: number | null;
}

let draft: Draft | null = null;
/** The card whose value is on screen, and the timer that takes it off again. */
let revealed: { id: string; value: string } | null = null;
let revealTimer: number | null = null;

export function renderVaultPanel(
  host: HTMLElement,
  view: VaultPanelState,
  actions: VaultActions,
): void {
  clearChildren(host);
  const state = view.state;
  if (state === null) {
    host.append(createElement('p', { className: 'vault__empty', text: 'Opening the vault...' }));
    return;
  }

  host.append(
    createElement('p', {
      className: 'vault__warning',
      text: 'Encrypted here, for this Windows account only. Once a value is typed into a session, the agent holds it: it is in that agent’s context and written to its own transcript, and nothing here can take it back.',
    }),
  );

  if (!state.available) {
    host.append(
      createElement('p', {
        className: 'vault__blocked',
        text: 'This machine cannot encrypt, so nothing can be saved. Storing a secret in the clear because the safe was locked is the one thing this app will not do.',
      }),
    );
    return;
  }

  if (state.unreadable) {
    const box = createElement('div', { className: 'vault__blocked' });
    box.append(
      createElement('p', {
        className: 'vault__blocked-text',
        text: 'There is a vault here that this Windows account cannot decrypt. It was left untouched: it may still be readable by signing back in as the account that wrote it.',
      }),
    );
    const reset = createElement('button', { className: 'button', text: 'Start a new vault' });
    reset.type = 'button';
    reset.title = 'Throws the unreadable vault away for good, after a confirmation.';
    reset.addEventListener('click', () => {
      actions.onReset();
    });
    box.append(reset);
    host.append(box);
    return;
  }

  host.append(buildForm(view, actions));

  if (state.cards.length === 0) {
    host.append(
      createElement('p', {
        className: 'vault__empty',
        text: 'No secret yet.',
      }),
    );
    return;
  }

  const now = new Date();
  const list = createElement('div', { className: 'vault__list' });
  for (const card of state.cards) {
    list.append(buildCard(card, view, actions, now, host));
  }
  host.append(list);
}

/* ------------------------------------------------------------------ *
 * Adding
 * ------------------------------------------------------------------ */

function buildForm(view: VaultPanelState, actions: VaultActions): HTMLElement {
  const box = createElement('div', { className: 'vault__form' });

  if (draft === null) {
    const add = createElement('button', { className: 'button', text: 'Add a secret' });
    add.type = 'button';
    add.addEventListener('click', () => {
      draft = { name: '', hint: '', value: '', minutes: null };
      repaint(view, actions);
    });
    box.append(add);
    return box;
  }

  const open = draft;
  const row = createElement('div', { className: 'vault__form-row' });

  const name = field('Name', open.name, NAME_LIMIT, (value) => {
    open.name = value;
  });
  row.append(name);

  const hint = field('What it opens', open.hint, HINT_LIMIT, (value) => {
    open.hint = value;
  });
  row.append(hint);
  box.append(row);

  const secret = document.createElement('input');
  secret.type = 'password';
  secret.className = 'vault__value';
  secret.autocomplete = 'off';
  secret.placeholder = 'The secret itself';
  secret.setAttribute('aria-label', 'The secret itself');
  secret.addEventListener('input', () => {
    open.value = secret.value;
  });
  box.append(secret);

  const bottom = createElement('div', { className: 'vault__form-row' });
  const expiry = document.createElement('select');
  expiry.className = 'vault__select';
  expiry.setAttribute('aria-label', 'When it destroys itself');
  for (const choice of EXPIRY_CHOICES) {
    const option = document.createElement('option');
    option.value = choice === null ? '' : String(choice);
    option.textContent = describeExpiryChoice(choice);
    option.selected = choice === open.minutes;
    expiry.append(option);
  }
  expiry.addEventListener('change', () => {
    open.minutes = expiry.value.length === 0 ? null : Number(expiry.value);
  });
  bottom.append(expiry);

  /*
   * The expiry is chosen once and cannot be edited later, said here rather than discovered.
   *
   * A lifetime runs from creation, so replacing a value under an existing card would leave the new
   * secret inheriting the old one's remaining life. Rotating a key is delete and add.
   */
  bottom.append(
    createElement('span', {
      className: 'vault__hint',
      text: 'Chosen once: a card keeps its value and its expiry. Rotating a key is delete and add.',
    }),
  );
  box.append(bottom);

  const buttons = createElement('div', { className: 'vault__form-row' });
  const save = createElement('button', { className: 'button button--primary', text: 'Save' });
  save.type = 'button';
  save.addEventListener('click', () => {
    const now = new Date();
    const card = blankCard(now);
    actions.onSave(
      { ...card, name: open.name, hint: open.hint, expiresAt: expiryFrom(card.createdAt, open.minutes) },
      open.value,
    );
    draft = null;
  });
  buttons.append(save);

  const cancel = createElement('button', { className: 'button button--quiet', text: 'Cancel' });
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    draft = null;
    repaint(view, actions);
  });
  buttons.append(cancel);
  box.append(buttons);
  return box;
}

function field(
  label: string,
  value: string,
  limit: number,
  onChange: (next: string) => void,
): HTMLElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'vault__field';
  input.value = value;
  input.maxLength = limit;
  input.placeholder = label;
  input.setAttribute('aria-label', label);
  // On `input` and not `change`: the draft lives in this module and nothing repaints under it, so
  // there is no caret to lose, and the Save button must see the last character typed.
  input.addEventListener('input', () => {
    onChange(input.value);
  });
  return input;
}

/* ------------------------------------------------------------------ *
 * A card
 * ------------------------------------------------------------------ */

function buildCard(
  card: VaultCard,
  view: VaultPanelState,
  actions: VaultActions,
  now: Date,
  host: HTMLElement,
): HTMLElement {
  const box = createElement('div', { className: 'vault__card' });

  /*
   * The head carries the name, the expiry and the delete, which is what keeps the card short.
   *
   * `Delete` was a fourth button in the row below, and four buttons in a 340px track wrap onto a
   * second line: the card grew by a row for a gesture used once in its life. As an icon in the head
   * it costs nothing, and it sits where the Rules card puts its own delete.
   */
  const head = createElement('div', { className: 'vault__card-head' });
  head.append(createElement('span', { className: 'vault__card-name', text: card.name }));
  head.append(
    createElement('span', { className: 'vault__card-expiry', text: describeExpiry(card, now) }),
  );
  const remove = createIconButton('M4 4l8 8M12 4l-8 8', {
    label: `Delete ${card.name}`,
    title: 'Delete this secret. It cannot be brought back.',
    className: 'icon-button--row',
  });
  remove.addEventListener('click', () => {
    actions.onDelete(card.id);
  });
  head.append(remove);
  box.append(head);

  if (card.hint.length > 0) {
    box.append(createElement('span', { className: 'vault__hint', text: card.hint }));
  }

  /*
   * A constant mask, never one sized from the value.
   *
   * A mask as long as the secret tells an onlooker whether it is a six-digit PIN or a sixty-four
   * character key, which is a third of the answer given away by a decoration.
   */
  const shown = revealed !== null && revealed.id === card.id;
  /*
   * One line, clipped, and never a block that grows with the secret.
   *
   * A `<pre>` wrapping a sixty-four character key made the card three lines taller than its
   * neighbours, and the height of a card was then a function of the length of what it held, which
   * is the same thing the constant mask exists to hide.
   */
  box.append(
    createElement('div', {
      className: `vault__secret${shown ? ' vault__secret--shown' : ''}`,
      text: shown ? (revealed?.value ?? '') : '•'.repeat(12),
      title: shown ? 'Click Hide, or wait: it masks itself again.' : '',
    }),
  );

  const row = createElement('div', { className: 'vault__card-row' });

  const copy = createElement('button', { className: 'button button--primary', text: 'Copy' });
  copy.type = 'button';
  copy.title =
    'Copies the value without it passing through this window. Windows keeps a clipboard history.';
  copy.addEventListener('click', () => {
    actions.onCopy(card.id);
  });
  row.append(copy);

  const send = createElement('button', { className: 'button', text: 'Send' });
  send.type = 'button';
  send.disabled = view.target === null;
  send.title =
    view.target === null
      ? 'No session is focused: open or click a terminal first.'
      : `Types the value at the prompt of ${view.targetTitle}, without submitting it.`;
  send.addEventListener('click', () => {
    if (view.target !== null) {
      actions.onSend(card.id, view.target);
    }
  });
  row.append(send);

  const reveal = createElement('button', {
    className: 'button button--quiet',
    text: shown ? 'Hide' : 'Reveal',
  });
  reveal.type = 'button';
  reveal.title = shown
    ? 'Hide it again'
    : `Shows it here for ${String(REVEAL_MS / 1000)} seconds. It is on your screen, so it is in any screenshot or shared screen.`;
  reveal.addEventListener('click', () => {
    if (shown) {
      hideReveal(view, actions);
      return;
    }
    void actions.onReveal(card.id).then((value) => {
      if (value.length === 0) {
        return;
      }
      revealed = { id: card.id, value };
      armHide(view, actions);
      repaint(view, actions, host);
    });
  });
  row.append(reveal);
  box.append(row);
  return box;
}

/* ------------------------------------------------------------------ *
 * The reveal window
 * ------------------------------------------------------------------ */

/**
 * Takes a revealed value off the screen, and off this module's state.
 *
 * Exported so the app can call it when the window loses focus or the tab changes: the risk a
 * reveal carries is not the click, it is the value still being there when somebody walks away or
 * shares their screen.
 */
export function hideReveal(view: VaultPanelState, actions: VaultActions, host?: HTMLElement): void {
  if (revealTimer !== null) {
    window.clearTimeout(revealTimer);
    revealTimer = null;
  }
  if (revealed === null) {
    return;
  }
  revealed = null;
  repaint(view, actions, host);
}

function armHide(view: VaultPanelState, actions: VaultActions): void {
  if (revealTimer !== null) {
    window.clearTimeout(revealTimer);
  }
  revealTimer = window.setTimeout(() => {
    revealed = null;
    revealTimer = null;
    repaint(view, actions);
  }, REVEAL_MS);
}

/** True while a value is on screen, so the app knows whether a blur has anything to hide. */
export function isRevealing(): boolean {
  return revealed !== null;
}

let lastHost: HTMLElement | null = null;

function repaint(view: VaultPanelState, actions: VaultActions, host?: HTMLElement): void {
  const target = host ?? lastHost;
  if (target !== null) {
    lastHost = target;
    renderVaultPanel(target, view, actions);
  }
}

/** Remembers where to repaint, so a timer firing later knows which element to redraw. */
export function bindVaultHost(host: HTMLElement): void {
  lastHost = host;
}
