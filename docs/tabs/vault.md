# Vault

Somewhere to keep API keys and other secrets so they do not end up in a committed `.env` file or
pasted into a chat.

- **One card per file.** Choose the project, the file's path (such as `.env.local`) and how long a
  generated file stays on disk (30 minutes by default), then type the file's content, such as
  `API_KEY=value`. It is written into the file as it is.
- The content is encrypted for your Windows account, but the card shows it as typed: anyone who
  sees your screen while the Vault tab is open can read it.
- A card created before this layout may also hold **secrets**, listed apart and masked. One is shown
  only when you reveal it on purpose, and hidden again after 20 seconds and when the window loses
  focus. **Edit** keeps them: an existing secret's field starts empty and keeps its value unless you
  type a new one, and you can remove it there.
- **Edit** a card to change anything else: its project, its path, its lifetime or its content.
- **Generate file** writes the file into the project. The path must be ignored by git first. The
  file is removed when its time is up; the vault keeps the values, so the next **Generate file**
  brings it back.
- **Remove file** deletes the generated file from the project and the card from the vault, secrets
  and text included, after a confirmation.
- A generated file is plain text by design: while it is on disk, every process of that project can
  read it, coding agents included.

**How it works** in the tab says the same in three lines.
