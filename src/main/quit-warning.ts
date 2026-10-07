/**
 * What quitting would cost, as the confirmation states it, or null when nothing is worth asking about.
 *
 * Dev servers because a build killed silently is not expected; files with unsaved changes in an editor,
 * read off its status line, because they would be lost. An editor holding nothing unsaved is not
 * counted: a question on every quit after opening a file was one nobody read. A shell tab dying with
 * the app is expected, and is not counted either. Pure, so the wording of every combination is tested
 * rather than read off a dialog.
 */
export function quitWarning(
  servers: number,
  unsaved: number,
): { message: string; detail: string } | null {
  if (servers === 0 && unsaved === 0) {
    return null;
  }
  const parts: string[] = [];
  if (servers > 0) {
    parts.push(
      servers === 1
        ? '1 server started by the dashboard will be stopped'
        : `${servers} servers started by the dashboard will be stopped`,
    );
  }
  if (unsaved > 0) {
    parts.push(unsaved === 1 ? '1 file has unsaved changes' : `${unsaved} files have unsaved changes`);
  }
  const details: string[] = [];
  if (servers > 0) {
    details.push('Servers started from an external terminal are not affected.');
  }
  if (unsaved > 0) {
    details.push('Quitting now loses those changes.');
  }
  return {
    message: `${parts.join(', and ')}.`,
    detail: details.join(' '),
  };
}
