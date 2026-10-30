# Vault

Somewhere to keep API keys and other secrets so they do not end up in a committed `.env` file or
pasted into a chat.

- **One card per file.** Choose the project, the file's path (such as `.env.local`) and how long a
  generated file stays on disk (30 minutes by default), then add secrets as **Name** / **Secret**
  rows. The **text** below them holds plain lines such as `EMAIL=me@example.com`, written into the
  file as they are.
- Secrets are encrypted for your Windows account and never shown unless you reveal one on purpose; a
  revealed value is hidden again after 20 seconds and when the window loses focus. The text is
  stored with them but shown in clear: keep secrets in the rows.
- **Edit** a card to change anything, values included: an existing secret's field starts empty and
  keeps its value unless you type a new one.
- **Generate file** writes the file into the project. The path must be ignored by git first. The
  file is removed when its time is up; the vault keeps the values, so the next **Generate file**
  brings it back.
- **Remove file** deletes the generated file from the project and the card from the vault, secrets
  and text included, after a confirmation.
- A generated file is plain text by design: while it is on disk, every process of that project can
  read it, coding agents included.

**How it works** in the tab says the same in three lines.
