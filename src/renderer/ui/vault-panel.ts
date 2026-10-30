import type { VaultFileCard, VaultSecretInput, VaultState } from '@shared/vault.js';
import {
  DEFAULT_LIFETIME_MINUTES,
  EXPIRY_CHOICES,
  NAME_LIMIT,
  VAULT_FILE_PATH_LIMIT,
  VAULT_TEXT_LIMIT,
  describeExpiryChoice,
  describeFileState,
  sanitizeVaultFileBinding,
  sanitizeVaultText,
  sanitizeVaultVariableName,
  secretConflict,
} from '@shared/vault.js';
import { clearChildren, createElement, createIconButton } from './dom.js';

/**
 * The vault: one card per project file, its secrets encrypted and its text in clear, written into
 * the project on demand and removed again when its lifetime is over.
 *
 * A generated file keeps a value out of the agent prompt, not away from processes in that project;
 * that boundary is explained on demand by the compact `How it works` disclosure. Copy and the
 * short-lived eye reveal remain manual escape hatches.
 */

export interface VaultActions {
  readonly onSave: (
    card: VaultFileCard,
    secrets: readonly VaultSecretInput[],
  ) => Promise<{ ok: boolean; message: string }>;
  readonly onDelete: (id: string) => void;
  readonly onReveal: (id: string, name: string) => Promise<string>;
  readonly onCopy: (id: string, name: string) => void;
  readonly onGenerateFile: (id: string) => void;
  readonly onReset: () => void;
}

export interface VaultPanelState {
  readonly state: VaultState | null;
  readonly targetProjectId: string | null;
  readonly projects: readonly { readonly id: string; readonly label: string }[];
}

/**
 * How long a revealed value stays on screen.
 *
 * Twenty seconds, and it re-masks on its own rather than waiting for a second click: the risk this
 * gesture carries is not the click, it is walking away from the click.
 */
export const REVEAL_MS = 20_000;

const INFO_ICON = 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 7v3.5M8 5h.01';
const EYE_ICON =
  'M1.5 8s2.25-4 6.5-4 6.5 4 6.5 4-2.25 4-6.5 4S1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z';
const COPY_ICON = 'M5.5 5.5h7v7h-7zM3.5 10.5h-1v-8h8v1';
const EDIT_ICON = 'M2 4h5m2 0h5M7 2v4M2 10h2m2 0h8M4 8v4';
const CLOSE_ICON = 'M4 4l8 8M12 4l-8 8';

interface SecretRow {
  /** Stable for the life of the form, so a repaint puts the caret back in the same field. */
  readonly key: string;
  name: string;
  value: string;
  /** The stored name of an existing secret, `null` for a row added in this form. */
  readonly from: string | null;
}

interface Draft {
  /** The card being edited, `null` for a new one. */
  readonly card: VaultFileCard | null;
  projectId: string;
  path: string;
  minutes: number | null;
  rows: SecretRow[];
  text: string;
  error: string;
  saving: boolean;
}

let draft: Draft | null = null;
let helpOpen = false;
let rowCounter = 0;
/** A field to focus on the next paint, for the gesture that just created it. */
let pendingFocus: string | null = null;
/** The secret whose value is on screen, and the timer that takes it off again. */
let revealed: { id: string; name: string; value: string } | null = null;
let revealTimer: number | null = null;

export function renderVaultPanel(
  host: HTMLElement,
  view: VaultPanelState,
  actions: VaultActions,
): void {
  lastHost = host;
  lastView = view;
  lastActions = actions;
  const focus = captureFocus(host);
  clearChildren(host);
  host.append(buildVaultHelp(view));
  const state = view.state;
  if (state === null) {
    host.append(createElement('p', { className: 'vault__empty', text: 'Opening the vault…' }));
    return;
  }

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

  if (state.cards.length === 0 && draft === null) {
    host.append(
      createElement('p', {
        className: 'vault__empty',
        text: 'No file yet. Create one to write a dotenv file, ignored by Git, into a project.',
      }),
    );
    return;
  }

  const now = new Date();
  const files = createElement('div', { className: 'vault__files' });
  if (draft !== null && draft.card === null) {
    files.append(buildEditor(draft, view, actions));
  }
  for (const card of state.cards) {
    files.append(
      draft?.card?.id === card.id
        ? buildEditor(draft, view, actions)
        : buildCard(card, view, actions, now),
    );
  }
  host.append(files);
  restoreFocus(host, focus);
}

