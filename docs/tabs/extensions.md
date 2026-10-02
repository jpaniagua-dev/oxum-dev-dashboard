# Extensions

What Claude Code and Codex have installed on this machine, and the changes you can make from here.
Pick an agent and a kind on the left; each row says where it is declared (`user`, `project: web-app`,
`local`, `plugin: …`, `org`, `system`, `claude.ai`), and **also in …** when the same thing is
declared in more than one place.

| Kind | Claude Code | Codex |
| --- | --- | --- |
| Hooks | add, edit, remove | listed (edit `config.toml`) |
| Skills | create, remove | create, remove |
| Plugins | install, enable or disable, uninstall | none |
| MCP servers | add, edit, remove | add, edit, remove, enable or disable |
| Routines | read, pause or resume, run now, change in a terminal | none |

- Every removal asks first. A skill that is a link to another folder is unlinked, never deleted; a
  real folder goes to the Recycle Bin.
- Entries brought by a plugin, synced from claude.ai or bundled with Codex are shown but changed
  where they come from.
- **Check status** runs `claude mcp list`: it shows whether each server answers, and lists the
  claude.ai connectors.
- Values of environment variables and headers are never shown; an edit keeps a value you leave
  empty.
- Changes apply to sessions started afterwards. A plugin change needs the agent restarted.
- If Codex is not on `PATH`, set its full path in Settings → Agent → Advanced.

## Routines

Routines live on claude.ai. **Read from claude.ai** reads them through Claude Code, in a few seconds,
and the list is kept with its date. Each one shows its schedule (in UTC), whether it is active, its
next and last run and the last result. **Pause** / **Resume** and **Run now** ask first; **Change in a
terminal** and **New routine** open Claude Code on `/schedule`. A routine is deleted on claude.ai.
A routine's prompt is never shown or stored.
