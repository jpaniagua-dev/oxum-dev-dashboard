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

Right-click to **assign it to yourself**, **create a branch** for it (named `PROJ-123-<summary>`, in
the project you pick), **move it** to another status, or open it in the browser. The moves offered are
the ones the workflow allows from the current status, read when the menu opens. Writes go straight to
Jira.

## Local tickets

A local ticket is a Markdown file, `LOC-12-<title>.md`, in the local tickets folder (Settings →
Tickets). **New ticket** creates one: a title, a type, a column and an optional description.

Right-click to create a branch, move it to another column, **edit the ticket file** (title, type and
description are in it), show it in its folder, or delete it (to the Recycle Bin).

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
