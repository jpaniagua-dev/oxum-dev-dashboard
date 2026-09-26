import type { VaultCard, VaultFileBinding, VaultState } from '@shared/vault.js';
import {
  EXPIRY_CHOICES,
  HINT_LIMIT,
  NAME_LIMIT,
  VAULT_HTTP_METHODS,
  describeExpiry,
  describeExpiryChoice,
  expiryFrom,
  sameVaultFile,
  sanitizeHttpCapability,
  sanitizeVaultFileBinding,
  sanitizeVaultVariableName,
  type VaultHttpAuth,
  type VaultHttpMethod,
} from '@shared/vault.js';
import { clearChildren, createElement, createIconButton } from './dom.js';

/**
 * The vault: encrypted variables materialized into project files without returning their values to
 * the renderer after entry.
 *
 * A generated file keeps a value out of the agent prompt, not away from processes in that project;
 * that boundary is explained on demand by the compact `How it works` disclosure.
 *
 * Copy and the short-lived eye reveal remain manual escape hatches. The stricter HTTP broker is
 * tucked under an advanced disclosure because it is useful, but not the everyday `.env` workflow
 * this panel leads.
 */

export interface VaultActions {
  readonly onSave: (card: VaultCard, value: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onReveal: (id: string) => Promise<string>;
  readonly onCopy: (id: string) => void;
  readonly onGenerateFile: (binding: VaultFileBinding) => void;
  readonly onRemoveFile: (binding: VaultFileBinding) => void;
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

/** A fresh card, unnamed and with no expiry, so nothing is chosen on the reader's behalf. */
export function blankCard(now: Date): VaultCard {
  return {
    id: `card-${Math.random().toString(36).slice(2, 10)}`,
    name: '',
    hint: '',
    createdAt: now.toISOString(),
    expiresAt: null,
    file: null,
    capability: null,
  };
}

interface Draft {
  card: VaultCard | null;
  /** The file box that owns this editor, even while its target fields are being changed. */
  anchorFile: VaultFileBinding | null;
  /** A global add starts in its own prospective file box. */
  standalone: boolean;
  name: string;
  hint: string;
  value: string;
  minutes: number | null;
  agentAccess: boolean;
  baseUrl: string;
  auth: VaultHttpAuth;
  headerName: string;
  methods: VaultHttpMethod[];
  paths: string;
  agentProjectId: string;
  fileProjectId: string;
  filePath: string;
  error: string;
}

let draft: Draft | null = null;
let helpOpen = false;
/** The card whose value is on screen, and the timer that takes it off again. */
let revealed: { id: string; value: string } | null = null;
let revealTimer: number | null = null;

export function renderVaultPanel(
  host: HTMLElement,
  view: VaultPanelState,
  actions: VaultActions,
): void {
  lastHost = host;
  lastView = view;
  lastActions = actions;
  clearChildren(host);
  host.append(buildVaultHelp(view, actions));
  const state = view.state;
  if (state === null) {
    host.append(createElement('p', { className: 'vault__empty', text: 'Opening the vault...' }));
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
        text: 'No variable yet. Create one to generate an ignored dotenv file for your project.',
      }),
    );
    if (state.activity.length > 0) {
      host.append(buildActivity(state.activity, view));
    }
    return;
  }

  const now = new Date();
  host.append(buildFiles(state.cards, view, actions, now, host));

  if (state.activity.length > 0) {
    host.append(buildActivity(state.activity, view));
  }
}

function buildVaultHelp(view: VaultPanelState, actions: VaultActions): HTMLElement {
  const wrap = createElement('div', { className: 'vault__intro' });
  const toolbar = createElement('div', { className: 'vault__toolbar' });
  const help = createElement('div', { className: 'vault__help' });
  help.id = 'vault-how-it-works';
  help.hidden = !helpOpen;
  help.append(createElement('p', { className: 'vault__help-title', text: 'How it works' }));
  const steps = document.createElement('ol');
  steps.className = 'vault__help-steps';
  for (const text of [
    'Save a Name and Secret, then choose a project and an ignored dotenv file.',
    'Generate file writes the variable for project tools without pasting its value into the conversation.',
    'The generated file is plaintext and project processes can read it, so keep it ignored by Git.',
    'Advanced HTTP operations can use a stored secret after approval without returning its value to the agent.',
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
    className: 'button button--primary vault__new-variable',
    text: 'New variable',
  });
  add.type = 'button';
  add.disabled =
    draft !== null || view.state === null || !view.state.available || view.state.unreadable;
  add.addEventListener('click', () => {
    draft = newDraft(view, undefined, true);
    repaint(view, actions);
  });
  toolbar.append(add, info);
  wrap.append(toolbar, help);

  return wrap;
}

