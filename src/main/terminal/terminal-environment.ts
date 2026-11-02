const COLOR_ENV_NAMES = new Set(['TERM', 'COLORTERM', 'FORCE_COLOR', 'NO_COLOR']);

/**
 * What a Claude Code session exports to its own children, and none of it describes a terminal of
 * this app.
 *
 * The app inherits them when it is started from inside a session (`npm run dev` typed in an agent's
 * tab), and every agent it then opened believed it was that session's child: measured on
 * 2026-10-13, such a child says transcript saving is off because of the inherited
 * `CLAUDE_CODE_CHILD_SESSION` marker, and writes no conversation, so it can never be resumed. The messaging token is the
 * parent's, too. Only these per-session markers go: a `CLAUDE_CODE_*` variable a person set on
 * purpose (a provider, an output cap) is configuration and is passed on.
 */
const PARENT_SESSION_MARKERS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
]);

/**
 * Keeps Git Bash from rewriting the slash command an agent's prompt starts with into a Windows path.
 *
 * MSYS converts an argument that looks like a POSIX path when bash hands it to a native program, so
 * `claude "/ticket PROJ-123 in the web-app repository"` reached the agent as
 * `C:/Program Files/Git/ticket PROJ-123 ...`: a sentence the model had to guess at, not a command.
 * Only that one prefix is excluded, so a real path such as `/c/Users` is still converted for every
 * command the agent later runs with this environment, and an exclusion list already set is extended
 * rather than replaced. Nothing outside Git Bash reads the variable.
 */
export function slashCommandEnvironment(command: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const prefix = /"(\/[A-Za-z0-9][A-Za-z0-9:_.-]*)/.exec(command)?.[1];
  if (prefix === undefined) {
    return {};
  }
  const existing = inherited.MSYS2_ARG_CONV_EXCL;
  return { MSYS2_ARG_CONV_EXCL: existing ? `${existing};${prefix}` : prefix };
}

/**
 * Advertise the embedded xterm's truecolor support without overriding explicit color preferences.
 * FORCE_COLOR=1 means only 16 colors to clients such as Codex, which then discard RGB accents.
 * A project's extra environment is merged first so its overrides follow the same policy.
 */
export function terminalEnvironment(
  inherited: NodeJS.ProcessEnv,
  project: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const source of [inherited, project]) {
    for (const [key, value] of Object.entries(source)) {
      if (source === inherited && PARENT_SESSION_MARKERS.has(key.toUpperCase())) {
        continue;
      }
      // Windows environment names are case-insensitive; avoid duplicate color controls in the PTY.
      const canonical = COLOR_ENV_NAMES.has(key.toUpperCase()) ? key.toUpperCase() : key;
      // node-pty serializes undefined as the literal string "undefined", not an absent variable.
      if (value === undefined) delete env[canonical];
      else env[canonical] = value;
    }
  }
  env.TERM ??= 'xterm-256color';
  env.COLORTERM ??= 'truecolor';
  if (env.FORCE_COLOR === undefined && !env.NO_COLOR) {
    env.FORCE_COLOR = '3';
  }
  return env;
}
