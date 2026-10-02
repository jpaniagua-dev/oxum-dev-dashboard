# Vault

Somewhere to keep API keys and other secrets so they do not end up in a committed `.env` file or
pasted into a chat.

- Values are encrypted for your Windows account and never shown unless you reveal one on purpose; a
  revealed value is hidden again after 20 seconds and when the window loses focus.
- Secrets are grouped by the file they belong to: a project and a path such as `.env.local`.
  **Generate file** writes that file from its secrets, and **Remove file** deletes it. The path must
  be ignored by git before the app writes it.
- A generated file is plain text by design: it protects nothing from the processes of that project.

## Agents and secrets

A coding agent running in a project's terminal never receives a value. It can ask the app to perform
one HTTP request with a secret attached, to an origin and paths the secret was configured for. Each
request is shown to you in a dialog naming the project, the secret and the full URL, and only runs if
you approve it. The answer comes back with the secret removed.

**How it works** in the tab explains the details.
