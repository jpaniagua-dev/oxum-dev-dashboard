# The terminal

The terminal fills everything below the strip. Drag the separator to resize the strip, or fold it
away (the chevron beside `+ Project`, `Alt+Shift+A`, or a double-click on the tab row) to keep only
terminals. Clicking a tab unfolds it.

New terminal sessions advertise truecolor support, so tools such as Codex can display their full
theme palette. Explicit `FORCE_COLOR` and `NO_COLOR` environment preferences are preserved.
After upgrading, open a new terminal session to use the updated environment; existing sessions
keep the environment they started with.

## Tabs and panes

- **`+`** opens the default shell in that pane; the **caret** beside it lists the other shells.
- **Click a project row** in the Projects tab to open a shell in that repository, or to come back to
  the one already open there.
- **Double-click a tab name** to rename it.
- **Drag a tab** to reorder it, or into another pane. Dragging the last tab out of a pane closes it.
- **Right-click a pane** to split it, or `Alt+Shift+D` for a column and `Alt+Shift+B` for a row. A
  split opens a shell in that pane's folder.
- **Right-click a tab** to move it to its own pane, rename it, close it, or close every tab to its
  right.
- `Alt+Shift+W` closes the active tab; `Ctrl+Alt+W` closes a pane, and its tabs move to the
  neighbouring one.
- **Clear** empties a pane.
- **URLs** printed in a tab open in your browser (`http` and `https` only).
- A running server has no close button: **Stop** it first, from its project row.

## Shortcuts

| Keys | Does |
| --- | --- |
| `Ctrl+N` | start the configured agent |
| `Ctrl+Shift+N` | open a terminal with the default shell |
| `Ctrl+G` | switch between tabs and cards |
| `Ctrl+B` | show or hide the active terminal's note, including the terminal previewed in Cards |

A shortcut the app acts on is not passed on to the program in the terminal. One it has nothing to do
for (`Ctrl+B` with no terminal to show a note for) reaches the program as usual.

### Groups

Gather cards in a **group**: a frame with a name and a colour. **New group** in the canvas toolbar
adds an empty one; right-click a card and pick **Move to a group** to file it, or drag the card onto
a frame. Drag a card out of its frame, or use **Remove from the group**, to take it out. Drag a
frame by its header to move it with its cards; double-click the header to rename it; right-click it
to change its colour or delete it (its cards stay, and nothing is stopped). Agents, dev servers and
watches find their group again after a restart; a shell is grouped until it closes.

## Agents come back after a restart

The coding agents open when you quit (opened with `Ctrl+N`, **Work on this**, or a rule) reopen at
the next launch on their conversation, with their title and note. Nothing runs by itself: each one
waits for your next message. Shells and dev servers do not come back, and neither does an agent you
never wrote to. Turn it off in Settings, Terminal, **Reopen my agents at launch**.

## Cards

Watch and Server sessions have a rerun button on both their card and terminal tab. It stops the
current process, waits for the port to be released, and starts the same configured action again.
The same action is available from the card or tab context menu.

`Ctrl+G` shows the sessions as cards on a canvas instead of tabs: one card per terminal, with what it
is doing. Click a card to open its terminal in a sidebar beside the canvas (four fifths of the width by
default; drag the separator to change it, and the app keeps your choice), with the session's name
at the top left (double-click it to rename) and a close button at the top right once the session can
be closed; double-click a card's title to rename it there too;
drag cards to arrange them; the wheel zooms; the frame button brings every card into view. The canvas
only moves when the card you open or select is not entirely visible: it is then centred in the canvas
space that remains, including when a wide terminal sidebar is open. Clicking a card in view leaves
everything where it is. A note can be written on a session: it shows on its card and at the top right of its
terminal.
