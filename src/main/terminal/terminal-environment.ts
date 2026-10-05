const COLOR_ENV_NAMES = new Set(['TERM', 'COLORTERM', 'FORCE_COLOR', 'NO_COLOR']);

/**
 * Advertise the embedded xterm's truecolor support without overriding explicit color preferences.
 * FORCE_COLOR=1 means only 16 colors to clients such as Codex, which then discard RGB accents.
 * Project capabilities are merged first so their environment overrides follow the same policy.
 */
export function terminalEnvironment(
  inherited: NodeJS.ProcessEnv,
  project: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const source of [inherited, project]) {
    for (const [key, value] of Object.entries(source)) {
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