function buildVaultHelp(view: VaultPanelState): HTMLElement {
  const wrap = createElement('div', { className: 'vault__intro' });
  const toolbar = createElement('div', { className: 'vault__toolbar' });
  const help = createElement('div', { className: 'vault__help' });
  help.id = 'vault-how-it-works';
  help.hidden = !helpOpen;
  help.append(createElement('p', { className: 'vault__help-title', text: 'How it works' }));
  const steps = document.createElement('ol');
  steps.className = 'vault__help-steps';
  for (const text of [
    'A card is one file: its project, its path such as .env.local, and how long a generated file stays on disk.',
    'Secrets are stored encrypted and masked here. The text holds plain lines such as EMAIL=me@example.com, stored with them but shown in clear.',
    'Generate file writes it into the project, only to a path ignored by Git. It is plaintext to the processes of that project, agents included, until its time is up; then it is removed and the vault keeps the values.',
  ]) {
    steps.append(createElement('li', { text }));
  }
  help.append(steps);

  const info = createIconButton(INFO_ICON, {
    label: 'How the Vault works',
    title: 'How it works',
    className: 'vault__info',
  });
  info.setAttribute('aria-expanded', String(helpOpen));
  info.setAttribute('aria-controls', 'vault-how-it-works');
  info.addEventListener('click', () => {
    helpOpen = !helpOpen;
    info.setAttribute('aria-expanded', String(helpOpen));
    help.hidden = !helpOpen;
  });
  const add = createElement('button', {
    className: 'button button--primary vault__new-file',
    text: 'New file',
  });
  add.type = 'button';
  add.disabled =
    draft !== null || view.state === null || !view.state.available || view.state.unreadable;
  add.addEventListener('click', () => {
    draft = newDraft(view);
    pendingFocus = 'path';
    repaint();
  });
  toolbar.append(add, info);
  wrap.append(toolbar, help);
  return wrap;
}

/* ------------------------------------------------------------------ *
 * A card
 * ------------------------------------------------------------------ */

function buildCard(
  card: VaultFileCard,
  view: VaultPanelState,
  actions: VaultActions,
  now: Date,
): HTMLElement {
  const section = createElement('section', { className: 'vault__file' });
  const head = createElement('div', { className: 'vault__file-head' });
  const identity = createElement('div', { className: 'vault__file-identity' });
  const project = view.projects.find((entry) => entry.id === card.binding.projectId);
  identity.append(
    createElement('span', {
      className: 'vault__file-project',
      text: project?.label ?? 'Unknown project',
    }),
    createElement('code', { className: 'vault__file-path', text: card.binding.path }),
    createElement('span', {
      className: 'vault__file-state',
      text: describeFileState(card, now),
    }),
  );
  const tools = createElement('div', { className: 'vault__card-actions' });
  const edit = createIconButton(EDIT_ICON, {
    label: `Edit ${card.binding.path}`,
    title: 'Edit this file: its place, its lifetime, its secrets and its text.',
    className: 'icon-button--row',
  });
  edit.disabled = draft !== null;
  edit.addEventListener('click', () => {
    draft = draftFor(card);
    repaint();
  });
  tools.append(edit);
  head.append(identity, tools);
  section.append(head);

  if (card.secrets.length > 0) {
    const list = createElement('div', { className: 'vault__variables' });
    for (const name of card.secrets) {
      const row = createElement('div', { className: 'vault__secret-row' });
      row.append(
        createElement('span', { className: 'vault__secret-name', text: name, title: name }),
        buildSecretControl(card.id, name, actions),
      );
      list.append(row);
    }
    section.append(list);
  }
  if (card.text.trim().length > 0) {
    section.append(createElement('pre', { className: 'vault__text', text: card.text }));
  }

  const footer = createElement('footer', { className: 'vault__file-footer' });
  const count = card.secrets.length;
  footer.append(
    createElement('span', {
      className: 'vault__file-count',
      text: `${String(count)} ${count === 1 ? 'secret' : 'secrets'}`,
    }),
  );
  const fileActions = createElement('div', { className: 'vault__file-actions' });
  const generate = createElement('button', {
    className: 'button button--primary vault__generate',
    text: 'Generate file',
  });
  generate.type = 'button';
  generate.title =
    card.lifetimeMinutes === null
      ? 'Write the file into the project. It stays until the card is removed.'
      : `Write the file into the project. It is removed after ${describeExpiryChoice(card.lifetimeMinutes)}.`;
  generate.addEventListener('click', () => actions.onGenerateFile(card.id));
  /*
   * The card is the file, so removing one removes the other: the generated file from the disk and
   * the card from the vault, values included. One gesture for both, after a confirmation.
   */
  const removeFile = createElement('button', {
    className: 'button button--quiet vault__remove-file',
    text: 'Remove file',
  });
  removeFile.type = 'button';
  removeFile.title =
    'Delete the generated file from the project and this card from the vault, secrets and text included. It cannot be brought back.';
  removeFile.setAttribute('aria-label', `Remove ${card.binding.path}`);
  removeFile.addEventListener('click', () => actions.onDelete(card.id));
  fileActions.append(generate, removeFile);
  footer.append(fileActions);
  section.append(footer);
  return section;
}

