import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * The configured folder when it is on disk, `''` otherwise.
 *
 * For the places where an unset or missing folder has a better answer than an error: a review run
 * in the repository instead of a workspace, a detection that offers to pick a folder.
 */
export function existingFolder(path: string, exists: (path: string) => boolean = existsSync): string {
  const folder = path.trim();
  return folder.length > 0 && exists(folder) ? folder : '';
}

/**
 * Where a headless run starts when it needs no particular repository: the configured folder when
 * it exists, the home folder otherwise.
 *
 * The defaults used to name a layout that only existed on the machine they were written on, so on
 * any other one the run was spawned in a missing folder and failed before reading a byte.
 */
export function runFolder(configured: string, exists: (path: string) => boolean = existsSync): string {
  return existingFolder(configured, exists) || homedir();
}
