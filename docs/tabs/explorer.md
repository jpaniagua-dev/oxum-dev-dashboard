# Explorer

The files of each project, one folder at a time, and an editor beside them. Pick a project on the
left; the middle column lists the open folder, folders first.

- **Click** a folder to open it, a file to edit it on the right, in the editor set in Settings →
  General (`micro` unless you change it). The panel widens while a file is open. The path above the
  list goes back to any folder above, and `..` to the one just above.
- **Type** in the field to filter the folder. The same field searches the whole project by file
  name: `app.ts` finds `src/app/app.ts` from anywhere, its folder shown after its name.
- **Go to a line**: type `:42` after the name (`app.ts:42`, or a pasted `src/app/app.ts:42:7`) and
  the file opens at line 42. Inside an open file, `Ctrl+L` in micro asks for a line. A file already
  open is not moved: use `Ctrl+L` there.
- **Keyboard**, from the field: `↑` `↓` move; `Enter` opens a folder or edits a file; `Shift+Enter`
  edits it in a window of its own; `Backspace` in an empty field goes up; `Escape` clears it.
- **Another file** replaces the one being edited, but only once the editor has let go of it: it is
  asked to quit, and if the file has unsaved changes it asks you, in the panel, whether to save them.
  The line above the editor names the file waiting.
- **Pop out** moves the file to a window of its own, the same way. **Close** asks the editor to quit.
  A file already open in a window is brought forward rather than opened twice.
- Quitting the editor empties the panel; if it ends with an error, its output stays.
- **Unsaved changes** show above the editor, in the panel and in a window, whose title also gets a
  `●`. Closing a window or quitting the app asks first only when a file has unsaved changes. This is
  read from micro's status line: another editor, or a customised `statusformatl`, shows no warning
  and is not asked about.
- **Greyed** rows are ignored by git (`node_modules`, `.env`, …) or match an exclusion set in
  Settings → General. They stay reachable, and the search leaves them out.
- `.git` is never listed. A link or junction is marked `link`, and opens only if it stays inside the
  project.
- **Refresh** reads the folder again. Showing the tab does too, so a file created meanwhile appears.

Searching the whole project needs the folder to be a git repository; without one, the field still
filters the open folder.
