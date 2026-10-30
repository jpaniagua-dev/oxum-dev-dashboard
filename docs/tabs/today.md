# Today

What is waiting for you, as a status dashboard. Each source is switched on or off in **Settings,
Today**, for this machine only: a home computer and a work computer can show different cards.

Three lines, each a chart followed by three numbers. Click a number to open its source; a `…` is
being read, a `?` could not be read.

- **Your day**: today's meetings on an hour axis, with a red line at the current time (hover a
  meeting for its time and subject). Then the unread mails among the newest since yesterday
  morning, the Teams conversations waiting for your reply (somebody else wrote after your last
  message; Teams gives no read state, so this is not "unread"), and since when you are clocked in,
  in green while you are, with the time worked today. Hover it for the time due and the balance.
- **Sprint**: your tickets and the whole sprint's, by stage. Then your tickets of the current sprint
  in progress, to do and done.
- **Pull requests by age**: yours and the ones waiting for your review, each a bar from the day it
  was opened to now, coloured by what it waits for, so the one waiting longest stands out. Click a
  bar to open it in the Pull requests tab. Then the pull requests that need you (your review, or
  changes asked of yours), yours waiting for approval, and yours approved.

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
