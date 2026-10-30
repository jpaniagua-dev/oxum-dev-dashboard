/**
 * A place to keep a project file's variables, secrets among them, and to write that file on demand.
 *
 * ⚠️ **What this protects, and what it does not.** It protects the values **at rest** (encrypted by
 * the OS, keyed to the Windows account) and keeps them out of the renderer and of an agent's prompt.
 * The file it generates is plaintext to every process of its project, agents included: what the
 * vault limits is how long that file stays on disk, not who may read it while it is there.
 *
 * This module is the pure half: parsing, validation and the clock. The half that encrypts lives in
 * `main/vault/vault-store.ts` and imports Electron, which is exactly why the two are apart, the
 * same split `secret-store.ts` never got and pays for by having no test at all.
 */

/**
 * One generated file target.
 *
 * The path is always relative to a configured project. The generated file is plaintext and may be
 * read by processes in that project; this binding keeps the value out of the renderer and agent
 * prompt, not out of the project's filesystem.
 */
export interface VaultFileBinding {
  readonly kind: 'dotenv';
  readonly projectId: string;
  readonly path: string;
}

/**
 * One file, **without the values of its secrets**.
 *
 * The values are deliberately not a field here. This shape is what crosses to the renderer and what
 * the panel paints, and a type that could carry a secret is a type somebody eventually puts it in.
 * A value travels apart, on one channel, in answer to one explicit gesture.
 */
export interface VaultFileCard {
  readonly id: string;
  readonly binding: VaultFileBinding;
  readonly createdAt: string;
  /** How long a generated file stays on disk, in minutes; `null` keeps it until it is removed. */
  readonly lifetimeMinutes: number | null;
  /** When the file was last generated, or `null` while none is on disk. */
  readonly generatedAt: string | null;
  /**
   * When the generated file is removed, or `null`.
   *
   * Stored as the instant rather than recomputed from the lifetime, so the sweep that runs at
   * start-up honours a file whose time ran out while the app was closed.
   */
  readonly expiresAt: string | null;
  /** The secrets' names, in the order they are written to the file. */
  readonly secrets: readonly string[];
  /** Written into the file as it is. Not secret: it is shown in clear, in the panel and the file. */
  readonly text: string;
}

/** One secret as the form sends it: `from` is its stored name, `null` for a new one. */
export interface VaultSecretInput {
  readonly name: string;
  /** Empty on an existing secret means "keep the stored value": the form is never told it. */
  readonly value: string;
  readonly from: string | null;
}

/** What the renderer is handed. No values, ever, on this shape. */
export interface VaultState {
  readonly cards: readonly VaultFileCard[];
  /**
   * Whether the OS can encrypt at all.
   *
   * False means the panel refuses to save and says why. The rule `SecretStore` already sets:
   * writing a secret in the clear because the safe was locked is the silent downgrade nobody
   * notices.
   */
  readonly available: boolean;
  /**
   * The file exists and could not be decrypted.
   *
   * Distinct from an empty vault, and the distinction is what stops the app destroying something
   * recoverable: a blob encrypted under another Windows account reads as unreadable, and the right
   * response is to say so and touch nothing, not to start a fresh vault over the top of it.
   */
  readonly unreadable: boolean;
}

/** How long a variable name may be. */
export const NAME_LIMIT = 40;
export const VAULT_FILE_PATH_LIMIT = 240;
/** Enough for a hand-written dotenv file, small enough that the panel never holds a dump. */
export const VAULT_TEXT_LIMIT = 16 * 1024;
export const DEFAULT_LIFETIME_MINUTES = 30;

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A name that can be used on the left side of a dotenv assignment. */
export function sanitizeVaultVariableName(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const name = value.trim().slice(0, NAME_LIMIT);
  return VARIABLE_NAME.test(name) ? name : '';
}

/**
 * Validates the public, non-secret description of a generated dotenv file.
 *
 * Backslashes and absolute/traversing paths are rejected rather than normalized: the exact same
 * relative path must mean the same target in the renderer, the main process and Git.
 */
export function sanitizeVaultFileBinding(value: unknown): VaultFileBinding | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const projectId = typeof row['projectId'] === 'string' ? row['projectId'].trim() : '';
  const path = typeof row['path'] === 'string' ? row['path'].trim() : '';
  if (
    row['kind'] !== 'dotenv' ||
    projectId.length === 0 ||
    projectId.length > 100 ||
    path.length === 0 ||
    path.length > VAULT_FILE_PATH_LIMIT ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes(':') ||
    /[<>"|?*]/.test(path) ||
    /[\u0000-\u001f]/.test(path)
  ) {
    return null;
  }
  const parts = path.split('/');
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === '.' ||
        part === '..' ||
        part.endsWith('.') ||
        part.endsWith(' ') ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
    ) ||
    parts[0]?.toLowerCase() === '.git'
  ) {
    return null;
  }
  return { kind: 'dotenv', projectId, path };
}

