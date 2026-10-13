# Rules

A rule watches something the app already knows and acts on it **once, on its own**. Rules do nothing
until **Let rules act on their own** is on (Settings → Rules).

## Triggers

- A followed pull request is approved.
- A followed pull request's checks fail.
- A dev server breaks.
- A Jira issue is assigned to you.
- A time of day, or an interval, on every day or only on the days you pick (Mon to Sun).

## Actions

- **Notify**: a Windows notification.
- **Agent**: open the agent in a terminal tab with a prompt.
- **Shell**: run a command in a terminal tab. Needs **Let a rule run a shell command** on as well.
- **Run a skill**: open the agent in a terminal tab running one of your installed skills, picked from
  a list, with its arguments in the text. Same tab and starting folder as **Agent**, so the skill has
  the same context as a session you open yourself. A scheduled rule with this action runs a skill at
  a given time, for example `/test-dev` every weekday morning.

The text of an action can use the facts of what triggered it, written `{{name}}`.

## Reading a rule

Each rule is a card. Its head holds the switch, the name and a pill that says whether the rule will
act:

- **Off**: switched off. A rule needs a name before it can be switched on.
- **Arming**: switched on, and its first check is still to come (see below).
- **On**: it acts the next time its trigger happens.
- **Never runs**: a scheduled rule with neither a time nor an interval.
- **Will refuse**: it will fire and be refused, because it runs a command while **Let a rule run a
  shell command** is off, or runs a skill without naming one.

The pill's tooltip says what to change. The bar above the cards counts the rules and how many are on.

## How a rule behaves

- A rule acts once per target: an approved pull request triggers it once, not on every poll.
- A new or edited rule first adopts what is already true without acting on it, so turning one on
  does not fire on everything at once.
- Rules ride the app's existing refreshes; a scheduled rule runs at its minute.
- Every action lands in a terminal tab or a notification, so you can see what ran.
