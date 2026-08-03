import type { ProjectKind, ServerPhase } from '@shared/contracts.js';

/**
 * Derives a project's phase from its terminal output.
 *
 * Only stable, human-visible markers are matched. Angular's output is full of spinners, progress
 * redraws and colour codes, so anything cleverer than a handful of fixed strings would break on
 * the next minor release. The port probe stays the ground truth for "is it really serving"; this
 * parser answers "what is it doing", which a port cannot.
 */

/**
 * Strips ANSI escape sequences, which surround almost every marker in Angular's output.
 *
 * Both patterns are anchored on the escape character (`\x1b`). Matching bracket sequences without
 * it would also eat literal text such as `[ERROR]`, silently destroying the very markers this file
 * exists to find.
 */
export function stripAnsi(text: string): string {
  return (
    text
      // CSI: colours, cursor moves, line erases.
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // OSC: window titles, terminated by BEL or ST.
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
  );
}

export interface ParsedOutput {
  /** Phase implied by this chunk, or null when nothing conclusive appeared. */
  readonly phase: ServerPhase | null;
  /** First error line, when the chunk reports a failure. */
  readonly errorSummary: string | null;
  /** Number of errors reported, when the toolchain states it. */
  readonly errorCount: number | null;
  /** Port announced by the dev server, which beats the configured guess. */
  readonly port: number | null;
}

const NOTHING: ParsedOutput = { phase: null, errorSummary: null, errorCount: null, port: null };

/**
 * Interprets one chunk of pty output.
 *
 * Order matters: success markers are checked before error markers, so a rebuild that succeeds
 * after a failure clears the error state rather than leaving the row red forever.
 */
export function parseOutputChunk(chunk: string, kind: ProjectKind): ParsedOutput {
  const text = stripAnsi(chunk);

  // Printed once the build settles and the server is holding.
  if (/Watch mode enabled|Application bundle generation complete/.test(text)) {
    return {
      // A `watch` project has no server, so "compiled and waiting" is its healthy resting state.
      phase: kind === 'server' ? 'serving' : 'watching',
      errorSummary: null,
      errorCount: 0,
      port: readPort(text),
    };
  }

  // esbuild's failure format, used by the Angular builder.
  const buildError = /^\s*(?:✘|X)\s*\[ERROR\]\s*(.+)$/m.exec(text);
  if (buildError !== null) {
    return {
      phase: 'build-error',
      errorSummary: buildError[1]?.trim() ?? 'Erreur de build',
      errorCount: countErrors(text),
      port: null,
    };
  }

  // The `start` scripts run `npm run lint` first, so a lint failure aborts before any build ever
  // starts. That is a different problem from a build error and deserves its own state.
  if (/Lint(?:ing)? errors found|\d+ problems? \(\d+ errors?/i.test(text)) {
    return {
      phase: 'lint-error',
      errorSummary: firstMeaningfulLine(text) ?? 'Erreur de lint',
      errorCount: countErrors(text),
      port: null,
    };
  }

  if (/ng lint|Linting|stylelint/i.test(text)) {
    return { ...NOTHING, phase: 'linting' };
  }

  if (/Building|Generating browser application bundles|Initial chunk files/i.test(text)) {
    return { ...NOTHING, phase: 'building' };
  }

  const port = readPort(text);
  if (port !== null) {
    return { ...NOTHING, port };
  }

  return NOTHING;
}

/** Reads the port from Angular's `Local:   http://localhost:4200/` banner. */
export function readPort(text: string): number | null {
  const match = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/.exec(text);
  if (match === null) {
    return null;
  }
  const port = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(port) ? port : null;
}

/** Counts errors, preferring an explicit total when the toolchain prints one. */
export function countErrors(text: string): number {
  const summary = /(\d+)\s+errors?/i.exec(text);
  if (summary !== null) {
    const parsed = Number.parseInt(summary[1] ?? '', 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const occurrences = text.match(/\[ERROR\]/g);
  return occurrences === null ? 1 : occurrences.length;
}

/** First non-empty line, used when the toolchain gives no structured message. */
function firstMeaningfulLine(text: string): string | null {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}
