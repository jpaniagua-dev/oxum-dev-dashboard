import type { TriagePhase } from '@shared/contracts.js';

/**
 * Turns one `stream-json` event into something a human can read while they wait.
 *
 * The run takes minutes and a spinner alone says only "not dead". These events say what it is
 * actually doing, which is the difference between waiting and watching: a tool call names the file
 * being opened, and the first assistant text means the verdicts are being written.
 *
 * Pure, so the mapping is tested rather than discovered in front of a stalled bar.
 */
export interface ProgressStep {
  readonly phase: TriagePhase;
  /** One short line, already human-facing. Empty means "keep whatever was showing". */
  readonly detail: string;
  /** Whether this event is a unit of work worth counting in the step total. */
  readonly counts: boolean;
}

export function readProgress(event: unknown): ProgressStep | null {
  if (typeof event !== 'object' || event === null) {
    return null;
  }
  const record = event as Record<string, unknown>;

  switch (record['type']) {
    case 'system':
      // `init` is the only system event worth showing: the hook chatter around it is ours, not the
      // model's, and naming it would describe the dashboard rather than the sprint.
      return record['subtype'] === 'init'
        ? { phase: 'starting', detail: 'Session started', counts: false }
        : null;
    case 'assistant':
      return readAssistant(record);
    case 'result':
      return { phase: 'done', detail: '', counts: false };
    default:
      return null;
  }
}

function readAssistant(record: Record<string, unknown>): ProgressStep | null {
  const message = record['message'];
  const content = typeof message === 'object' && message !== null
    ? (message as Record<string, unknown>)['content']
    : undefined;
  if (!Array.isArray(content)) {
    return null;
  }

  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      continue;
    }
    const part = block as Record<string, unknown>;
    if (part['type'] === 'tool_use') {
      return { phase: 'reading', detail: describeTool(part), counts: true };
    }
    if (part['type'] === 'text') {
      // The model only writes prose once it has finished looking: this is the last phase, and the
      // one where a stalled-looking bar is in fact the answer being produced.
      return { phase: 'answering', detail: 'Writing the verdicts', counts: false };
    }
  }
  return null;
}

/**
 * Names a tool call the way the reader would name it.
 *
 * The file path is the useful half, not the tool: "Reading schema.graphql" says why the run is
 * taking its time, where "Read" says nothing at all. Only the base name is shown, since a full
 * absolute path pushes everything else out of a one-line status.
 */
function describeTool(part: Record<string, unknown>): string {
  const name = typeof part['name'] === 'string' ? part['name'] : 'Working';
  const input = part['input'];
  const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};

  const path = record['file_path'] ?? record['path'];
  if (typeof path === 'string' && path.length > 0) {
    return `Reading ${baseName(path)}`;
  }
  const pattern = record['pattern'];
  if (typeof pattern === 'string' && pattern.length > 0) {
    return `Searching ${pattern}`;
  }
  return name;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * Splits a stream into whole lines, keeping the remainder.
 *
 * A chunk from a pipe cuts wherever the buffer ended, so a JSON object routinely arrives in two
 * pieces. Parsing per chunk would drop exactly the events that matter, and silently: the run would
 * look frozen while it was working.
 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.map((line) => line.trim()).filter((line) => line.length > 0), rest };
}