function buildFiles(
  cards: readonly VaultCard[],
  view: VaultPanelState,
  actions: VaultActions,
  now: Date,
  host: HTMLElement,
): HTMLElement {
  const files = createElement('div', { className: 'vault__files' });
  const groups: { binding: VaultFileBinding; cards: VaultCard[] }[] = [];
  const loose: VaultCard[] = [];
  for (const card of cards) {
    if (card.file === null) {
      loose.push(card);
      continue;
    }
    const existing = groups.find((group) => sameVaultFile(group.binding, card.file));
    if (existing === undefined) {
      groups.push({ binding: card.file, cards: [card] });
    } else {
      existing.cards.push(card);
    }
  }

  if (draft?.standalone === true) {
    const section = createElement('section', {
      className: 'vault__file vault__file--editing',
    });
    const header = createElement('div', { className: 'vault__file-head' });
    const identity = createElement('div', { className: 'vault__file-identity' });
    identity.append(
      createElement('span', { className: 'vault__file-project', text: 'New dotenv file' }),
      createElement('span', {
        className: 'vault__file-path',
        text: 'Choose its project and path below',
      }),
    );
    header.append(identity);
    section.append(header, buildEditor(draft, view, actions, true, host));
    files.append(section);
  }

  for (const group of groups) {
    const section = createElement('section', { className: 'vault__file' });
    const header = createElement('div', { className: 'vault__file-head' });
    const identity = createElement('div', { className: 'vault__file-identity' });
    const project = view.projects.find((entry) => entry.id === group.binding.projectId);
    identity.append(
      createElement('span', {
        className: 'vault__file-project',
        text: project?.label ?? 'Unknown project',
      }),
      createElement('code', { className: 'vault__file-path', text: group.binding.path }),
    );
    header.append(identity);
    section.append(header);
    const variables = createElement('div', { className: 'vault__variables' });
    for (const card of group.cards) {
      variables.append(buildCard(card, view, actions, now, host));
    }
    if (
      draft !== null &&
      draft.card === null &&
      !draft.standalone &&
      draft.anchorFile !== null &&
      sameVaultFile(draft.anchorFile, group.binding)
    ) {
      variables.append(buildEditor(draft, view, actions, false, host));
    }
    section.append(variables);
    section.append(buildFileFooter(group.binding, group.cards.length, view, actions, host));
    files.append(section);
  }

  if (loose.length > 0) {
    const section = createElement('section', { className: 'vault__file' });
    const header = createElement('div', { className: 'vault__file-head' });
    header.append(
      createElement('span', {
        className: 'vault__file-project',
        text: 'Secrets not assigned to a file',
      }),
    );
    section.append(header);
    const variables = createElement('div', { className: 'vault__variables' });
    for (const card of loose) {
      variables.append(buildCard(card, view, actions, now, host));
    }
    section.append(variables);
    files.append(section);
  }
  return files;
}

function buildFileFooter(
  binding: VaultFileBinding,
  count: number,
  view: VaultPanelState,
  actions: VaultActions,
  host: HTMLElement,
): HTMLElement {
  const footer = createElement('footer', { className: 'vault__file-footer' });
  footer.append(
    createElement('span', {
      className: 'vault__file-count',
      text: `${String(count)} ${count === 1 ? 'variable' : 'variables'}`,
    }),
  );
  const actionsRow = createElement('div', { className: 'vault__file-actions' });
  const add = createElement('button', {
    className: 'button button--quiet vault__file-add',
    text: '+ Variable',
  });
  add.type = 'button';
  add.disabled = draft !== null;
  add.addEventListener('click', () => {
    draft = newDraft(view, binding);
    repaint(view, actions, host);
  });
  const generate = createElement('button', {
    className: 'button button--primary vault__generate',
    text: 'Generate file',
  });
  generate.type = 'button';
  generate.addEventListener('click', () => actions.onGenerateFile(binding));
  const remove = createElement('button', {
    className: 'button button--quiet vault__remove-file',
    text: 'Remove file',
  });
  remove.type = 'button';
  remove.addEventListener('click', () => actions.onRemoveFile(binding));
  actionsRow.append(add, generate, remove);
  footer.append(actionsRow);
  return footer;
}

/* ------------------------------------------------------------------ *
 * Inline editor
 * ------------------------------------------------------------------ */

