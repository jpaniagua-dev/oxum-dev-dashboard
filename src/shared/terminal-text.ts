/**
 * Reading terminal output as plain text.
 *
 * A pty emits a stream meant for a terminal emulator, not for a reader: colours, cursor moves, line
 * erases, window titles. Anything that wants to *show* that output outside an xterm has to undo all
 * of it first, and there is exactly one right way to do that, which is why this lives in `shared`
 * rather than beside either of its two callers. The main process parses build markers out of it and
 * the renderer draws a preview of it, and two strippers would disagree about what a line is.
 */

/**
 * Strips ANSI escape sequences.
 *
 * Both patterns are anchored on the escape character (`\x1b`). Matching bracket sequences without it
 * would also eat literal text such as `[ERROR]`, silently destroying the very markers a parser is
 * looking for.
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
