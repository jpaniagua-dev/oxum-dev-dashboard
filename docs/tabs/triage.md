# Triage

Pick a sprint, press play, and a read-only agent run classifies every ticket in it. It takes minutes,
and the bar shows what the agent is reading while it works.

## Verdicts

| Tab | Means |
| --- | --- |
| **Ready** | can be started today |
| **Decision** | a question has to be answered first |
| **Unclear** | the description is too thin to act on |
| **Blocked** | waiting on something outside the ticket |

Each ticket also carries chips: its side of the stack (**Front-end**, **Backend**, **Full-stack**),
and **100% agent** when an agent can take it to an open pull request on its own. Every ticket gets an
estimate in story points. The third column explains the verdict: why, the question to answer, and
what answering it triggers.

- Two run buttons: the whole sprint, or only the tickets not analysed yet.
- The last result stays until the next run, and a failed run keeps it.
- Tickets already done are left out.

## Handing a ticket over

- **Work on this** asks which repository the ticket is in, then opens the agent in a terminal tab on
  it. **Work N ready** does the same for every ready ticket.
- **Run N autonomously** hands the tickets marked **100% agent** to agents that go all the way to a
  pull request without stopping for you. A reviewer still reads the pull request.
- The handoff also records it on the board: the ticket is moved to the active sprint, assigned to
  you, given its estimate and moved to in progress. Each button says so before you press it.
- The session starts in the agent workspace folder when one is set (Settings → Agent → Advanced), and
  is told which repository the ticket is about. It runs without the agent's permission prompts.
- Without a skill configured, the agent gets the app's own instructions and reads the triage notes
  from the analysis file. A team with its own skill sets it under Settings → Agent → Advanced.

Needs Claude Code and the Jira connection.
