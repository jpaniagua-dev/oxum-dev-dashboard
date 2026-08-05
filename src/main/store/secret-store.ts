import { readFile } from 'node:fs/promises';
import { safeStorage } from 'electron';
import { atomicWriteFile, fileExists } from './atomic-write.js';

/**
 * The Jira API token, encrypted at rest.
 *
 * Deliberately **not** in `settings.json`: that file is plain text, hand-editable, and gets copied around
 * without a second thought. A Jira API token grants full access to the account, so it lives in its own
 * file, encrypted by `safeStorage`, which on Windows means DPAPI keyed to the signed-in user: copying the
 * file to another machine or another account yields nothing readable.
 *
 * The ciphertext is stored base64-encoded so the existing atomic write, with its Windows `EPERM` retry,
 * can be reused as-is rather than duplicated for binary.
 */
export class SecretStore {
  constructor(private readonly filePath: string) {}

  /** True when the platform can actually encrypt. Checked before writing, never assumed. */
  available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  async read(): Promise<string> {
    if (!fileExists(this.filePath) || !this.available()) {
      return '';
    }
    try {
      const base64 = await readFile(this.filePath, 'utf8');
      return safeStorage.decryptString(Buffer.from(base64.trim(), 'base64'));
    } catch (error) {
      // A token encrypted under another Windows account, or a corrupted file: treated as absent rather
      // than fatal, so the app starts and the settings can simply be filled in again.
      console.error('[secrets] jeton illisible, il faudra le ressaisir', error);
      return '';
    }
  }

  /**
   * Stores a token, or clears it when handed an empty string.
   *
   * Refuses rather than falling back to plain text when encryption is unavailable: writing a secret in
   * the clear because the safe was locked is exactly the kind of silent downgrade nobody notices.
   */
  async write(token: string): Promise<{ ok: boolean; message: string }> {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      await atomicWriteFile(this.filePath, '');
      return { ok: true, message: 'Jeton effacé' };
    }
    if (!this.available()) {
      return {
        ok: false,
        message: 'Chiffrement indisponible sur ce poste : le jeton n’a pas été enregistré',
      };
    }
    await atomicWriteFile(this.filePath, safeStorage.encryptString(trimmed).toString('base64'));
    return { ok: true, message: 'Jeton enregistré' };
  }
}
