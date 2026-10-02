# Agents

The coding agent sessions running in the terminal, newest first, and what each one was given.

- **Left**: each session, with what it is doing (working, quiet, exited), the ticket or pull request
  it was opened for, its repository and its model. Click one to show its terminal.
- **Right**, for the selected session: the agent, the model and the folder it started in, recorded
  when it started; the instruction files it reads on the way down the folder tree; and, for Claude
  Code, the memory it has for that folder.

Memory is kept per starting folder: a session started in a repository does not see what was
remembered for the workspace above it. This tab is where that shows.
