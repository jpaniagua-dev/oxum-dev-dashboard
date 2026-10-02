import { tmpdir } from 'node:os';
import { parseTriggerResult, toolResults } from '@shared/extensions.js';
import { runCli } from './agent-cli.js';

/**
 * Claude Code routines, reached the only way they can be from this machine.
 *
 * A routine lives on claude.ai, behind an API whose OAuth token Claude Code adds inside its own
 * process and never exposes. So each read or change is one headless `claude -p` run allowed exactly
 * one tool, `RemoteTrigger`, and the answer is taken from the transcript's tool result rather than
 * from what the model says: the model only has to make the call and reply OK.
 *
 * Reading the token from Claude Code's credentials file and calling the API directly was the
 * faster option and was refused: it would make this app hold the account's token and depend on an
 * undocumented endpoint, in a public repository whose rule is to stay out of Claude's private files.
 *
 * The run is stripped of everything it does not need, which is what took a read from 78 seconds
 * and $0.10 to about 5 seconds and $0.01: `--restricted` ignores the settings files (so no user
 * hook fires and no plugin loads), `--strict-mcp-config` starts no MCP server, `--disable-slash-commands`
 * loads no skill, and the cheapest model is enough to relay one call.
 */

const FLAGS: readonly string[] = [
  '--restricted',
  '--tools',
  'RemoteTrigger',
  '--allowedTools',
  'RemoteTrigger',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--model',
  'haiku',
  '--output-format',
  'stream-json',
  '--verbose',
];

export type TriggerCall =
  | { readonly action: 'list' }
  | { readonly action: 'update'; readonly id: string; readonly enabled: boolean }
  | { readonly action: 'run'; readonly id: string };

export type TriggerAnswer =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly message: string };

/** The sentence that asks for one call. Pure, so the exact wording is pinned by a test. */
export function triggerPrompt(call: TriggerCall): string {
  const ask =
    call.action === 'list'
      ? 'Use action "list".'
      : call.action === 'update'
        ? `Use action "update", trigger_id "${call.id}" and body {"enabled": ${String(call.enabled)}}.`
        : `Use action "run" and trigger_id "${call.id}", with no body.`;
  return `${ask} Call the RemoteTrigger tool exactly once with those arguments, then reply with the single word OK.`;
}

export async function callTrigger(command: string, call: TriggerCall): Promise<TriggerAnswer> {
  if (call.action !== 'list' && !/^[\w-]+$/.test(call.id)) {
    return { ok: false, message: 'That routine id is not one claude.ai issued' };
  }
  const result = await runCli(command, ['-p', triggerPrompt(call), ...FLAGS], {
    // Out of every project, so no instruction file of a repository is read for a one-call run.
    cwd: tmpdir(),
    timeout: 120_000,
  });
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  const results = toolResults(result.stdout);
  if (results.length === 0) {
    return { ok: false, message: 'Claude Code did not call RemoteTrigger. Is this account signed in to claude.ai?' };
  }
  if (results.length > 1) {
    // Said, never hidden: for `run` it means a routine may have fired twice.
    return { ok: false, message: `RemoteTrigger was called ${results.length} times instead of once` };
  }
  const parsed = parseTriggerResult(results[0] ?? '');
  if (parsed === null) {
    return { ok: false, message: 'RemoteTrigger answered in a form this app does not read' };
  }
  if (parsed.status < 200 || parsed.status >= 300) {
    return { ok: false, message: `claude.ai answered HTTP ${parsed.status}` };
  }
  return { ok: true, body: parsed.body };
}
