# Rules

A rule watches something the app already knows and acts on it **once, on its own**. Rules do nothing
until **Let rules act on their own** is on (Settings → Rules).

## Triggers

- A followed pull request is approved.
- A followed pull request's checks fail.
- A dev server breaks.
- A Jira issue is assigned to you.
- A time of day, or an interval.

## Actions

- **Notify**: a Windows notification.
- **Agent**: open the agent in a terminal tab with a prompt.
- **Shell**: run a command in a terminal tab. Needs **Let a rule run a shell command** on as well.

The text of an action can use the facts of what triggered it, written `{{name}}`.

## How a rule behaves

- A rule acts once per target: an approved pull request triggers it once, not on every poll.
- A new or edited rule first adopts what is already true without acting on it, so turning one on
  does not fire on everything at once.
- Rules ride the app's existing refreshes; a scheduled rule runs at its minute.
- Every action lands in a terminal tab or a notification, so you can see what ran.