export function sameVaultFile(
  left: VaultFileBinding | null,
  right: VaultFileBinding | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.projectId === right.projectId &&
    left.path.toLowerCase() === right.path.toLowerCase()
  );
}

/**
 * The free text, line endings normalised, or `null` when it cannot be written as it is.
 *
 * Refused rather than cleaned: the text is written into the file verbatim, and a control character
 * dropped on the way would be a file that differs from what was typed with nothing saying so.
 */
export function sanitizeVaultText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.replace(/\r\n?/g, '\n');
  if (text.length > VAULT_TEXT_LIMIT || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
    return null;
  }
  return text;
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** The names the free text assigns, comments aside. */
export function assignedNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const name = ASSIGNMENT.exec(line)?.[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Why this card cannot be written as one file, or `null`.
 *
 * A name given twice, or given to a secret AND assigned in the text, would put two values for one
 * variable in the file, and which one wins depends on the loader that reads it. Case is ignored:
 * Windows environment names are case-insensitive.
 */
export function secretConflict(card: Pick<VaultFileCard, 'secrets' | 'text'>): string | null {
  const seen = new Set<string>();
  for (const name of card.secrets) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return `${name} appears twice`;
    }
    seen.add(key);
  }
  const inText = assignedNames(card.text).find((name) => seen.has(name.toLowerCase()));
  return inText === undefined ? null : `${inText} is a secret and is also set in the text`;
}

/** The lifetimes the form offers, in minutes. `null` keeps the file until it is removed. */
export const EXPIRY_CHOICES: readonly (number | null)[] = [5, 15, 30, 60, 240, 1440, null];

/** What each choice is called on screen. */
export function describeExpiryChoice(minutes: number | null): string {
  if (minutes === null) {
    return 'Never';
  }
  if (minutes < 60) {
    return `${String(minutes)} minutes`;
  }
  if (minutes === 1440) {
    return '24 hours';
  }
  return `${String(minutes / 60)} hours`;
}

/** A lifetime the form offers, or `undefined` for anything else. */
export function sanitizeLifetime(value: unknown): number | null | undefined {
  return EXPIRY_CHOICES.find((choice) => choice === value);
}

/**
 * The instant `minutes` after `from`, or `null`.
 *
 * Takes the starting instant rather than reading the clock, so the caller decides what "now" is and
 * a test does not have to wait.
 */
export function expiryFrom(from: string, minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  const at = new Date(from).getTime();
  if (Number.isNaN(at)) {
    return null;
  }
  return new Date(at + minutes * 60_000).toISOString();
}

/**
 * Whether a card's generated file has outlived its lifetime.
 *
 * An unparseable `expiresAt` reads as **not expired**: the file then stays until it is removed by
 * hand, where the other reading would delete a file because a byte in the vault was mangled.
 */
export function fileExpired(card: VaultFileCard, now: Date): boolean {
  if (card.generatedAt === null || card.expiresAt === null) {
    return false;
  }
  const at = new Date(card.expiresAt).getTime();
  return Number.isNaN(at) ? false : at <= now.getTime();
}

export function expiredFiles(cards: readonly VaultFileCard[], now: Date): VaultFileCard[] {
  return cards.filter((card) => fileExpired(card, now));
}

/** The line under a card's path: whether its file is on disk, and for how long. */
export function describeFileState(card: VaultFileCard, now: Date): string {
  if (card.generatedAt === null) {
    return 'Not generated';
  }
  const at = card.expiresAt === null ? Number.NaN : new Date(card.expiresAt).getTime();
  if (Number.isNaN(at)) {
    return 'Generated, kept until removed';
  }
  const minutes = Math.ceil((at - now.getTime()) / 60_000);
  if (minutes <= 0) {
    return 'Generated, removing now';
  }
  if (minutes < 60) {
    return `Generated, removed in ${String(minutes)} min`;
  }
  const hours = Math.round(minutes / 60);
  return `Generated, removed in ${String(hours)}h`;
}

/**
 * One stored file: its card and the values of its secrets.
 *
 * Only ever seen by the main process. It is the shape inside the encrypted blob, and the reason it
 * is declared here rather than beside the encryption is that the parsing is what needs testing and
 * the encryption is what cannot be tested.
 */
export interface VaultEntry {
  readonly card: VaultFileCard;
  readonly values: Readonly<Record<string, string>>;
}

export interface ParsedVault {
  readonly entries: VaultEntry[];
  /** The blob was in the format of one card per variable, and should be written back as files. */
  readonly migrated: boolean;
}

/**
 * Reads the decrypted blob, dropping what it cannot use.
 *
 * An entry is **dropped, never repaired**, and one bad entry never takes the others with it. Two
 * exceptions, both in the direction of keeping secrets: a mangled lifetime falls back to the
 * default rather than losing the file's values, and a mangled text is emptied rather than dropping
 * the secrets beside it.
 */
