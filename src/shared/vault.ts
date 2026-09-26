/**
 * A place to keep a secret, and a way to use it without handing its value to an agent.
 *
 * ⚠️ **What this protects, and what it does not.** It protects the value **at rest** (encrypted by
 * the OS, keyed to the Windows account), its **lifetime** (a card can die on its own), and the
 * **moment it moves** (nothing leaves without a click). A generated file keeps the value out of the
 * renderer and agent prompt, but it is plaintext to processes in its project. Agent capabilities
 * are the stricter option: they keep the value in main and return only an operation result. Manual
 * Copy, Reveal and Send remain escape hatches and do not protect the value after delivery.
 *
 * The optional agent interface is a loopback operation broker, not a secret-reading API. Project
 * terminals receive an ephemeral token, discover metadata, ask for one constrained HTTP operation
 * and wait for a native approval dialog. No endpoint returns the stored value.
 *
 * This module is the pure half: parsing, validation and the clock. The half that encrypts lives in
 * `main/vault/vault-store.ts` and imports Electron, which is exactly why the two are apart, the
 * same split `secret-store.ts` never got and pays for by having no test at all.
 */

/**
 * One secret, **without its value**.
 *
 * The value is deliberately not a field here. This shape is what crosses to the renderer and what
 * the panel paints, and a type that could carry the secret is a type somebody eventually puts it
 * in. It travels apart, on one channel, in answer to one explicit gesture.
 */
export interface VaultCard {
  readonly id: string;
  /** What the reader called it. Shown everywhere, so it must not be the secret. */
  readonly name: string;
  /** A note about what it opens. Free text, never secret, and optional. */
  readonly hint: string;
  readonly createdAt: string;
  /**
   * When it destroys itself, or `null` for a card that does not.
   *
   * Computed at creation from a duration, and stored as the instant rather than the duration: a
   * duration would have to be added to `createdAt` at every read, and a card edited later would
   * silently restart its own clock.
   */
  readonly expiresAt: string | null;
  /** Optional dotenv file this variable is materialized into for a project. */
  readonly file: VaultFileBinding | null;
  /** A constrained operation an agent may ask the Dashboard to perform with this value. */
  readonly capability: VaultHttpCapability | null;
}

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

export const VAULT_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type VaultHttpMethod = (typeof VAULT_HTTP_METHODS)[number];
export type VaultHttpAuth = 'bearer' | 'header';

/**
 * An HTTP capability, without its credential.
 *
 * The origin, paths, methods and project scope are stored beside the value so the broker can decide
 * locally whether a request is the operation its owner authorised. There is deliberately no generic
 * URL and no shell command: either would let an agent turn a useful credential into an exfiltration
 * primitive.
 */
export interface VaultHttpCapability {
  readonly kind: 'http';
  /** HTTPS origin only, except loopback HTTP for local development services. */
  readonly baseUrl: string;
  readonly auth: VaultHttpAuth;
  /** Used only for `header`; empty for bearer authentication. */
  readonly headerName: string;
  readonly methods: readonly VaultHttpMethod[];
  readonly pathPrefixes: readonly string[];
  /** Exact project ids. A capability with no projects is unusable and therefore invalid. */
  readonly projectIds: readonly string[];
}

export type VaultActivityOutcome = 'denied' | 'succeeded' | 'failed';

/** One non-secret audit record produced by the local operation broker. */
export interface VaultActivity {
  readonly at: string;
  readonly capabilityId: string;
  readonly capabilityName: string;
  readonly projectId: string;
  readonly method: VaultHttpMethod;
  readonly path: string;
  readonly outcome: VaultActivityOutcome;
  readonly status: number | null;
  readonly message: string;
}