function buildSecretControl(id: string, name: string, actions: VaultActions): HTMLElement {
  const shown = revealed?.id === id && revealed.name === name;
  const control = createElement('div', {
    className: `vault__secret-control${shown ? ' vault__secret-control--shown' : ''}`,
  });
  control.append(
    createElement('div', {
      className: 'vault__secret',
      text: shown ? (revealed?.value ?? '') : '•'.repeat(12),
      title: shown ? 'This value masks itself again after 20 seconds.' : 'Secret',
    }),
  );

  const copy = createIconButton(COPY_ICON, {
    label: `Copy ${name}`,
    title: 'Copy secret. Windows may keep a clipboard history.',
    className: 'vault__secret-action',
  });
  copy.addEventListener('click', () => actions.onCopy(id, name));
  control.append(copy);

  const reveal = createIconButton(EYE_ICON, {
    label: shown ? `Hide ${name}` : `Reveal ${name}`,
    title: shown
      ? 'Hide secret'
      : `Reveal for ${String(REVEAL_MS / 1000)} seconds. It may appear in screenshots or screen sharing.`,
    className: 'vault__secret-action',
  });
  reveal.setAttribute('aria-pressed', String(shown));
  reveal.addEventListener('click', () => {
    if (shown) {
      hideCurrentReveal();
      return;
    }
    void actions.onReveal(id, name).then((value) => {
      if (value.length === 0) {
        return;
      }
      revealed = { id, name, value };
      armHide();
      repaint();
    });
  });
  control.append(reveal);
  return control;
}

/* ------------------------------------------------------------------ *
 * The editor: where the file goes, its secrets, then its text
 * ------------------------------------------------------------------ */

function buildEditor(open: Draft, view: VaultPanelState, actions: VaultActions): HTMLElement {
  const section = createElement('section', { className: 'vault__file vault__file--editing' });
  const box = createElement('div', { className: 'vault__editor' });
  box.append(
    createElement('span', {
      className: 'vault__editor-title',
      text: open.card === null ? 'New file' : `Edit ${open.card.binding.path}`,
    }),
  );

  const target = createElement('div', { className: 'vault__file-target' });
  const project = document.createElement('select');
  project.className = 'vault__select';
  project.setAttribute('aria-label', 'Project that receives the file');
  for (const entry of view.projects) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    option.selected = entry.id === open.projectId;
    project.append(option);
  }
  project.addEventListener('change', () => {
    open.projectId = project.value;
    open.error = '';
  });
  const path = field(
    'File, for example .env.local',
    open.path,
    VAULT_FILE_PATH_LIMIT,
    'path',
    (value) => {
      open.path = value;
      open.error = '';
    },
  );
  path.classList.add('vault__field--mono');
  const lifetime = createElement('label', {
    className: 'vault__inline-label',
    text: 'Removed after',
  });
  const expiry = document.createElement('select');
  expiry.className = 'vault__select';
  expiry.title = 'How long a generated file stays on disk. The vault keeps the values either way.';
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
  lifetime.append(expiry);
  target.append(project, path, lifetime);
  box.append(target);

  const rows = createElement('div', { className: 'vault__rows' });
  for (const row of open.rows) {
    rows.append(buildRowEditor(open, row));
  }
  box.append(rows);
  const add = createElement('button', {
    className: 'button button--quiet vault__add-secret',
    text: '+ Secret',
  });
  add.type = 'button';
  add.addEventListener('click', () => {
    const row = newRow();
    open.rows.push(row);
    pendingFocus = `${row.key}:name`;
    repaint();
  });
  box.append(add);

  const text = document.createElement('textarea');
  text.className = 'vault__text-input';
  text.value = open.text;
  text.rows = 4;
  text.maxLength = VAULT_TEXT_LIMIT;
  text.spellcheck = false;
  text.placeholder = 'EMAIL=me@example.com';
  text.setAttribute('aria-label', 'Text written into the file as it is');
  text.dataset['focusKey'] = 'text';
  text.addEventListener('input', () => {
    open.text = text.value;
    open.error = '';
  });
  box.append(
    text,
    createElement('span', {
      className: 'vault__hint',
      text: 'Written into the file as it is, above the secrets. Stored with them, but shown in clear: keep secrets in the rows above.',
    }),
  );

  if (open.error.length > 0) {
    box.append(createElement('p', { className: 'vault__form-error', text: open.error }));
  }

  const buttons = createElement('div', { className: 'vault__editor-actions' });
  const save = createElement('button', {
    className: 'button button--primary',
    text: open.saving ? 'Saving…' : 'Save',
  });
  save.type = 'button';
  save.disabled = open.saving;
  save.addEventListener('click', () => submit(open, actions));
  const cancel = createElement('button', { className: 'button button--quiet', text: 'Cancel' });
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    draft = null;
    repaint();
  });
  buttons.append(save, cancel);
  box.append(buttons);
  section.append(box);
  return section;
}

