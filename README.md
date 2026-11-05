# pm/ - to-do list, meeting follow-ups, morning brief

Personal project-management helper next to `tempo/` in a schema-enigma clone. Not part of the plugin: the
schema-enigma repo ignores the folder, and this repo holds only the code, the docs and placeholders - your own list,
settings and briefs stay on your computer (`.gitignore`).

## Set-up

1. From your schema-enigma clone's root folder: `git clone https://github.com/kaneetz/pm-morning-brief.git pm`. It
   uses the clone's `jira-scan/jira-write.js` (the Atlassian token the plugin uses), `studies/<client>/profile.json`
   (client profiles), the trackers named in `config.json` and `mcp-server/src/change-record.js` (go-live dates).
2. Copy `config.example.json` to `config.json` and fill it in: `me`, `meAliases`, `notMe`, your categories (one per
   client, with its Jira project) and the projects whose trackers the worker keeps.
3. `node pm/todo.js` - an empty list the first time; `node pm/todo.js jira --dry-run` checks the Jira read.
4. Morning worker: fill the placeholders in `scheduled-tasks/pm-morning-brief.md` and create the scheduled task from it
   (the comment at its top says how).
5. Optional, the top 5 at every session start: the session-start hook below.

## Session-start hook

Shows the top 5 (and what others owe you that is due) at the start of every Claude Code session in your
schema-enigma clone, and tells Claude to list them at the top of its first reply.

1. Check the output first: `node pm/todo.js top --hook` prints one line of JSON (`systemMessage` for you,
   `additionalContext` for Claude). An error here means the hook will fail too - fix it first (usually a missing
   `config.json`).
2. In the clone's `.claude/settings.local.json` (yours, not committed), add this under `"hooks"` - next to any hooks
   already there, not replacing them:

   ```json
   "SessionStart": [
     { "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/pm/todo.js\" top --hook", "timeout": 15 } ] }
   ]
   ```

   Keep the `$CLAUDE_PROJECT_DIR/` prefix. A relative `node pm/todo.js` fails whenever the session's current folder is
   not the clone root (e.g. after Claude has worked inside `pm/` or `tempo/`), and the hook then shows nothing - no
   error in the chat.
3. So Claude can run `todo.js` in a chat without asking each time, add `"Bash(node pm/todo.js)"` and
   `"Bash(node pm/todo.js:*)"` to `"permissions"` -> `"allow"` in the same file. The hook itself needs no permission.
4. Start a **new** session with the clone root as its folder: settings are read at session start, and the clone's
   `.claude/` settings only apply to sessions opened in the clone root. The list shows as a "To-do" message at the top.

Nothing shows? Run step 1 again, check the settings file is still valid JSON
(`node -e "JSON.parse(require('fs').readFileSync('.claude/settings.local.json','utf8'))"` prints nothing when it is),
and that the session's folder is the clone root, not `pm/` or a parent folder.

## How it connects

Not standalone: it lives in a schema-enigma clone and uses the clone's `jira-scan/` helpers, client profiles and
trackers.