/** What the renderer is handed. No values, ever, on this shape. */
export interface VaultState {
  readonly cards: readonly VaultCard[];
  /** Current-process activity only. It is intentionally not persisted with the credentials. */
  readonly activity: readonly VaultActivity[];
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

/** How long a name may be. A label on a card, not a sentence. */
export const NAME_LIMIT = 40;
/** How long a hint may be. One line under the name. */
export const HINT_LIMIT = 80;
export const VAULT_PATH_LIMIT = 120;
export const VAULT_PATH_COUNT_LIMIT = 8;
export const VAULT_PROJECT_COUNT_LIMIT = 32;
export const VAULT_FILE_PATH_LIMIT = 240;

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

/** The durations the form offers, in minutes. `null` is "does not expire". */
export const EXPIRY_CHOICES: readonly (number | null)[] = [null, 5, 15, 30, 60, 240, 1440];

/** What each choice is called on screen. */
export function describeExpiryChoice(minutes: number | null): string {
  if (minutes === null) {
    return 'No expiry';
  }
  if (minutes < 60) {
    return `${String(minutes)} minutes`;
  }
  if (minutes === 1440) {
    return '24 hours';
  }
  return `${String(minutes / 60)} hours`;
}

function clean(value: unknown, limit: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  // Line breaks folded out: both of these are drawn on one line of a card, and a name holding a
  // newline is a card whose height depends on what was pasted into it.
  return value.replace(/\s+/g, ' ').trim().slice(0, limit).trim();
}

export function sanitizeName(value: unknown): string {
  return clean(value, NAME_LIMIT);
}

export function sanitizeHint(value: unknown): string {
  return clean(value, HINT_LIMIT);
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_AUTH_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'transfer-encoding',
]);

function stringList(value: unknown, limit: number): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit) {
    return null;
  }
  const list: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return null;
    }
    const item = entry.trim();
    if (item.length === 0 || list.includes(item)) {
      continue;
    }
    list.push(item);
  }
  return list.length === 0 ? null : list;
}

/**
 * Validates the public half of an agent capability at both persistence and IPC boundaries.
 *
 * `null` means the whole capability is unusable. Callers loading an old file keep the card but drop
 * its agent access; callers handling a save reject it instead. Losing an optional permission is the
 * safe direction to fail, while losing the credential itself would not be.
 */
export function sanitizeHttpCapability(value: unknown): VaultHttpCapability | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (row['kind'] !== 'http') {
    return null;
  }

  let url: URL;
  try {
    url = new URL(typeof row['baseUrl'] === 'string' ? row['baseUrl'].trim() : '');
  } catch {
    return null;
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return null;
  }

  const auth = row['auth'];
  if (auth !== 'bearer' && auth !== 'header') {
    return null;
  }
  const headerName =
    auth === 'header' && typeof row['headerName'] === 'string' ? row['headerName'].trim() : '';
  if (
    auth === 'header' &&
    (!HEADER_NAME.test(headerName) || FORBIDDEN_AUTH_HEADERS.has(headerName.toLowerCase()))
  ) {
    return null;
  }

  if (!Array.isArray(row['methods']) || row['methods'].length === 0) {
    return null;
  }
  const methods: VaultHttpMethod[] = [];
  for (const method of row['methods']) {
    if (!VAULT_HTTP_METHODS.includes(method as VaultHttpMethod)) {
      return null;
    }
    if (!methods.includes(method as VaultHttpMethod)) {
      methods.push(method as VaultHttpMethod);
    }
  }

  const rawPaths = stringList(row['pathPrefixes'], VAULT_PATH_COUNT_LIMIT);
  if (rawPaths === null) {
    return null;
  }
  const pathPrefixes: string[] = [];
  for (const raw of rawPaths) {
    if (
      raw.length > VAULT_PATH_LIMIT ||
      !raw.startsWith('/') ||
      raw.includes('\\') ||
      raw.includes('?') ||
      raw.includes('#') ||
      raw.includes('//')
    ) {
      return null;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (decoded.split('/').some((part) => part === '.' || part === '..')) {
      return null;
    }
    const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
    if (!pathPrefixes.includes(path)) {
      pathPrefixes.push(path);
    }
  }

  const rawProjects = stringList(row['projectIds'], VAULT_PROJECT_COUNT_LIMIT);
  if (rawProjects === null || rawProjects.some((id) => id.length > 100)) {
    return null;
  }

  return {
    kind: 'http',
    baseUrl: url.origin,
    auth,
    headerName,
    methods,
    pathPrefixes,
    projectIds: rawProjects,
  };
}

/**
 * The instant a card created now would expire, or `null`.
 *
 * Takes the creation instant rather than reading the clock, so the caller decides what "now" is and
 * a test does not have to wait.
 */
export function expiryFrom(createdAt: string, minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  const at = new Date(createdAt).getTime();
  if (Number.isNaN(at)) {
    return null;
  }
  return new Date(at + minutes * 60_000).toISOString();
}

