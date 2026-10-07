# Settings

The gear at the top right opens the settings window. The rail on the left picks a page and says what
each one is set to; a dot marks a page with unsaved changes. One **Save** at the bottom saves every
page at once, and closing with unsaved changes asks first.

Each page shows what most people set. The rest is folded under **Advanced**.

## General

- **Font size**: the size of the app's text, 11 to 17 px. Everything else in the interface scales
  with it. The terminal has its own size, on the Terminal page.
- **Theme**: follow Windows, light or dark. Applied at once.
- **Tell me when a new version is out**: the update notice, on by default.
- **Export team configuration… / Import…**: see [Getting started](getting-started.md#a-team-configuration).
  Import is refused while the form has unsaved changes.
- **Explorer**, for the [Explorer tab](tabs/explorer.md):
  - **Editor program**: the terminal editor a file opens in, beside the list or in a window of its
    own. `micro` by default; a name found on `PATH`, or a full path. Another file replaces the open
    one by asking the editor to quit with `Ctrl+Q`, micro's key.
  - **Excluded files**: one pattern per line, greyed in the list and left out of the search. A name
    matches at any depth (`node_modules`, `*.lock`); a pattern with a `/` starts at the project
    root (`docs/generated`); `**` crosses folders. Blank lines and lines starting with `#` are
    dropped.

## Projects

- **Repositories folder** and **Detect repositories**: Detect lists the git repositories directly
  inside that folder and offers to add them.
- **+ Add a folder** adds one repository.
- One card per project, folded to its name and folder; **Details…** opens it:
  - **Type**: server (has a dev server) or watch (a library built with `--watch`). Inferred from
    `package.json` when left as is.
  - **Follow pull requests**: include this repository in the Pull requests tab.
  - **Tags**: free labels to group the table; their colours are below the list.
  - **Actions**: the buttons of the project's row. See [Projects](tabs/projects.md#actions).
- **Group by tag** reorders the list so projects of one tag sit together.

Advanced:

- **Worktrees folder**: where the Worktrees tab creates worktrees. Empty means a `worktrees` folder
  next to each repository.
- **Worktree helper**: a shell function that creates and removes worktrees in a terminal tab instead
  of the app. Leave it empty unless you have one.

## Terminal

- **Default profile**: the shell new tabs open in.
- **Font size**: 9 to 28 px, applied to every tab.

Advanced: one card per shell (name, program, arguments, starting folder). Shells installed on the
machine are detected; a path you edit is kept over the detected one. **+ Shell** adds one.

## Agent

**Which agent**

- **Claude Code** runs the `claude` installed on the machine, with nothing else to fill in.
  **Another command-line agent** opens Advanced, where you describe how to start it.
- **Test** runs the agent once on a one-word prompt and reports what came back, and checks that the
  program of the command for terminal sessions exists.

The page says so when sessions opened from a ticket skip the agent's permission prompts.

**Model for each task**: one model per task, empty for the agent's own default. With Claude Code,
`fable`, `opus`, `sonnet` and `haiku` sit under each field: a click fills it, a second click empties
it. A full model name can be typed too. Another agent's field takes the names its documentation gives.

- **Sprint triage** reads every ticket of a sprint: a fast model keeps it cheap.
- **Working on a ticket** implements it in a terminal tab (**Work on this**): the run that writes code.
- **Commit messages** writes a message from the staged changes (**Generate**).
- **Pull request reviews** checks a patch against your standards.

Advanced, in three groups:

- **How the app starts the agent**: the **command for background runs** (answers and exits: triage,
  commit messages, reviews) and the **command for terminal sessions** (opens a session in a tab).
  They are templates, not shell lines: `{model}` becomes the **model option**. **Plan mode
  arguments** follow the program when a session starts in plan mode, such as **Work on this in plan
  mode**; for Claude Code, `{model} --permission-mode plan --allow-dangerously-skip-permissions`, and
  empty means the agent has no plan mode. **Extra folder option** lets the review read your
  standards beside the repository. **How the prompt is sent** and **Answer format** say how the
  background command is fed and read. Press Test after any change.
- **Other programs**: the **Claude Code program** and the **Codex program** the Extensions tab runs. A
  full path reaches one that is not on `PATH`.
- **Handing over a ticket**: the **starting folder** of sessions, so they read the instructions
  several repositories share (empty starts in the repository), and the skills (**Skill for Work on
  this**, **Skill for unattended runs**, **Skill for review feedback**): a slash command such as
  `/ticket` to hand work to instead of the app's own prompt.

## Tickets

- **Site**, **Account email**, **Project keys**, **API token**: the Jira connection. The token is
  encrypted for your Windows account, stored apart from the settings, and never shown again; to
  change it, type a new one.
- **Test** checks the connection typed on screen, before saving.
- **Local tickets folder**: where local tickets are kept, one Markdown file each. Empty means the
  app's own folder.

## GitHub review

- **Let the review submit to GitHub**: off by default. Off, the review runs and posts nothing; on, it
  submits reviews **as you** through `gh`.
- **Let an agent treat pull request feedback on its own**: off by default.

Advanced: **Automated reviewer login**, the bot whose remarks the review weighs.

## Rules

- **Let rules act on their own**: off by default. See [Rules](tabs/rules.md).
- **Let a rule run a shell command**: off by default, and only available with the first switch on.

## Where settings live

`%APPDATA%\oxum-dev-dashboard\settings.json`. Secrets are in separate encrypted files beside it
(`jira-token.bin`, `vault.bin`) and cannot be copied to another Windows account.