| What | Who does it | How it gets there |
|---|---|---|
| Meetings (the main source) | Claude - the morning worker, or a session | the **Circleback connector** in the Claude app, read tools only (SearchMeetings, ReadMeetings, GetTranscriptsForMeetings, SearchCalendarEvents). Claude writes what it found to `pm/inbox/` and runs `todo.js ingest`; `todo.js` never calls Circleback |
| Jira tickets assigned to me (the backstop) | `node pm/todo.js jira` | the Jira REST API directly, read-only, through `jira-scan/jira-write.js` with your own Atlassian token (the plugin config's `atlassian` block) |
| Scope versions (worker step 3) | Claude | the onboarding app's connector, `scope_list_versions` only |
| The list, trackers, client profiles | `todo.js` | local files only: `pm/todos.json`, the tracker files in `config.json`, `studies/<client>/profile.json` |

The **Atlassian connector** in the Claude app is not used (it shows a card per call). The worker never writes to Jira,
Tempo, Circleback, a tenant or the onboarding app.

## Files

| File | What |
|---|---|
| `todo.js` | the CLI (no dependencies) |
| `config.json` | yours (from `config.example.json`): who "I" am, categories, trackers, time windows, Jira |
| `scheduled-tasks/pm-morning-brief.md` | the morning worker's prompt, as a template |
| `todos.json` | the store (items, processed meetings, worker log) - written by `todo.js` only |
| `TODO.md` | checkbox view, regenerated on every run and read back first |
| `briefs/YYYY-MM-DD.md` | each morning brief |

## Daily use (any terminal, from the repo folder)

```
node pm/todo.js                         top 5: overdue, due today, next 3 working days, high priority
node pm/todo.js list --by category      everything open, per category (or --by priority / due)
node pm/todo.js list --category client-a --owner me
node pm/todo.js add "Send the client the call summary" --category client-a --due mon --kind communicate
node pm/todo.js done 12 14              mark done (drop 12 --why "..." / reopen 12 / snooze 12 +2wd)
node pm/todo.js edit 12 --due 2026-11-05 --priority high
node pm/todo.js jira [--dry-run]        open Jira tickets assigned to me onto the list (read-only Jira)
```

Decisions the worker proposes for a client profile (shown in the brief): `node pm/todo.js decision --client client-a D8
agree` (or `open` / `drop`).

Or in `pm/TODO.md`: tick `[x]` (done) or `[-]` (drop), or write a new line `- [ ] text @fri !high` under a
category heading. The next run of `todo.js` (any command, the worker, the session hook) picks it up.

Due dates: `2026-11-03`, `today`, `tomorrow`, `fri`, `+3d`, `+2wd` (working days). `soft` = a vague date from a
meeting ("next week"), `agreed` = a stated one. Owner `waiting:Name` = someone else's commitment I'm waiting on.

## Morning worker (scheduled task `pm-morning-brief`, weekdays 08:00)

Runs when the Claude app is open; if the app was closed at 08:00 it runs on the next launch. It reads every
Circleback meeting since its last run (after first picking up the open Jira tickets assigned to me, see below) (at least 3 days back, 14 on the first run) - full transcripts, Estonian and
English, written up in English - and:
- adds my action items and "waiting on" items, updates or closes existing ones the transcript settles;
- adds a meeting block to the trackers named in `config.json` (`projects`), and records a newly agreed planned
  go-live date (project status + memory note); never marks a client as live;
- looks at the calendar for today and the next two working days and notes what to prepare;
- writes the brief (`briefs/<date>.md`) and shows it as the run's result.

Input for a command is written to `pm/inbox/` (`--file`), never put on the command line: a command line with JSON always asks for approval. Limits: only `node pm/todo.js ...`, files in `pm/inbox/` and Circleback reads. No Jira, Tempo, e-mail, tenant or onboarding-app writes.
Meetings Circleback did not record are not seen - add those items by hand.

## Jira tickets (`node pm/todo.js jira`, also the worker's first step)

Reads the open tickets assigned to me (`jira` in config.json: JQL, statuses, priorities) - read-only, the Atlassian token
the plugin uses. A ticket not on the list is added as `jira:<KEY>` (an item whose title names the key is linked
instead); "Ready for Demo", "In QA" and other waiting statuses go under waiting on others; a Jira due date already past
is kept in the note only. Later runs close an item whose ticket is done and note a status, due-date or assignee change.
Meetings stay the main source; Jira catches what no meeting mentions.

## In a chat session

The session-start hook (set-up above) prints the top 5 at the start of each session in the clone.

Testing on a copy: put `pm/`, the tracker files and a `work/` copy of `change-review-projects.json` in a scratch
folder, run with `INSLY_WORK_DIR=<scratch>/work PM_NO_MEMORY=1` so no real project status or memory note changes.