function buildEditor(
  open: Draft,
  view: VaultPanelState,
  actions: VaultActions,
  showFileTarget: boolean,
  host: HTMLElement,
): HTMLElement {
  const box = createElement('div', { className: 'vault__editor' });
  box.append(
    createElement('span', {
      className: 'vault__editor-title',
      text: open.card === null ? 'New variable' : `Edit ${open.card.name}`,
    }),
  );
  const row = createElement('div', { className: 'vault__form-row' });

  const name = field('Name', open.name, NAME_LIMIT, (value) => {
    open.name = value;
  });
  row.append(name);

  const hint = field('Notes', open.hint, HINT_LIMIT, (value) => {
    open.hint = value;
  });
  row.append(hint);
  box.append(row);
  if (showFileTarget) {
    box.append(buildFileTarget(open, view));
  }

  if (open.card === null) {
    const secretControl = createElement('div', { className: 'vault__secret-control' });
    const secret = document.createElement('input');
    secret.type = 'password';
    secret.className = 'vault__value';
    secret.autocomplete = 'off';
    secret.placeholder = 'Secret';
    secret.setAttribute('aria-label', 'Secret');
    // Repaints can happen while the form is open (for example when another card expires). The draft
    // is the authority, so the replacement input must show the same masked value rather than looking
    // empty while Save still holds the previous secret.
    secret.value = open.value;
    secret.addEventListener('input', () => {
      open.value = secret.value;
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
    secretControl.append(secret, reveal);
    box.append(secretControl);

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
    bottom.append(
      createElement('span', {
        className: 'vault__hint',
        text: 'Chosen once: a card keeps its value and its expiry. Rotating a key is delete and add.',
      }),
    );
    box.append(bottom);
  } else {
    box.append(buildSecretControl(open.card, view, actions, host));
    box.append(
      createElement('span', {
        className: 'vault__hint',
        text: 'The stored value and its expiry stay unchanged. Delete and add the variable to rotate it.',
      }),
    );
  }

  const advanced = document.createElement('details');
  advanced.className = 'vault__advanced';
  advanced.open = open.agentAccess;
  advanced.append(
    createElement('summary', { text: 'Protected HTTP operation (advanced)' }),
    buildAgentAccess(open, view, actions),
  );
  box.append(advanced);

  if (open.error.length > 0) {
    box.append(createElement('p', { className: 'vault__form-error', text: open.error }));
  }

  const buttons = createElement('div', { className: 'vault__editor-actions' });
  const save = createElement('button', { className: 'button button--primary', text: 'Save' });
  save.type = 'button';
  save.addEventListener('click', () => {
    const now = new Date();
    const card = open.card ?? blankCard(now);
    const file = sanitizeVaultFileBinding({
      kind: 'dotenv',
      projectId: open.fileProjectId,
      path: open.filePath,
    });
    const variableName = sanitizeVaultVariableName(open.name);
    if (file === null || variableName.length === 0) {
      open.error =
        'Choose a project, a relative output file, and a variable name using letters, numbers or underscores.';
      repaint(view, actions, host);
      return;
    }
    const capability = open.agentAccess
      ? sanitizeHttpCapability({
          kind: 'http',
          baseUrl: open.baseUrl,
          auth: open.auth,
          headerName: open.headerName,
          methods: open.methods,
          pathPrefixes: open.paths.split(',').map((path) => path.trim()),
          projectIds: [open.agentProjectId],
        })
      : null;
    if (open.agentAccess && capability === null) {
      open.error =
        'Give agents one HTTPS origin, at least one method, comma-separated paths beginning with /, and a project.';
      repaint(view, actions, host);
      return;
    }
    actions.onSave(
      {
        ...card,
        name: variableName,
        hint: open.hint,
        expiresAt: open.card === null ? expiryFrom(card.createdAt, open.minutes) : card.expiresAt,
        file,
        capability,
      },
      open.card === null ? open.value : '',
    );
    draft = null;
  });
  buttons.append(save);

  const cancel = createElement('button', { className: 'button button--quiet', text: 'Cancel' });
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    draft = null;
    repaint(view, actions, host);
  });
  buttons.append(cancel);
  box.append(buttons);
  return box;
}

function newDraft(view: VaultPanelState, binding?: VaultFileBinding, standalone = false): Draft {
  const projectId = binding?.projectId ?? view.targetProjectId ?? view.projects[0]?.id ?? '';
  return {
    card: null,
    anchorFile: binding ?? null,
    standalone,
    name: '',
    hint: '',
    value: '',
    minutes: null,
    agentAccess: false,
    baseUrl: '',
    auth: 'bearer',
    headerName: 'X-API-Key',
    methods: ['GET'],
    paths: '/',
    agentProjectId: projectId,
    fileProjectId: projectId,
    filePath: binding?.path ?? '.env.local',
    error: '',
  };
}