/**
 * Whether a card's time is up.
 *
 * An unparseable `expiresAt` reads as **not expired**, which is the direction to be wrong in: the
 * other reading silently deletes a secret because a byte in a file was mangled, and there is no
 * getting it back.
 */
export function isExpired(card: VaultCard, now: Date): boolean {
  if (card.expiresAt === null) {
    return false;
  }
  const at = new Date(card.expiresAt).getTime();
  return Number.isNaN(at) ? false : at <= now.getTime();
}

export interface Sweep {
  readonly kept: readonly VaultCard[];
  /** What just died, so the caller can say it happened rather than let cards vanish silently. */
  readonly dropped: readonly VaultCard[];
}

/**
 * Splits the cards into what survives and what has expired.
 *
 * Both halves are returned because both are used: one is written back to the file, the other is
 * what the panel reports. Returning only the survivors would make a card disappear with nothing
 * saying why, and a secret that vanishes unannounced reads as a bug in the vault.
 */
export function sweepExpired(cards: readonly VaultCard[], now: Date): Sweep {
  const kept: VaultCard[] = [];
  const dropped: VaultCard[] = [];
  for (const card of cards) {
    (isExpired(card, now) ? dropped : kept).push(card);
  }
  return { kept, dropped };
}

/** The line under a card: when it dies, or that it does not. */
export function describeExpiry(card: VaultCard, now: Date): string {
  if (card.expiresAt === null) {
    return 'No expiry';
  }
  const at = new Date(card.expiresAt).getTime();
  if (Number.isNaN(at)) {
    return 'No expiry';
  }
  const minutes = Math.ceil((at - now.getTime()) / 60_000);
  if (minutes <= 0) {
    return 'Expiring now';
  }
  if (minutes < 60) {
    return `Expires in ${String(minutes)} min`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 24
    ? `Expires in ${String(hours)}h`
    : `Expires in ${String(Math.round(hours / 24))}d`;
}

/**
 * One stored entry: a card and the secret it holds.
 *
 * Only ever seen by the main process. It is the shape inside the encrypted blob, and the reason it
 * is declared here rather than beside the encryption is that the parsing is what needs testing and
 * the encryption is what cannot be tested.
 */
export interface VaultEntry {
  readonly card: VaultCard;
  readonly value: string;
}

/**
 * Reads the decrypted blob, dropping what it cannot use.
 *
 * An entry is **dropped, never repaired**, the house rule, and it matters more here than usual: a
 * half-understood entry is a secret whose name or lifetime is a guess, and a card that says "no
 * expiry" because its `expiresAt` was mangled is a secret that outlives what its owner asked for.
 * One bad entry never takes the others with it.
 *
 * An entry with an empty value is dropped too. A card with nothing behind it offers a `Send` that
 * would type nothing into a terminal, which is the button that looks fine and does nothing.
 */
export function parseVault(payload: unknown): VaultEntry[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const entries: VaultEntry[] = [];
  const seen = new Set<string>();
  for (const row of payload) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    const value = typeof record['value'] === 'string' ? record['value'] : '';
    const parsedFile = sanitizeVaultFileBinding(record['file']);
    const variableName = sanitizeVaultVariableName(record['name']);
    const file = parsedFile !== null && variableName.length > 0 ? parsedFile : null;
    const name = file === null ? sanitizeName(record['name']) : variableName;
    // An id that repeats would give two cards one identity, and every gesture here is "do this to
    // the card with this id": the second would shadow the first and its secret would be unreachable.
    if (id.length === 0 || value.length === 0 || name.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const createdAt = typeof record['createdAt'] === 'string' ? record['createdAt'] : '';
    entries.push({
      card: {
        id,
        name,
        hint: sanitizeHint(record['hint']),
        createdAt: Number.isNaN(new Date(createdAt).getTime())
          ? new Date(0).toISOString()
          : createdAt,
        expiresAt: typeof record['expiresAt'] === 'string' ? record['expiresAt'] : null,
        file,
        capability: sanitizeHttpCapability(record['capability']),
      },
      value,
    });
  }
  return entries;
}

/** The cards alone, which is all the renderer is ever given. */
export function cardsOf(entries: readonly VaultEntry[]): readonly VaultCard[] {
  return entries.map((entry) => entry.card);
}
