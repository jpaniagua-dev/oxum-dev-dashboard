import { readFile } from 'node:fs/promises';
import { safeStorage } from 'electron';
import type { VaultCard, VaultEntry, VaultState } from '@shared/vault.js';
import { cardsOf, parseVault, sweepExpired } from '@shared/vault.js';
import { atomicWriteFile, fileExists } from '../store/atomic-write.js';

/**
 * The half of the vault that encrypts, and the only place a secret is in memory as plain text.
 *
 * Modelled on `SecretStore` and different from it in one way that decides the shape: that one holds
 * a single scalar, this holds a set. **One encrypted blob rather than a file per card**, because
 * `safeStorage` encrypts a string and a set of files would be a set of atomic writes to keep
 * consistent, with a half-written vault as the failure. The whole blob is rewritten on every
 * change, which for a handful of cards costs nothing.
 *
 * Everything that can be tested lives in `shared/vault.ts`. What is here is the call Electron owns
 * and the file handling around it, which is the split `secret-store.ts` never made and pays for by
 * having no test at all.
 */
export class VaultStore {
  private entries: VaultEntry[] = [];
  /**
   * Set when the file exists and would not decrypt.
   *
   * It gates every write. A blob encrypted under another Windows account is not corrupt, it is
   * somebody's vault: writing over it would destroy something that is still recoverable by logging
   * back in as its owner. So the app says so and touches nothing.
   */
  private unreadable = false;

  constructor(private readonly filePath: string) {}

  /** True when the platform can actually encrypt. Checked before writing, never assumed. */
  available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  async load(): Promise<void> {
    this.entries = [];
    this.unreadable = false;
    if (!fileExists(this.filePath) || !this.available()) {
      return;
    }
    let plain: string;
    try {
      const base64 = (await readFile(this.filePath, 'utf8')).trim();
      // An empty file is an empty vault and not a failure: that is what a vault emptied of its last
      // card leaves behind, and `decryptString` on zero bytes throws. The noise `SecretStore` makes
      // on every poll after a cleared token is exactly this case, unhandled.
      if (base64.length === 0) {
        return;
      }
      plain = safeStorage.decryptString(Buffer.from(base64, 'base64'));
    } catch (error) {
      console.error('[vault] the vault could not be decrypted, it was left untouched', error);
      this.unreadable = true;
      return;
    }
    try {
      this.entries = parseVault(JSON.parse(plain));
    } catch {
      // Decrypted but not JSON: the bytes are ours and unusable, which is still not a reason to
      // overwrite them.
      this.unreadable = true;
    }
  }

  /** What the renderer may see: the cards, never a value. */
  state(): VaultState {
    return {
      cards: cardsOf(this.entries),
      available: this.available(),
      unreadable: this.unreadable,
    };
  }

  /**
   * One secret, for the two gestures that move it. Never crosses IPC by itself.
   *
   * ⚠️ **Sweeps first, and that is the case the timer cannot cover.** A laptop asleep for six hours
   * runs no interval and `setInterval` does not catch up, so the list on screen would still hold a
   * card that died during the nap and a click would hand out a secret its owner had asked to be
   * destroyed. The timer keeps the display honest; this keeps the answer honest.
   */
  async valueOf(id: string, now: Date): Promise<string | null> {
    await this.sweep(now);
    return this.entries.find((entry) => entry.card.id === id)?.value ?? null;
  }

