# Tickets

Jira issues and local tickets together, as a **List** (the default) or a **Board** of columns.

- **Views**: **Sprint** (the open sprints of your Jira projects) and **My issues** (what they hold
  and is assigned to you). Local tickets appear in both. Without Jira configured, the tab shows the
  local tickets alone.
- A badge says where each ticket lives: **Jira** or **Local**.
- **Click** a ticket to open it: its Jira page, or its file for a local one.
- **Right-click** for its actions. On the board, **drag** a card to another column to move it.
- The assignee filter narrows the sprint view; it is reset when the view changes.

## Jira tickets

Right-click to **work on it**, **assign it to yourself**, **create a branch** for it (named
`PROJ-123-<summary>`, in the project you pick), **move it** to another status, open it in the browser,
or **copy** its ID, its title, or both (`PROJ-123 - Fix the login timeout`). The moves offered are the
ones the workflow allows from the current status, read when the menu opens. Writes go straight to
Jira.

**Work on this...** asks for the project, then starts the agent on the ticket in a terminal tab,
exactly as the Triage tab does: the same skill (Settings → Agent → **Skill for Work on this**, such
as `/ticket`), the same tab for the same ticket, and the same Jira writes afterwards (active sprint,
assigned to you, in progress).

## Local tickets

A local ticket is a Markdown file, `LOC-12-<title>.md`, in the local tickets folder (Settings →
Tickets). **New ticket** creates one: a title, a type, a column and an optional description.

Right-click to create a branch, move it to another column, **edit the ticket file** (title, type and
description are in it), show it in its folder, copy its ID, its title or both, or delete it (to the
Recycle Bin). **Work on this...** is greyed: the skill it hands over to reads Jira, which does not know
a local ticket.

The file can be edited by hand or by an agent. What the tab reads is its header:

```markdown
---
key: LOC-12
summary: Fix the login timeout
type: Bug
stage: in-progress
status: In progress
created: 2026-10-02T09:00:00.000Z
updated: 2026-10-02T10:00:00.000Z
---

The session expires after 5 minutes instead of 30.
```

`stage` is `todo`, `in-progress` or `done`. A file without a valid `key`, or with a key another file
already uses, is listed as a problem rather than shown. Rules and Triage do not read local tickets.