export function parseVault(payload: unknown, now: Date): ParsedVault {
  if (Array.isArray(payload)) {
    return { entries: migrateVariables(payload, now), migrated: true };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { entries: [], migrated: false };
  }
  const record = payload as Record<string, unknown>;
  const files = record['version'] === 2 && Array.isArray(record['files']) ? record['files'] : [];
  const entries: VaultEntry[] = [];
  for (const row of files) {
    const entry = parseFileEntry(row);
    // An id or a file that repeats would give two cards one identity, and every gesture here is
    // "do this to the card with this id": the second would shadow the first.
    if (
      entry !== null &&
      !entries.some(
        (kept) =>
          kept.card.id === entry.card.id || sameVaultFile(kept.card.binding, entry.card.binding),
      )
    ) {
      entries.push(entry);
    }
  }
  return { entries, migrated: false };
}

function parseFileEntry(row: unknown): VaultEntry | null {
  if (typeof row !== 'object' || row === null) {
    return null;
  }
  const record = row as Record<string, unknown>;
  const id = typeof record['id'] === 'string' ? record['id'] : '';
  const binding = sanitizeVaultFileBinding(record['binding']);
  if (id.length === 0 || binding === null) {
    return null;
  }
  const rawValues = record['values'];
  const stored =
    typeof rawValues === 'object' && rawValues !== null
      ? (rawValues as Record<string, unknown>)
      : {};
  const secrets: string[] = [];
  const values: Record<string, string> = {};
  for (const raw of Array.isArray(record['secrets']) ? record['secrets'] : []) {
    const name = sanitizeVaultVariableName(raw);
    const value = stored[name];
    if (
      name.length === 0 ||
      typeof value !== 'string' ||
      value.length === 0 ||
      secrets.some((kept) => kept.toLowerCase() === name.toLowerCase())
    ) {
      continue;
    }
    secrets.push(name);
    values[name] = value;
  }
  const lifetime = sanitizeLifetime(record['lifetimeMinutes']);
  const generatedAt = validInstant(record['generatedAt']);
  return {
    card: {
      id,
      binding,
      createdAt: validInstant(record['createdAt']) ?? new Date(0).toISOString(),
      lifetimeMinutes: lifetime === undefined ? DEFAULT_LIFETIME_MINUTES : lifetime,
      generatedAt,
      expiresAt:
        generatedAt !== null && typeof record['expiresAt'] === 'string'
          ? record['expiresAt']
          : null,
      secrets,
      text: sanitizeVaultText(record['text']) ?? '',
    },
    values,
  };
}

/**
 * Turns the earlier format, one entry per variable, into one card per file.
 *
 * What does not survive, and why: a variable bound to no file (the cards are files now, and its
 * owner chose to let those go), and one whose own expiry has passed (the sweep would have destroyed
 * it). A note becomes a `# NAME: note` comment in the text, which is where the generated file
 * already printed it. Every migrated file counts as generated now, so a file the earlier version
 * left on disk is removed after the default lifetime rather than staying forever.
 */
function migrateVariables(rows: readonly unknown[], now: Date): VaultEntry[] {
  const groups: { card: VaultFileCard; values: Record<string, string>; notes: string[] }[] = [];
  const generatedAt = now.toISOString();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    const value = typeof record['value'] === 'string' ? record['value'] : '';
    const name = sanitizeVaultVariableName(record['name']);
    const binding = sanitizeVaultFileBinding(record['file']);
    const expiresAt = validInstant(record['expiresAt']);
    if (
      id.length === 0 ||
      value.length === 0 ||
      name.length === 0 ||
      binding === null ||
      (expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime())
    ) {
      continue;
    }
    let group = groups.find((entry) => sameVaultFile(entry.card.binding, binding));
    if (group === undefined) {
      group = {
        card: {
          id,
          binding,
          createdAt: validInstant(record['createdAt']) ?? generatedAt,
          lifetimeMinutes: DEFAULT_LIFETIME_MINUTES,
          generatedAt,
          expiresAt: expiryFrom(generatedAt, DEFAULT_LIFETIME_MINUTES),
          secrets: [],
          text: '',
        },
        values: {},
        notes: [],
      };
      groups.push(group);
    }
    if (group.card.secrets.some((kept) => kept.toLowerCase() === name.toLowerCase())) {
      continue;
    }
    group.card = { ...group.card, secrets: [...group.card.secrets, name] };
    group.values[name] = value;
    const note =
      typeof record['hint'] === 'string' ? record['hint'].replace(/\s+/g, ' ').trim() : '';
    if (note.length > 0) {
      group.notes.push(`# ${name}: ${note}`);
    }
  }
  return groups.map((group) => ({
    card: { ...group.card, text: group.notes.join('\n') },
    values: group.values,
  }));
}

function validInstant(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime()) ? value : null;
}

/** The cards alone, which is all the renderer is ever given. */
export function cardsOf(entries: readonly VaultEntry[]): readonly VaultFileCard[] {
  return entries.map((entry) => entry.card);
}
