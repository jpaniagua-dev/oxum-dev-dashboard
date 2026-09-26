/**
 * A place to keep a secret, and a way to hand it to an agent on a gesture.
 *
 * ⚠️ **What this protects, and what it does not.** It protects the value **at rest** (encrypted by
 * the OS, keyed to the Windows account), its **lifetime** (a card can die on its own), and the
 * **moment it moves** (nothing leaves without a click). It does NOT protect the value once
 * delivered: an agent that receives it holds it in its context, which is written to that agent's
 * own transcript in clear text and sent to its model provider. Nothing in this app can undo that,
 * and the panel says so on screen rather than only here.
 *
 * That limit is why the delivery is a gesture and not an API. There is no local server, no CLI and
 * no file an agent can read by itself, which were the three designs considered: two were closed by
 * facts (the app holds a single-instance lock, and `safeStorage` is an Electron API no standalone
 * script can call) and the third was refused, because a plaintext file with a timer is still a
 * plaintext file.
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
}

/** What the renderer is handed. No values, ever, on this shape. */
export interface VaultState {
  readonly cards: readonly VaultCard[];
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
  return hours < 24 ? `Expires in ${String(hours)}h` : `Expires in ${String(Math.round(hours / 24))}d`;
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
    const name = sanitizeName(record['name']);
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
        createdAt: Number.isNaN(new Date(createdAt).getTime()) ? new Date(0).toISOString() : createdAt,
        expiresAt: typeof record['expiresAt'] === 'string' ? record['expiresAt'] : null,
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