function buildFileTarget(open: Draft, view: VaultPanelState): HTMLElement {
  const section = createElement('div', { className: 'vault__file-target' });
  const project = document.createElement('select');
  project.className = 'vault__select';
  project.setAttribute('aria-label', 'Project that receives the generated file');
  for (const entry of view.projects) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    option.selected = entry.id === open.fileProjectId;
    project.append(option);
  }
  project.addEventListener('change', () => {
    open.fileProjectId = project.value;
    open.error = '';
  });

  const path = field('Output file (for example .env.local)', open.filePath, 240, (value) => {
    open.filePath = value;
    open.error = '';
  });
  path.classList.add('vault__field--mono');
  section.append(project, path);
  return section;
}

function buildAgentAccess(open: Draft, view: VaultPanelState, actions: VaultActions): HTMLElement {
  const section = createElement('div', { className: 'vault__capability-form' });
  const toggleLabel = createElement('label', { className: 'vault__capability-toggle' });
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = open.agentAccess;
  toggle.addEventListener('change', () => {
    open.agentAccess = toggle.checked;
    open.error = '';
    repaint(view, actions);
  });
  toggleLabel.append(
    toggle,
    createElement('span', {
      text: 'Let project agents use this secret for approved HTTP operations',
    }),
  );
  section.append(toggleLabel);

  if (!open.agentAccess) {
    return section;
  }

  section.append(
    createElement('p', {
      className: 'vault__capability-copy',
      text: 'The Dashboard adds the credential after approval. The agent receives only the response.',
    }),
  );

  const origin = field('API origin (https://api.example.com)', open.baseUrl, 200, (value) => {
    open.baseUrl = value;
    open.error = '';
  });
  origin.classList.add('vault__field--wide', 'vault__field--mono');
  section.append(origin);

  const row = createElement('div', { className: 'vault__form-row' });
  const project = document.createElement('select');
  project.className = 'vault__select';
  project.setAttribute('aria-label', 'Project allowed to use this secret');
  for (const entry of view.projects) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.label;
    option.selected = entry.id === open.agentProjectId;
    project.append(option);
  }
  project.addEventListener('change', () => {
    open.agentProjectId = project.value;
    open.error = '';
  });
  row.append(project);

  const auth = document.createElement('select');
  auth.className = 'vault__select';
  auth.setAttribute('aria-label', 'How the credential is added');
  for (const choice of [
    { value: 'bearer', label: 'Bearer token' },
    { value: 'header', label: 'API key header' },
  ] as const) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    option.selected = choice.value === open.auth;
    auth.append(option);
  }
  auth.addEventListener('change', () => {
    open.auth = auth.value === 'header' ? 'header' : 'bearer';
    open.error = '';
    repaint(view, actions);
  });
  row.append(auth);

  if (open.auth === 'header') {
    const header = field('Header name', open.headerName, 80, (value) => {
      open.headerName = value;
      open.error = '';
    });
    header.classList.add('vault__field--mono');
    row.append(header);
  }
  section.append(row);

  const methods = createElement('div', { className: 'vault__methods' });
  for (const method of VAULT_HTTP_METHODS) {
    const label = createElement('label', { className: 'vault__method' });
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = open.methods.includes(method);
    input.addEventListener('change', () => {
      open.methods = input.checked
        ? [...open.methods, method]
        : open.methods.filter((entry) => entry !== method);
      open.error = '';
    });
    label.append(input, document.createTextNode(method));
    methods.append(label);
  }
  section.append(methods);

  const paths = field('Allowed paths, comma-separated', open.paths, 500, (value) => {
    open.paths = value;
    open.error = '';
  });
  paths.classList.add('vault__field--wide', 'vault__field--mono');
  section.append(paths);
  return section;
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
  if (draft?.card?.id === card.id) {
    return buildEditor(draft, view, actions, card.file === null, host);
  }

  const box = createElement('div', { className: 'vault__card' });
  const head = createElement('div', { className: 'vault__card-head' });
  const identity = createElement('div', { className: 'vault__card-identity' });
  identity.append(
    createElement('span', { className: 'vault__card-name', text: card.name }),
    createElement('span', { className: 'vault__card-expiry', text: describeExpiry(card, now) }),
  );
  head.append(identity);
  const cardActions = createElement('div', { className: 'vault__card-actions' });
  const configure = createIconButton('M2 4h5m2 0h5M7 2v4M2 10h2m2 0h8M4 8v4', {
    label: `Edit ${card.name}`,
    title: 'Edit the variable in this file without changing its stored value or expiry.',
    className: 'icon-button--row',
  });
  configure.addEventListener('click', () => {
    const capability = card.capability;
    draft = {
      card,
      anchorFile: card.file,
      standalone: false,
      name: card.name,
      hint: card.hint,
      value: '',
      minutes: null,
      agentAccess: capability !== null,
      baseUrl: capability?.baseUrl ?? '',
      auth: capability?.auth ?? 'bearer',
      headerName: capability?.headerName || 'X-API-Key',
      methods: capability === null ? ['GET'] : [...capability.methods],
      paths: capability?.pathPrefixes.join(', ') ?? '/',
      agentProjectId:
        capability?.projectIds[0] ?? view.targetProjectId ?? view.projects[0]?.id ?? '',
      fileProjectId: card.file?.projectId ?? view.targetProjectId ?? view.projects[0]?.id ?? '',
      filePath: card.file?.path ?? '.env.local',
      error: '',
    };
    repaint(view, actions, host);
  });
  cardActions.append(configure);
  const remove = createIconButton('M4 4l8 8M12 4l-8 8', {
    label: `Delete ${card.name}`,
    title: 'Delete this secret. It cannot be brought back.',
    className: 'icon-button--row',
  });
  remove.addEventListener('click', () => {
    actions.onDelete(card.id);
  });
  cardActions.append(remove);
  head.append(cardActions);
  box.append(head);

  if (card.hint.length > 0) {
    box.append(createElement('span', { className: 'vault__hint', text: card.hint }));
  }

  if (card.capability !== null) {
    const project = view.projects.find((entry) => card.capability?.projectIds.includes(entry.id));
    box.append(
      createElement('div', {
        className: 'vault__capability',
        text: `Agent operation · ${card.capability.methods.join(', ')} ${card.capability.baseUrl}${card.capability.pathPrefixes.join(', ')} · ${project?.label ?? 'Unknown project'} · asks every time`,
      }),
    );
  }

  box.append(buildSecretControl(card, view, actions, host));
  return box;
}