function buildRowEditor(open: Draft, row: SecretRow): HTMLElement {
  const line = createElement('div', { className: 'vault__row-edit' });
  const name = field('Name', row.name, NAME_LIMIT, `${row.key}:name`, (value) => {
    row.name = value;
    open.error = '';
  });
  name.classList.add('vault__field--mono');

  const control = createElement('div', { className: 'vault__secret-control' });
  const secret = document.createElement('input');
  secret.type = 'password';
  secret.className = 'vault__value';
  secret.autocomplete = 'off';
  // The form is never told a stored value, so an existing secret starts empty and stays as it is.
  secret.placeholder = row.from === null ? 'Secret' : 'Unchanged';
  secret.setAttribute('aria-label', row.from === null ? 'Secret' : `New value for ${row.from}`);
  secret.value = row.value;
  secret.dataset['focusKey'] = `${row.key}:value`;
  secret.addEventListener('input', () => {
    row.value = secret.value;
    open.error = '';
  });
  const reveal = createIconButton(EYE_ICON, {
    label: 'Show secret',
    title: 'Show secret while entering it',
    className: 'vault__secret-action',
  });
  reveal.addEventListener('click', () => {
    const showing = secret.type === 'text';
    secret.type = showing ? 'password' : 'text';
    reveal.setAttribute('aria-label', showing ? 'Show secret' : 'Hide secret');
    reveal.title = showing ? 'Show secret while entering it' : 'Hide secret';
    reveal.setAttribute('aria-pressed', String(!showing));
  });
  control.append(secret, reveal);

  const remove = createIconButton(CLOSE_ICON, {
    label: row.name.length > 0 ? `Remove ${row.name}` : 'Remove this secret',
    title: 'Remove this secret from the file. Nothing changes until Save.',
    className: 'vault__secret-action',
  });
  remove.addEventListener('click', () => {
    open.rows = open.rows.filter((entry) => entry !== row);
    open.error = '';
    repaint();
  });
  line.append(name, control, remove);
  return line;
}

/**
 * Checks the form, then hands it to the main process, which checks it again.
 *
 * The form stays open until the answer comes back, so a refusal (another card already writes
 * that file) leaves what was typed where it was rather than losing it with the form.
 */
function submit(open: Draft, actions: VaultActions): void {
  const fail = (message: string): void => {
    open.error = message;
    repaint();
  };
  const binding = sanitizeVaultFileBinding({
    kind: 'dotenv',
    projectId: open.projectId,
    path: open.path,
  });
  if (binding === null) {
    fail('Choose a project and a path inside it, for example .env.local.');
    return;
  }
  const secrets: VaultSecretInput[] = [];
  for (const row of open.rows) {
    // A row added and left blank is not a secret anybody asked for.
    if (row.from === null && row.name.trim().length === 0 && row.value.length === 0) {
      continue;
    }
    const name = sanitizeVaultVariableName(row.name);
    if (name.length === 0) {
      fail('A secret name uses letters, digits and underscores, and does not start with a digit.');
      return;
    }
    if (row.from === null && row.value.length === 0) {
      fail(`${name} needs a value.`);
      return;
    }
    secrets.push({ name, value: row.value, from: row.from });
  }
  const text = sanitizeVaultText(open.text);
  if (text === null) {
    fail('The text holds a control character a dotenv file cannot carry.');
    return;
  }
  const names = secrets.map((secret) => secret.name);
  const conflict = secretConflict({ secrets: names, text });
  if (conflict !== null) {
    fail(`${conflict}.`);
    return;
  }
  if (names.length === 0 && text.trim().length === 0) {
    fail('Add a secret or some text.');
    return;
  }

  const card: VaultFileCard = {
    id: open.card?.id ?? `file-${Math.random().toString(36).slice(2, 10)}`,
    binding,
    createdAt: open.card?.createdAt ?? new Date().toISOString(),
    lifetimeMinutes: open.minutes,
    generatedAt: open.card?.generatedAt ?? null,
    expiresAt: open.card?.expiresAt ?? null,
    secrets: names,
    text,
  };
  open.saving = true;
  open.error = '';
  repaint();
  void actions.onSave(card, secrets).then((result) => {
    // The form was cancelled or replaced while the save was in flight: it is no longer this one's.
    if (draft !== open) {
      return;
    }
    if (result.ok) {
      draft = null;
    } else {
      open.saving = false;
      open.error = result.message;
    }
    repaint();
  });
}

