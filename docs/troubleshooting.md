# Troubleshooting

| Symptom | Cause | What to do |
| --- | --- | --- |
| "Windows protected your PC" when installing | the build is not code-signed | **More info**, then **Run anyway**. If there is no such button, your IT policy blocks unsigned programs: ask IT. |
| No notifications | the app was started from the zip | install with the setup.exe: notifications need its Start menu shortcut |
| Detect repositories finds nothing | the Repositories folder is empty or wrong | Settings → Projects: choose the folder that directly contains your clones |
| Every column reads `?` | git is not on `PATH` | install Git for Windows, then restart the app |
| Checks and Pull requests read `?` or stay empty | `gh` is missing or not signed in | run `gh auth login` in a terminal tab |
| An agent run says "was not found" | Claude Code is not on `PATH` | install it and sign in, or set its full path in Settings → Agent → Advanced |
| An agent run says a folder does not exist | the agent workspace or repositories folder points nowhere | fix it in Settings → Agent → Advanced or Settings → Projects |
| Agent Test fails | the command or its flags are wrong | the message shows the command that ran; reset the page to **Claude Code (as installed)** |
| Tickets shows only local tickets | Jira is not configured or the token is missing | Settings → Tickets: site, email, keys and token, then **Test** |
| Jira Test fails | wrong site, email, token or project key | the message is Jira's own; check each field |
| A server row stays `stopped` while it runs | it was started outside the app | stop it there and start it from the row |
| Starting a server fails on "address already in use" | another process holds the port | stop that process, or let **Run** restart the one the app owns |
| Removing a worktree says the folder is locked | an editor, a terminal or a dev server holds it | close it, then remove again |
| Extensions shows nothing for Codex | Codex is not on `PATH` | set its full path in Settings → Agent → Advanced |
| No "new version" button though one is out | the check is off, or GitHub was unreachable | Settings → General; the check runs again every six hours |
| A local ticket does not appear | its file has no valid `key`, or another file uses it | the tab lists the file as a problem; fix its header |

Settings are in `%APPDATA%\oxum-dev-dashboard\settings.json`. Keep a copy before editing it by hand:
an invalid value is replaced by its default when the app reads it.
