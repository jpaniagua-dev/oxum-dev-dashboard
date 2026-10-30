import { readFile } from 'node:fs/promises';
import { safeStorage } from 'electron';
import type {
  VaultEntry,
  VaultFileBinding,
  VaultFileCard,
  VaultSecretInput,
  VaultState,
} from '@shared/vault.js';
import {
  cardsOf,
  expiredFiles,
  expiryFrom,
  parseVault,
  sameVaultFile,
  secretConflict,
} from '@shared/vault.js';
import { atomicWriteFile, fileExists } from '../store/atomic-write.js';

/**
 * The half of the vault that encrypts, and the authority that may release a value inside main.
 *
 * Modelled on `SecretStore` and different from it in one way that decides the shape: that one holds
 * a single scalar, this holds a set. **One encrypted blob rather than a file per card**, because
 * `safeStorage` encrypts a string and a set of files would be a set of atomic writes to keep
 * consistent, with a half-written vault as the failure. The whole blob is rewritten on every
 * change, which for a handful of files costs nothing.
 *
 * Values leave through `valueOf` (a manual copy or reveal) and `entryForFile` (writing the file).
 * They never ride on `VaultState`.
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

  async load(now: Date): Promise<void> {
    this.entries = [];
    this.unreadable = false;
    if (!fileExists(this.filePath) || !this.available()) {
      return;
    }
    let plain: string;
    try {
      const base64 = (await readFile(this.filePath, 'utf8')).trim();
      // An empty file is an empty vault and not a failure: that is what a vault emptied of its last
      // card leaves behind, and `decryptString` on zero bytes throws.
      if (base64.length === 0) {
        return;
      }
      plain = safeStorage.decryptString(Buffer.from(base64, 'base64'));
    } catch (error) {
      console.error('[vault] the vault could not be decrypted, it was left untouched', error);
      this.unreadable = true;
      return;
    }
    let migrated: boolean;
    try {
      const parsed = parseVault(JSON.parse(plain), now);
      this.entries = parsed.entries;
      migrated = parsed.migrated;
    } catch {
      // Decrypted but not JSON: the bytes are ours and unusable, which is still not a reason to
      // overwrite them.
      this.unreadable = true;
      return;
    }
    // Written back at once, so the earlier format is read exactly once and its dropped entries
    // stop sitting in the blob.
    if (migrated) {
      await this.flush();
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

  /** One secret, for the two gestures that move it. Never crosses IPC by itself. */
  valueOf(id: string, name: string): string | null {
    const entry = this.entries.find((candidate) => candidate.card.id === id);
    return entry?.card.secrets.includes(name) === true ? (entry.values[name] ?? null) : null;
  }

  /** The values for one generated file. Main-process only; never exposed through IPC. */
  entryForFile(binding: VaultFileBinding): VaultEntry | undefined {
    return this.entries.find((entry) => sameVaultFile(entry.card.binding, binding));
  }

  /** The cards whose generated file has outlived its lifetime. Reads only. */
  expired(now: Date): readonly VaultFileCard[] {
    return expiredFiles(cardsOf(this.entries), now);
  }

  /**
   * Adds a file card, or replaces one.
   *
   * A secret sent with an empty value keeps the value stored under its `from` name, which is how a
   * secret is renamed without being retyped: the form is never told a value, so it cannot send one
   * back. A secret left out of `secrets` is gone. The dates are the store's, never the payload's:
   * `generatedAt` says what is on disk, and only generating or removing the file may change it.
   */
  async save(
    card: VaultFileCard,
    secrets: readonly VaultSecretInput[],
  ): Promise<{ ok: boolean; message: string }> {
    if (this.unreadable) {
      return { ok: false, message: 'The vault could not be read, so nothing was written' };
    }
    if (!this.available()) {
      return { ok: false, message: 'Encryption is unavailable on this machine: nothing was saved' };
    }
    const existing = this.entries.find((entry) => entry.card.id === card.id);
    const values: Record<string, string> = {};
    for (const secret of secrets) {
      const value =
        secret.value.length > 0
          ? secret.value
          : secret.from === null
            ? undefined
            : existing?.values[secret.from];
      if (value === undefined || value.length === 0) {
        return { ok: false, message: `${secret.name} needs a value` };
      }
      values[secret.name] = value;
    }
    const names = secrets.map((secret) => secret.name);
    const conflict = secretConflict({ secrets: names, text: card.text });
    if (conflict !== null) {
      return { ok: false, message: conflict };
    }
    if (names.length === 0 && card.text.trim().length === 0) {
      return { ok: false, message: 'Add a secret or some text' };
    }
    if (
      this.entries.some(
        (entry) => entry.card.id !== card.id && sameVaultFile(entry.card.binding, card.binding),
      )
    ) {
      return { ok: false, message: `${card.binding.path} already has a card in that project` };
    }

    // A card moved to another file has nothing on disk there yet; the old file is the caller's to
    // clean up, through a sync of the binding it left.
    const generatedAt =
      existing !== undefined && sameVaultFile(existing.card.binding, card.binding)
        ? existing.card.generatedAt
        : null;
    const next: VaultEntry = {
      card: {
        ...card,
        createdAt: existing?.card.createdAt ?? card.createdAt,
        generatedAt,
        expiresAt: generatedAt === null ? null : expiryFrom(generatedAt, card.lifetimeMinutes),
        secrets: names,
      },
      values,
    };
    this.entries =
      existing === undefined
        ? [...this.entries, next]
        : this.entries.map((entry) => (entry.card.id === card.id ? next : entry));
    await this.flush();
    return { ok: true, message: existing === undefined ? 'File card added' : 'File card saved' };
  }

  /** Records that the file was just written, which starts its lifetime. */
  async markGenerated(id: string, now: Date): Promise<void> {
    const generatedAt = now.toISOString();
    await this.update(id, (card) => ({
      ...card,
      generatedAt,
      expiresAt: expiryFrom(generatedAt, card.lifetimeMinutes),
    }));
  }

  /** Records that nothing is on disk any more. A card already in that state writes nothing. */
  async markRemoved(id: string): Promise<void> {
    const entry = this.entries.find((candidate) => candidate.card.id === id);
    if (entry === undefined || entry.card.generatedAt === null) {
      return;
    }
    await this.update(id, (card) => ({ ...card, generatedAt: null, expiresAt: null }));
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

  private async update(id: string, change: (card: VaultFileCard) => VaultFileCard): Promise<void> {
    if (this.unreadable || !this.entries.some((entry) => entry.card.id === id)) {
      return;
    }
    this.entries = this.entries.map((entry) =>
      entry.card.id === id ? { ...entry, card: change(entry.card) } : entry,
    );
    await this.flush();
  }

  /**
   * Rewrites the whole blob.
   *
   * ⚠️ **"Destroyed" means this app has no record and will never show or write it again.** It does
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
    const plain = JSON.stringify({
      version: 2,
      files: this.entries.map((entry) => ({ ...entry.card, values: entry.values })),
    });
    await atomicWriteFile(this.filePath, safeStorage.encryptString(plain).toString('base64'));
  }
}
