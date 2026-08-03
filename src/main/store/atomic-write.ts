import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Monotonic counter making every temp file name unique within the process. */
let writeSequence = 0;

/**
 * Writes `content` to `filePath` so that the file is never observed in a partial state.
 *
 * A plain `writeFile` truncates first and then streams the bytes: a crash, a power loss
 * or a forced process kill in between leaves a truncated file, which is exactly the data
 * loss this app exists to prevent. Writing to a sibling temp file and then renaming makes
 * the swap atomic at the filesystem level, so a reader always sees either the previous
 * complete content or the new complete content.
 *
 * Each call gets its own temp file. Sharing one temp name per target path would let two
 * concurrent writers collide: the first rename consumes the temp file and the second fails
 * with ENOENT, silently dropping a save. With unique names both writes succeed and the last
 * rename wins, which is the intended "newest content" semantics.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });

  const pathDigest = createHash('sha1').update(filePath).digest('hex').slice(0, 8);
  writeSequence += 1;
  const tempName = `.${pathDigest}.${process.pid}.${writeSequence}.tmp`;
  const tempPath = join(directory, tempName);

  // `flush: true` asks Node to fsync before closing, so the bytes are on the platter
  // before the rename makes them visible. Without it the rename can win the race and
  // publish an empty file.
  await writeFile(tempPath, content, { encoding: 'utf8', flush: true });

  try {
    await renameWithRetry(tempPath, filePath);
  } catch (error) {
    // Never leave the temp file behind: the caller will retry, and stale `.tmp` files in
    // the history directory would accumulate silently.
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/** Errors that mean "someone else is touching the destination, try again shortly". */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const RENAME_ATTEMPTS = 5;

/**
 * Renames, retrying briefly on transient Windows failures.
 *
 * Replacing a file on Windows fails with EPERM whenever another handle holds the
 * destination, and that happens for mundane reasons: an antivirus scanning the file we just
 * wrote, the search indexer, or two saves landing at once. Measured locally, roughly one
 * concurrent replace in ten fails this way. Since this path runs on every autosave, a
 * single attempt would occasionally drop a save; a few retries a few milliseconds apart
 * make it a non-event.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_CODES.has(code)) {
        throw error;
      }
      await delay(attempt * 15);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ensures a directory exists, returning the path for convenient chaining. */
export async function ensureDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  return directory;
}

/** True when the path exists. Sync on purpose: used on the startup path only. */
export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}
