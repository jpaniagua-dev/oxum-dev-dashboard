# The terminal

The terminal fills everything below the strip. Drag the separator to resize the strip, or fold it
away (the chevron beside `+ Project`, `Alt+Shift+A`, or a double-click on the tab row) to keep only
terminals. Clicking a tab unfolds it.

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

## Cards

`Ctrl+G` shows the sessions as cards on a canvas instead of tabs: one card per terminal, with what it
is doing. Click a card to open its terminal in a sidebar beside the canvas, with the session's name
at the top left (double-click it to rename); double-click a card's title to rename it there too;
drag cards to arrange them; the wheel zooms; the frame button brings every card into view. A note can be written on a
session: it shows on its card and at the top right of its terminal.

## The servers window

The rack icon next to the gear moves the dev servers into a window of their own, for a second
monitor. Each server is a tile whose border takes its state (serving, build failed, crashed). The
processes keep running and keep their output; closing the window hands them back. Right-click a tab
for **Move to the servers window**, for a server started by hand.
