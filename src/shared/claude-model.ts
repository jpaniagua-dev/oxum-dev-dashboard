/**
 * The model a Claude Code run is pinned to, and how that value reaches a command line.
 *
 * Three gestures in this app start Claude Code, and they are three different jobs: classifying a
 * sprint, implementing a ticket, and writing a commit message. One default for all three is a setting
 * that is wrong for two of them, which is why each carries its own.
 *
 * Shared rather than living beside any one of them, because the settings form validates the same value
 * the main process is about to pass on: two spellings of "is this a model name" is how a field goes on
 * accepting something the run then refuses.
 */

/**
 * What a model name may contain.
 *
 * `claude --model` takes an alias (`fable`, `opus`, `sonnet`, `haiku`) or a full name
 * (`claude-fable-5`), and a pinned name can carry brackets (`claude-opus-5[1m]`). So letters, digits,
 * dot, underscore, hyphen and square brackets, opening on something that is not punctuation.
 *
 * A whitelist and not an escape, for one reason: this value reaches `bash -ic` in the handoff, where
 * brackets are glob characters and a `$` or a backtick would be expanded. Nothing outside this set can
 * be stored, so nothing outside it can reach a shell. The headless runs pass it through `spawn` with
 * an argument array and no shell, where it would have been safe anyway; the rule is uniform because
 * two rules would eventually be applied to the wrong call site.
 */
export const CLAUDE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/;

/**
 * Whether this is a **well-formed** model name, which is not the same as an existing one.
 *
 * Verified against the CLI rather than assumed: `claude --model does-not-exist-xyz` starts perfectly
 * happily and reports `"model":"does-not-exist-xyz"` in its own `init` event. It fails later, at the
 * API call, or not visibly at all. So this catches a value that could never work (`sonnet 4`,
 * `$MODEL`) and cannot catch a plausible one that simply is not a model (`sonnett`). The settings form
 * says as much by marking the first and staying quiet about the second, which is the honest split: one
 * is a shape this app can judge, the other is a fact only the API knows.
 *
 * Empty is valid: it means "whatever Claude Code is configured to use".
 */
export function isValidModel(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || CLAUDE_MODEL_PATTERN.test(trimmed);
}

/**
 * The stored form of a typed model name.
 *
 * Anything that is not a model name normalises to empty, which is the default. Silent, deliberately:
 * the settings form is where a typo is caught and shown, and by the time a value reaches here the
 * choice is between the default and a string this app has decided not to put on a command line.
 */
export function normalizeModel(value: string): string {
  const trimmed = value.trim();
  return CLAUDE_MODEL_PATTERN.test(trimmed) ? trimmed : '';
}

/**
 * The flag for a run spawned with an argument array.
 *
 * No flag at all when the model is empty, rather than an empty `--model ""`: the CLI treats a blank
 * model as an error, so the default has to be the **absence** of the option.
 */
export function modelArgs(model: string): string[] {
  const normalized = normalizeModel(model);
  return normalized.length === 0 ? [] : ['--model', normalized];
}

/**
 * The same flag for a run that goes through a shell, with a leading space so it concatenates.
 *
 * Double quotes and not single, so the one command line this produces stays valid under both the bash
 * and the `cmd` branches of `resolveShellCommand`, exactly as the prompt beside it already does. The
 * quotes are what keep `claude-opus-5[1m]` from being read as a glob; the whitelist is what keeps
 * anything worse from getting this far.
 */
export function modelFlag(model: string): string {
  const normalized = normalizeModel(model);
  return normalized.length === 0 ? '' : ` --model "${normalized}"`;
}