  /**
   * Adds a card, or renames one.
   *
   * ⚠️ **The value of an existing card is never replaced, and the expiry rule is what forbids it.**
   * A lifetime is measured from creation, so a new secret under an old card would either inherit
   * the remaining life of the one it replaced, which is an expiry describing the wrong secret, or
   * silently restart the clock, which contradicts what the reader chose. Rotating a key is
   * therefore remove and add, said on screen rather than left to be discovered.
   *
   * An empty value on an existing card consequently means "keep the stored one", which is also the
   * Jira token's contract: the form is never told the value, so it cannot send it back, and an
   * empty string would wipe a working secret on every rename.
   */
  async save(card: VaultCard, value: string): Promise<{ ok: boolean; message: string }> {
    if (this.unreadable) {
      return { ok: false, message: 'The vault could not be read, so nothing was written' };
    }
    if (!this.available()) {
      return { ok: false, message: 'Encryption is unavailable on this machine: nothing was saved' };
    }
    const existing = this.entries.find((entry) => entry.card.id === card.id);
    if (existing === undefined && value.length === 0) {
      return { ok: false, message: 'A card needs a value' };
    }
    /*
     * An existing card keeps its stored value AND its expiry, whatever arrives.
     *
     * The expiry is carried over from the stored card rather than from the payload for the same
     * reason the value is: both were decided at creation, and letting either be edited would make
     * the card describe a secret it no longer holds.
     */
    this.entries =
      existing === undefined
        ? [...this.entries, { card, value }]
        : this.entries.map((entry) =>
            entry.card.id === card.id
              ? {
                  card: { ...card, createdAt: entry.card.createdAt, expiresAt: entry.card.expiresAt },
                  value: entry.value,
                }
              : entry,
          );
    await this.flush();
    return { ok: true, message: existing === undefined ? 'Card added' : 'Card saved' };
  }

  /** Removes a card. "Destroyed" means absent from the file, which is what `flush` writes. */
  async remove(id: string): Promise<boolean> {
    if (this.unreadable) {
      return false;
    }
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.card.id !== id);
    if (this.entries.length === before) {
      return false;
    }
    await this.flush();
    return true;
  }

  /**
   * Destroys whatever has expired, and says what it destroyed.
   *
   * ⚠️ **Run at start-up as well as on the timer, and the start-up pass is the one that matters.**
   * A timer cannot fire while the app is closed, so a card whose hour passed overnight would
   * otherwise be sitting there readable the next morning, which is the opposite of what its owner
   * asked for. Sweeping before anything can read the vault is what makes the promise true rather
   * than best effort.
   */
  async sweep(now: Date): Promise<readonly VaultCard[]> {
    if (this.unreadable || this.entries.length === 0) {
      return [];
    }
    const { dropped } = sweepExpired(cardsOf(this.entries), now);
    if (dropped.length === 0) {
      return [];
    }
    const gone = new Set(dropped.map((card) => card.id));
    this.entries = this.entries.filter((entry) => !gone.has(entry.card.id));
    await this.flush();
    return dropped;
  }

  /**
   * Throws the unreadable blob away and starts over.
   *
   * The one way out of `unreadable`, and it exists because a refusal with no exit is a dead
   * feature: a vault from a reinstalled profile would otherwise block every write for ever. It is
   * destructive and unrecoverable, so the caller confirms with a dialog before reaching it, the
   * same gesture discarding changes already goes through.
   */
  async reset(): Promise<void> {
    this.entries = [];
    this.unreadable = false;
    await atomicWriteFile(this.filePath, '');
  }

  /**
   * Rewrites the whole blob.
   *
   * ⚠️ **"Destroyed" means this app has no record and will never show or send it again.** It does
   * not mean the bytes are gone from the disk: `atomicWriteFile` writes a new file and renames over
   * the old one, so the previous ciphertext can survive in unreferenced blocks, and on an SSD with
   * wear levelling an in-place overwrite would not fix that either. Promising the second is a
   * promise nothing here can keep.
   *
   * An empty vault writes an empty file rather than leaving the last ciphertext behind: the point
   * of deleting a card is that it is gone, and a file still holding it would be a deletion that
   * only happened on screen.
   */
  private async flush(): Promise<void> {
    if (this.entries.length === 0) {
      await atomicWriteFile(this.filePath, '');
      return;
    }
    const plain = JSON.stringify(
      this.entries.map((entry) => ({ ...entry.card, value: entry.value })),
    );
    await atomicWriteFile(this.filePath, safeStorage.encryptString(plain).toString('base64'));
  }
}