function buildSecretControl(
  card: VaultCard,
  view: VaultPanelState,
  actions: VaultActions,
  host: HTMLElement,
): HTMLElement {
  const shown = revealed?.id === card.id;
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
    label: `Copy ${card.name}`,
    title: 'Copy secret. Windows may keep a clipboard history.',
    className: 'vault__secret-action',
  });
  copy.addEventListener('click', () => actions.onCopy(card.id));
  control.append(copy);

  const reveal = createIconButton(EYE_ICON, {
    label: shown ? `Hide ${card.name}` : `Reveal ${card.name}`,
    title: shown
      ? 'Hide secret'
      : `Reveal for ${String(REVEAL_MS / 1000)} seconds. It may appear in screenshots or screen sharing.`,
    className: 'vault__secret-action',
  });
  reveal.setAttribute('aria-pressed', String(shown));
  reveal.addEventListener('click', () => {
    if (shown) {
      hideReveal(view, actions, host);
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
  control.append(reveal);
  return control;
}

function buildActivity(activity: VaultState['activity'], view: VaultPanelState): HTMLElement {
  const section = createElement('section', { className: 'vault__activity' });
  section.append(createElement('h3', { className: 'vault__activity-title', text: 'Recent use' }));
  const list = createElement('div', { className: 'vault__activity-list' });
  for (const entry of activity) {
    const project = view.projects.find((candidate) => candidate.id === entry.projectId);
    const row = createElement('div', {
      className: `vault__activity-row vault__activity-row--${entry.outcome}`,
    });
    row.append(
      createElement('span', {
        className: 'vault__activity-operation',
        text: `${entry.method} ${entry.path}`,
      }),
      createElement('span', {
        className: 'vault__activity-meta',
        text: `${entry.capabilityName} · ${project?.label ?? entry.projectId} · ${entry.message}`,
      }),
    );
    list.append(row);
  }
  section.append(list);
  return section;
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
let lastView: VaultPanelState | null = null;
let lastActions: VaultActions | null = null;

function repaint(view: VaultPanelState, actions: VaultActions, host?: HTMLElement): void {
  const target = host ?? lastHost;
  if (target !== null) {
    lastHost = target;
    renderVaultPanel(target, view, actions);
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
