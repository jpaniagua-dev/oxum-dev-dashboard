import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ancestorDirs,
  claudeProjectKey,
  parseMemoryCard,
  type AgentContext,
  type InstructionFile,
  type MemoryCard,
} from '@shared/agent-context.js';

/**
 * Reads what a session's agent will have in its head, off the disk.
 *
 * Synchronous, and that is a deliberate exception to how this app reads anything: it is a handful of
 * `existsSync` up a directory chain plus one folder listing, it runs on a click rather than on a
 * poll, and the alternative is threading a promise through a panel that has nothing else to wait
 * for. If it ever grows a network call or a walk of a whole tree, it stops being an exception.
 *
 * Everything it returns is allowed to be empty. This app drives whichever agent the user configured,
 * so the only universal fact is the instruction chain, which is a filename looked for up a tree. The
 * memory cards are Claude Code's own storage and are simply absent for anything else, which the
 * panel states rather than hides.
 */

/** How many cards are read. Past this the panel is a directory listing, not an index. */
const MAX_CARDS = 300;

/**
 * The agent whose private storage this app knows how to read.
 *
 * Matched on the instruction file rather than on the profile's **label**, which is free text a user
 * can set to anything: someone running Claude Code under a profile they named "Sonnet" should still
 * get their memory, and someone who named a Codex profile "Claude Code" should not.
 */
const CLAUDE_INSTRUCTION_FILE = 'CLAUDE.md';

export function readAgentContext(
  cwd: string,
  instructionFile: string,
  home: string,
): AgentContext {
  const isClaude = instructionFile.toLowerCase() === CLAUDE_INSTRUCTION_FILE.toLowerCase();
  const instructions: InstructionFile[] = [];

  /*
   * The user's global file comes first, because it is applied first.
   *
   * Claude Code only, and guarded on the instruction file rather than assumed: `~/.claude/CLAUDE.md`
   * is that agent's own convention and there is no reason another CLI would keep anything there.
   */
  if (isClaude) {
    const global = join(home, '.claude', CLAUDE_INSTRUCTION_FILE);
    if (safeExists(global)) {
      instructions.push({ dir: join(home, '.claude'), path: global });
    }
  }

  for (const dir of ancestorDirs(cwd)) {
    const path = join(dir, instructionFile);
    if (safeExists(path)) {
      instructions.push({ dir, path });
    }
  }

  if (!isClaude) {
    return {
      cwd,
      instructions,
      memoryDir: null,
      memory: [],
      // Named rather than left blank: an empty memory list next to a Codex session would otherwise
      // read as "this agent has no memory" instead of "this app cannot see it".
      memoryNote: `Memory is only read for Claude Code, and this session runs ${instructionFile}.`,
    };
  }

  const memoryDir = join(home, '.claude', 'projects', claudeProjectKey(cwd), 'memory');
  if (!safeExists(memoryDir)) {
    return {
      cwd,
      instructions,
      memoryDir,
      memory: [],
      /*
       * The finding worth surfacing, and the reason this panel exists at all.
       *
       * Memory is indexed by working directory: a session started inside a repository gets a folder
       * of its own with nothing in it, while the workspace above holds everything learned so far.
       * Measured on this machine, the workspace had seventy cards and every repository had none.
       */
      memoryNote: 'No memory for this folder. A session started here begins with none.',
    };
  }

  return { cwd, instructions, memoryDir, memory: readCards(memoryDir), memoryNote: '' };
}

/** Lists the cards of a memory folder, by name. */
function readCards(dir: string): MemoryCard[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.md'))
      // `MEMORY.md` is the index the others are listed in, not a card. Dropping it keeps the count
      // honest: a panel saying "70 cards" must not be counting the table of contents as one.
      .filter((name) => name.toLowerCase() !== 'memory.md')
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAX_CARDS);
  } catch {
    return [];
  }

  const cards: MemoryCard[] = [];
  for (const name of names) {
    try {
      cards.push(parseMemoryCard(name, readFileSync(join(dir, name), 'utf8')));
    } catch {
      // One unreadable card is not a reason to show none of the others.
      cards.push({ name: name.replace(/\.md$/i, ''), description: '' });
    }
  }
  return cards;
}

/**
 * `existsSync` that cannot throw.
 *
 * It does not throw on a missing file, but it does on a path the operating system refuses outright,
 * and a cwd can be anything: a drive that went away with its network share, a folder whose
 * permissions changed. A panel is not worth taking the main process down for.
 */
function safeExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
