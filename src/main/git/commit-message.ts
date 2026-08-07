import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../store/atomic-write.js';

/**
 * Writes a commit message to a file and returns its path.
 *
 * A file rather than `git commit -m`, for two independent reasons:
 * - a message is multi-line by convention (subject, blank line, body) and `-m` would need one flag
 *   per paragraph, so the form would decide the shape of the message instead of the user;
 * - the message reaches git as **bytes on disk** and never as a command-line argument, so nothing in
 *   it can be read as an option. A subject starting with `-` is a real thing people type.
 *
 * The file is **kept** after the commit rather than deleted. It costs nothing, and when a pre-commit
 * hook rejects the commit it is the only surviving copy of what was typed: deleting it would turn a
 * failed hook into lost work.
 */
export async function writeCommitMessage(
  folder: string,
  projectId: string,
  message: string,
): Promise<string> {
  await mkdir(folder, { recursive: true });
  const file = join(folder, `${safeName(projectId)}.txt`);
  // No BOM: git reads commit messages as UTF-8 by default, and a BOM would end up as three stray
  // characters at the head of the subject line.
  await atomicWriteFile(file, normalize(message));
  return file;
}

/**
 * Normalises what the textarea produced.
 *
 * Trailing whitespace goes, and a final newline is added: git's own `--cleanup` would do the first,
 * but a message with no terminating newline makes `git log` print the next line flush against the
 * subject in some formats.
 */
function normalize(message: string): string {
  return `${message.replace(/\s+$/, '')}\n`;
}

/**
 * Reduces a project id to something safe to `join`.
 *
 * A `ProjectId` is derived from a folder name and is normally tame, but it is a free-form string in
 * the contract and this value becomes part of a path: anything outside the allowed set could walk out
 * of the folder. Same guard, and the same reason, as `NOTE_ID_PATTERN`.
 */
function safeName(projectId: string): string {
  const cleaned = projectId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return cleaned.length > 0 ? cleaned : 'commit';
}
