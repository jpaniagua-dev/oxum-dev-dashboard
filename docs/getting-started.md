# Getting started

## Install

1. Download the installer, `oxum-dev-dashboard-<version>-win-x64-setup.exe`, from the
   **[latest release](https://github.com/jpaniagua-dev/oxum-dev-dashboard/releases/latest)**. Its
   name carries the version it installs.
2. Run it. The build is not code-signed, so Windows SmartScreen stops it the first time with
   **"Windows protected your PC"**: click **More info**, then **Run anyway**.
3. The installer is per-user and needs no administrator rights. It adds a shortcut to the Start
   menu and to the desktop.

Take the installer rather than the zip: the Start menu shortcut it installs is what Windows needs to
deliver the app's notifications. The zip runs the same app, without them.

## Uninstall

From **Uninstall Oxum Dev Dashboard** in the Start menu, from **Settings → Apps → Installed apps**, or
by running `Uninstall Oxum Dev Dashboard.exe` in the install folder
(`%LOCALAPPDATA%\Programs\Oxum Dev Dashboard`). It asks whether to delete your settings and data too
(`%APPDATA%\oxum-dev-dashboard`); the answer is No unless you choose otherwise, so a reinstall finds
them. An update never deletes them. The Start menu entry exists from 10.1.0 on; an older install has
the other two.

## What the machine needs

The app runs the tools you already have. A missing one disables what uses it, and says so where it
runs; nothing is fatal.

| Tool | Used for | Without it |
| --- | --- | --- |
| **git** on `PATH` | the Projects columns, the Git and Worktrees tabs | rows read `?` |
| **`gh`**, signed in with `gh auth login` | checks, workflows, the Pull requests tab | those columns read `?`, the tab stays empty |
| **Claude Code**, signed in | Triage, Work on this, commit messages, reviews, Extensions | the run says what failed and names the command |
| **Git Bash** (optional) | actions and shells that need bash | those print `command not found` in their tab |
| **A Jira API token** (optional) | Jira issues in Tickets, the Triage tab | Tickets shows your local tickets only |

A Jira API token is created at <https://id.atlassian.com/manage-profile/security/api-tokens>.

## First launch

A fresh install watches nothing. Open the settings with the gear at the top right:

1. **Projects**: set **Repositories folder** to the folder holding your clones, press **Detect
   repositories**, and add the ones you work on. `+ Project` in the main window adds one folder at a
   time.
2. **Agent**: the default runs Claude Code. Press **Test** to check that it answers.
3. **Tickets** (optional): your Jira site, email, project keys and API token, then **Test**.
4. **Save**.

## A team configuration

Somebody who already set the app up can hand you a starting point: **General → Export team
configuration** writes a file holding the projects (as paths under the home folder), their
actions and tags, the Jira site and project keys, the agent and its models. Never a token, an email
or anything personal.

**General → Import** reads such a file. It adds the projects whose folder exists on your machine,
lists the ones it could not find, keeps the projects you already have, and takes the team's agent
and Jira site after showing you all of it. Your Jira email and token stay yours: fill them in on the
Tickets page afterwards.

## Updates

When a newer version is out, a **Version X is available** button appears at the top right of the
window. It downloads the installer: close the app and run it, it updates in place and keeps your
settings. The check runs at launch and every six hours, and can be turned off in **General**.
