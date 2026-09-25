/**
 * Which CLI coding agent this app drives, and how.
 *
 * "Run the agent" is not an operation that exists. What exists is "run **this** binary with
 * **these** flags, feed it **this** way, and read its answer **that** way", and all four differ
 * between Claude Code, Codex, OpenCode and whatever ships next. Three of the four fail in silence
 * when they are wrong, which is why they are settings rather than assumptions:
 *
 * - the flag that means "answer and exit": without it the app spawns an interactive UI into a pipe,
 *   nothing ever comes back, and the run sits there until its timeout;
 * - how the prompt gets in: a sprint prompt is tens of kilobytes, past what a Windows command line
 *   accepts, so an agent that only reads an argument needs a file and would otherwise be handed a
 *   truncated prompt rather than an error;
 * - the read-only restriction: it is what makes an analysis an analysis, and a profile without it
 *   runs a pull request review with an agent that can write to the repository.
 *
 * A **command template** rather than a field per flag, because this module cannot anticipate the
 * options of a CLI it has never seen. One line the user can copy from their agent's own
 * documentation beats ten checkboxes that each guess at a spelling.
 */

/** How the prompt reaches the agent. */
export type PromptDelivery = 'stdin' | 'argument' | 'file';

/**
 * How the answer is read out of what the agent printed.
 *
 * `stream-json` is line-delimited JSON, one object per line, which is what makes a live progress
 * line possible: every tool call arrives as it happens. `stdout` is the universal fallback, the
 * whole output taken as the answer, and it costs the progress detail because there is nothing in it
 * to count. Degrading to a spinner is right; pretending to know what the agent is doing is not.
 */
export type AnswerFormat = 'stream-json' | 'stdout';

export interface AgentProfile {
  /**
   * What the agent is called, in errors and in the settings.
   *
   * Used in every message this app writes about it, so "Codex was not found on the PATH" says the
   * true thing rather than naming whichever agent happened to be hardcoded.
   */
  readonly label: string;
  /**
   * Command for a run whose output the app parses: the triage, the commit message, the review.
   *
   * `{model}` is replaced by the model flag, or removed when no model is pinned. Everything else is
   * passed through as written, split on spaces with quoted sections kept whole.
   */
  readonly headless: string;
  /**
   * Command for the one run that is interactive and lands in a terminal tab.
   *
   * Its prompt is always appended as a quoted argument, because a terminal tab has no stdin to
   * write to: the user is the one typing there.
   */
  readonly interactive: string;
  /** How the prompt reaches a headless run. */
  readonly promptVia: PromptDelivery;
  readonly answerFormat: AnswerFormat;
  /**
   * Flag that opens one more directory to a headless run, or empty when the agent has none.
   *
   * Only the pull request review needs it, and only because it reads two trees: the standards live
   * in the workspace, the conventions live in the repository. An agent without it is not refused;
   * the review runs in the repository instead, which is the half a code review cannot do without.
   */
  readonly extraDirFlag: string;
  /**
   * Flag that pins a model, with `{model}` where the name goes, or empty when the agent has none.
   *
   * A template rather than a boolean because the spelling is not guessable: `--model X` and `-m X`
   * are both common, and so is an agent that takes none at all.
   */
  readonly modelFlag: string;
  /**
   * File this agent reads its instructions from, looked up in the working directory and its
   * ancestors.
   *
   * `CLAUDE.md` for Claude Code, `AGENTS.md` for Codex, and the reason it is a setting rather than a
   * constant is that this app drives whichever agent the user configured. It is the one piece of an
   * agent's context that is knowable without understanding that agent's private storage, so it is
   * the part the Agents tab can show for **any** profile.
   */
  readonly instructionFile: string;
}

/**
 * Claude Code, the one profile that is verified against a real CLI.
 *
 * Every flag here was exercised: `--print` because the plain envelope only arrives at the end,
 * `stream-json` with `--verbose` because print mode requires it, the three read-only tools because
 * reading the code is the difference between a verdict and a guess, and no `--bare` because that
 * mode wants an API key while a normal install is signed in through OAuth.
 */
export const CLAUDE_CODE_PROFILE: AgentProfile = {
  label: 'Claude Code',
  headless:
    'claude --print --output-format stream-json --verbose ' +
    '--allowedTools Read Grep Glob --no-session-persistence {model}',
  interactive: 'claude {model} --dangerously-skip-permissions',
  promptVia: 'stdin',
  answerFormat: 'stream-json',
  extraDirFlag: '--add-dir',
  modelFlag: '--model {model}',
  instructionFile: 'CLAUDE.md',
};