function newRow(name = '', from: string | null = null): SecretRow {
  rowCounter += 1;
  return { key: `row-${String(rowCounter)}`, name, value: '', from };
}

function newDraft(view: VaultPanelState): Draft {
  return {
    card: null,
    projectId: view.targetProjectId ?? view.projects[0]?.id ?? '',
    path: '.env.local',
    minutes: DEFAULT_LIFETIME_MINUTES,
    rows: [newRow()],
    text: '',
    error: '',
    saving: false,
  };
}

function draftFor(card: VaultFileCard): Draft {
  return {
    card,
    projectId: card.binding.projectId,
    path: card.binding.path,
    minutes: card.lifetimeMinutes,
    rows: card.secrets.map((name) => newRow(name, name)),
    text: card.text,
    error: '',
    saving: false,
  };
}

function field(
  label: string,
  value: string,
  limit: number,
  focusKey: string,
  onChange: (next: string) => void,
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'vault__field';
  input.value = value;
  input.maxLength = limit;
  input.placeholder = label;
  input.setAttribute('aria-label', label);
  input.dataset['focusKey'] = focusKey;
  // On `input` and not `change`: the draft is the authority, and Save must see the last character.
  input.addEventListener('input', () => {
    onChange(input.value);
  });
  return input;
}

/* ------------------------------------------------------------------ *
 * Focus across repaints
 * ------------------------------------------------------------------ */

interface FocusMark {
  readonly key: string;
  readonly start: number | null;
  readonly end: number | null;
}

/**
 * The field being typed in, so the repaint that rebuilds it can give the caret back.
 *
 * The panel is rebuilt whole, and it is rebuilt while a form is open: a reveal re-masking on
 * another card, a file expiring, a save elsewhere. Without this the text area loses the caret in
 * the middle of a line.
 */
function captureFocus(host: HTMLElement): FocusMark | null {
  const active = document.activeElement;
  if (
    !(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) ||
    !host.contains(active)
  ) {
    return pendingFocusMark();
  }
  const key = active.dataset['focusKey'];
  return key === undefined
    ? pendingFocusMark()
    : { key, start: active.selectionStart, end: active.selectionEnd };
}

function pendingFocusMark(): FocusMark | null {
  const key = pendingFocus;
  pendingFocus = null;
  return key === null ? null : { key, start: null, end: null };
}

function restoreFocus(host: HTMLElement, mark: FocusMark | null): void {
  if (mark === null) {
    return;
  }
  const target = host.querySelector(`[data-focus-key="${mark.key}"]`);
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    return;
  }
  target.focus();
  if (mark.start !== null && mark.end !== null) {
    target.setSelectionRange(mark.start, mark.end);
  }
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
  const target = host ?? lastHost;
  if (target !== null) {
    renderVaultPanel(target, view, actions);
  }
}

function armHide(): void {
  if (revealTimer !== null) {
    window.clearTimeout(revealTimer);
  }
  revealTimer = window.setTimeout(() => {
    revealed = null;
    revealTimer = null;
    repaint();
  }, REVEAL_MS);
}

/** True while a value is on screen, so the app knows whether a blur has anything to hide. */
export function isRevealing(): boolean {
  return revealed !== null;
}

let lastHost: HTMLElement | null = null;
let lastView: VaultPanelState | null = null;
let lastActions: VaultActions | null = null;

/** Repaints with the latest state the app handed over, never with one a closure kept. */
function repaint(): void {
  if (lastHost !== null && lastView !== null && lastActions !== null) {
    renderVaultPanel(lastHost, lastView, lastActions);
  }
}

/** Hides the current reveal without rebuilding the app-level view and accidentally preserving it. */
export function hideCurrentReveal(): void {
  if (lastView !== null && lastActions !== null) {
    hideReveal(lastView, lastActions, lastHost ?? undefined);
  }
}

/** Remembers where to repaint, so a timer firing later knows which element to redraw. */
export function bindVaultHost(host: HTMLElement): void {
  lastHost = host;
}
