/**
 * Where a coding agent's context lives on disk, as arithmetic on a working directory.
 *
 * The Agents tab answers "what does this session actually know", and the answer is two lists: the
 * instruction files it reads on the way down from the root, and the memory it has been given for
 * this working directory. Both are derived from the cwd alone, which is what makes them computable
 * without asking the agent anything.
 *
 * Pure and shared for the usual reason: the paths are string surgery with an off-by-one at every
 * separator, the main process does the reading, and the result is worthless if the two sides
 * disagree about which folder was meant.
 */

/**
 * The folders an agent reads instructions from, nearest last.
 *
 * Root first and the working directory last, because that is the order they are **applied**: the
 * nearest file wins, so a reader scanning the list top to bottom sees the general rules before the
 * specific ones that override them. The same order the agents themselves document.
 *
 * Works on either separator without normalising the drive letter's case, since a path handed to
 * `existsSync` does not care and rewriting it would make the list disagree with what the session
 * reports as its cwd.
 */
export function ancestorDirs(cwd: string): string[] {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) {
    return [];
  }
  const parts = trimmed.split(/[\\/]/);
  const separator = trimmed.includes('\\') ? '\\' : '/';
  const dirs: string[] = [];
  for (let depth = parts.length; depth > 0; depth -= 1) {
    const dir = parts.slice(0, depth).join(separator);
    // A UNIX path splits to an empty first part, so the root would come out as the empty string.
    if (dir.length > 0) {
      dirs.push(dir);
    }
  }
  // A Windows drive on its own (`C:`) is a valid folder and the last ancestor there is.
  if (separator === '/' && trimmed.startsWith('/')) {
    dirs.push('/');
  }
  return dirs.reverse();
}

/**
 * The folder Claude Code keeps a working directory's transcripts and memory in.
 *
 * `C:\\Users\\julpan\\oxum` becomes `C--Users-julpan-oxum`: every separator and the drive's colon
 * become a dash, which is why the drive produces two in a row.
 *
 * ⚠️ **Inferred from what is on disk, not from a documented contract.** It was read off a real
 * `~/.claude/projects` on this machine and it matches every entry there, but nothing promises it
 * will not change with a Claude Code release. The caller therefore has to treat a missing folder as
 * "nothing to show" rather than as an error, and must never write into the path this returns.
 *
 * Lossy on purpose and never inverted: a folder whose own name holds a dash encodes to the same
 * shape as a nested one, so the only safe direction is cwd to key.
 */
export function claudeProjectKey(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').replace(/[\\/:]/g, '-');
}

/** One instruction file an agent will read, with the folder it came from. */
export interface InstructionFile {
  readonly dir: string;
  readonly path: string;
}

/** One memory card, as the index lists it. */
export interface MemoryCard {
  readonly name: string;
  readonly description: string;
}

/**
 * Everything the Agents tab shows about one session's context.
 *
 * Every field is allowed to be empty, and that is the design rather than an oversight: this app
 * drives whichever agent the user configured, so the only thing it can promise is the instruction
 * chain, which is a filename walked up a tree. The memory index is Claude Code's own storage and is
 * simply absent for anything else, said out loud by `memoryDir` being null.
 */
export interface AgentContext {
  readonly cwd: string;
  /** Instruction files that exist, root first. */
  readonly instructions: readonly InstructionFile[];
  /** Where the memory cards live, or `null` when this agent's storage is not one this app can read. */
  readonly memoryDir: string | null;
  readonly memory: readonly MemoryCard[];
  /** Why the memory is empty, when it is worth saying. Empty otherwise. */
  readonly memoryNote: string;
}

/**
 * Pulls the name and the one-line description out of a memory card's frontmatter.
 *
 * Deliberately not a YAML parser: the frontmatter of these files is two flat keys and a nested
 * `metadata` block nobody reads here, and a parser would be a dependency plus a failure mode for a
 * pair of lines. Anything it cannot find falls back to the filename, which is always true and never
 * blank.
 */
export function parseMemoryCard(fileName: string, text: string): MemoryCard {
  const fallback = fileName.replace(/\.md$/i, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) {
    return { name: fallback, description: '' };
  }
  const front = match[1] ?? '';
  const read = (key: string): string => {
    // Anchored to the start of a line so a `description:` sitting inside the body of another value
    // cannot be picked up, and stopped at the newline so a multi-line value yields its first line
    // rather than the rest of the file.
    const found = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(front);
    return (found?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
  };
  const name = read('name');
  return { name: name.length > 0 ? name : fallback, description: read('description') };
}
