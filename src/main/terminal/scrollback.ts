/**
 * The output a session keeps so its tab can be reopened without losing history.
 *
 * A ring of the chunks as they arrived, joined only when somebody asks to replay it. That is the
 * whole design, and the reason is that the obvious version is quadratic in a place where it must not
 * be. It used to read:
 *
 * ```ts
 * entry.buffer = `${entry.buffer}${data}`.slice(-BUFFER_LIMIT);
 * ```
 *
 * which is correct, and which recopies the **entire** retained buffer on every chunk of pty output
 * once the limit is reached. At 200 000 characters that is 400 KB moved per chunk, plus the same
 * again as garbage. Measured on 2026-09-09, 3000 chunks of 400 bytes: **168 ms and 9 MB of garbage**
 * against 0.4 ms and none, a factor of 425, rising to 706 on 2 KB chunks. Per chunk it is only about
 * 56 microseconds, so this was never the cause of the freezes that prompted the work; it is
 * unbounded allocation churn on the one thread that must not stop, paid on every byte a dev server
 * prints, and there is no version of the app where that is a good trade.
 *
 * The limit is a **character count and not a chunk count**, deliberately: pty chunks range from one
 * character to several kilobytes, so a chunk-based ring would retain a few kilobytes of a chatty
 * program and megabytes of a quiet one.
 *
 * Trimming keeps whole chunks rather than cutting one in half. The consequence is that the retained
 * text can be a little under the limit rather than exactly on it, which nothing here cares about,
 * and it avoids the one thing that would matter: an ANSI escape sequence cut down the middle, which
 * xterm would then paint as literal `[31m` at the top of a replayed tab.
 */
export class Scrollback {
  private readonly chunks: string[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  /** Appends one chunk of output, dropping the oldest ones once the budget is exceeded. */
  push(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    // `> 1` and not `> 0`: a single chunk longer than the whole budget is kept rather than dropped,
    // since dropping it would leave a tab with no history at all after one long line.
    while (this.size > this.limit && this.chunks.length > 1) {
      // Non-null: the loop condition establishes that at least two chunks are present.
      this.size -= (this.chunks.shift() as string).length;
    }
  }

  /** The retained output, oldest first. Built here rather than kept, which is the point. */
  text(): string {
    return this.chunks.join('');
  }

  /**
   * Forgets everything retained.
   *
   * Used when a tab is cleared, and it has to be: ConPTY keeps its own copy of the screen and
   * reprints it, so clearing one side only puts back what was just removed. A renderer restart would
   * otherwise replay text the user had already cleared.
   */
  clear(): void {
    this.chunks.length = 0;
    this.size = 0;
  }
}
