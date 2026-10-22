# Today

What is waiting for you, as a status dashboard. Each source is switched on or off in **Settings,
Today**, for this machine only: a home computer and a work computer can show different cards.

The tab fits the strip without scrolling. From top to bottom:

- **Your day** and three numbers, on one line: today's meetings on an hour axis, with a red line
  at the current time (hover a meeting for its time and subject), then pull requests that need
  you, tickets in progress, and since when you are clocked in (green while you are). Click a number
  to open its source: the Pull requests or Tickets tab, or Tipee. A `…` is being read; a `?` could
  not be read. Hover the time tracking number for the time due and the balance.
- **Panels**, sharing the rest of the height, each scrolling on its own:
  - **Pull requests**: **To review** (waiting for your review) and **Mine, waiting** (yours waiting
    for a review from somebody else; not drafts, not those approved or with changes requested).
  - **Tickets**: the sprint by stage, then your open tickets, the ones in progress first.
  - **Unread mail**: the unread mails among the newest since yesterday morning, with the start of
    each one.
  - **Teams, waiting for your reply**: the conversations where somebody else wrote after your last
    message, with what they wrote. Teams gives no read state, so this is "waiting for your reply",
    not "unread".

A click on a row opens it: a pull request or a ticket in its tab, a mail in Outlook, a conversation
in Teams.

Pull requests and tickets cost nothing: they show what the Pull requests and Tickets tabs already
read.

## Calendar, Mail and Teams

These three are read through **Claude Code** and its **claude.ai Microsoft 365 connector**, in one
run of a few seconds, read only. You need:

- Claude Code installed and signed in with a claude.ai account;
- the Microsoft 365 connector connected for that account (on claude.ai, Settings, Connectors).

The run happens the first time you open the tab each day, and when you press **Refresh**. Its
answer is kept, so the cards are filled at the next launch; an answer from an earlier day says so.
**Test Microsoft 365** in the settings checks the connector and says as whom it answers.

## Time tracking

Fill in the Tipee address (`https://example.tipee.net`), your username and your password in
**Settings, Today**, then press **Test**. The password is encrypted for your Windows account. The
card is read again every five minutes and when you press **Refresh**.

## Refresh

**Refresh**, at the top right, reads every card that is switched on again, the Microsoft 365 ones
included.