/**
 * Splits a command template into a program and its arguments.
 *
 * Quoted sections are kept whole, because a path with a space is the one thing a user will write
 * first and the one thing a naive split on spaces breaks. Everything else is a plain token: this is
 * **not** a shell, so there is no expansion, no globbing and no substitution, which is deliberate.
 * The template is a list of arguments written on one line, not a command line to interpret.
 */
export function splitCommand(template: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote = '';
  for (const char of template.trim()) {
    if (quote !== '') {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * The program and arguments a headless run launches.
 *
 * `{model}` expands to the profile's own model flag, and **disappears entirely** when no model is
 * pinned: an empty `--model ""` is a run that fails before it starts, not a default, which is the
 * rule `modelArgs` already established for Claude Code and which is true of every CLI met so far.
 *
 * Pure and exported, because this is the line that decides whether anything runs at all, and
 * because the settings window shows it back to the user before they trust it.
 */
export function buildHeadlessCommand(
  profile: AgentProfile,
  options: {
    model?: string;
    extraDirs?: readonly string[];
    prompt?: string;
    promptPath?: string;
  } = {},
): { file: string; args: string[] } {
  const model = (options.model ?? '').trim();
  const modelTokens =
    model.length === 0 || profile.modelFlag.trim().length === 0
      ? []
      : splitCommand(profile.modelFlag.replace('{model}', model));

  const tokens: string[] = [];
  for (const token of splitCommand(profile.headless)) {
    if (token === '{model}') {
      tokens.push(...modelTokens);
      continue;
    }
    tokens.push(token.replace('{model}', model));
  }

  const dirFlag = profile.extraDirFlag.trim();
  if (dirFlag.length > 0) {
    for (const dir of options.extraDirs ?? []) {
      if (dir.trim().length > 0) {
        tokens.push(dirFlag, dir);
      }
    }
  }

  /*
   * The prompt, when it does not go in on stdin.
   *
   * Appended last, as ONE argument whatever it contains: `spawn` is called with an argument array
   * and no shell, so quotes, backticks and newlines inside it reach the agent as bytes rather than
   * as syntax. A profile that takes its prompt this way is still subject to the operating system's
   * command line limit, which is why stdin is the default and this is the fallback.
   */
  if (profile.promptVia === 'argument' && options.prompt !== undefined) {
    tokens.push(options.prompt);
  }
  if (profile.promptVia === 'file' && options.promptPath !== undefined) {
    tokens.push(options.promptPath);
  }

  const [file, ...args] = tokens;
  return { file: file ?? '', args };
}

/**
 * The same command as one readable line, for an error message or a tooltip.
 *
 * The single most useful thing this module produces, and the reason it exists at all: a headless run
 * has no terminal tab, so when one fails there is nothing on screen that says what was actually
 * launched. Without this, a wrong flag reads as six minutes of silence followed by "timed out".
 */
export function describeCommand(file: string, args: readonly string[]): string {
  return [file, ...args].map((token) => (token.includes(' ') ? `"${token}"` : token)).join(' ');
}

/** Reads a profile off disk or off an IPC payload, filling anything missing from the default. */
export function readProfile(value: unknown, fallback: AgentProfile = CLAUDE_CODE_PROFILE): AgentProfile {
  if (typeof value !== 'object' || value === null) {
    return fallback;
  }
  const raw = value as Record<string, unknown>;
  const text = (key: string, or: string): string =>
    typeof raw[key] === 'string' && raw[key].trim().length > 0 ? (raw[key] as string).trim() : or;

  return {
    label: text('label', fallback.label),
    headless: text('headless', fallback.headless),
    interactive: text('interactive', fallback.interactive),
    promptVia:
      raw['promptVia'] === 'argument' || raw['promptVia'] === 'file' || raw['promptVia'] === 'stdin'
        ? raw['promptVia']
        : fallback.promptVia,
    // Anything unrecognised reads as plain stdout, which works for every agent and only costs the
    // progress detail. Falling back the other way would parse an output that is not JSONL and
    // report every run as empty.
    answerFormat: raw['answerFormat'] === 'stream-json' ? 'stream-json' : 'stdout',
    // Empty is a real value here, unlike the two above: it means "this agent has no such flag".
    extraDirFlag: typeof raw['extraDirFlag'] === 'string' ? raw['extraDirFlag'].trim() : fallback.extraDirFlag,
    modelFlag: typeof raw['modelFlag'] === 'string' ? raw['modelFlag'].trim() : fallback.modelFlag,
    // Not empty-able, unlike the two flags above: every agent reads its instructions from somewhere,
    // and an empty name would make the Agents tab walk the tree looking for a file called nothing.
    instructionFile: text('instructionFile', fallback.instructionFile),
  };
}
