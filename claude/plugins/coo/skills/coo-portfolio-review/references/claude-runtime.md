# Claude runtime

How the review's mechanics map onto Claude's surfaces. The procedure in SKILL.md is authoritative; this file supplies commands and templates.

## Contents

1. Surfaces and paths
2. Run lock commands
3. Releasing the lock, and the no-delete fallback
4. Recovering a lock
5. Project access
6. Subagent brief
7. Decision questions
8. Optional durable view
9. Scheduling stance

## 1. Surfaces and paths

| Surface | COO workspace | Projects | Shell used for workspace and lock |
| --- | --- | --- | --- |
| Cowork desktop | `coo/` in the connected folder of the invoking project | connected folders | the device shell; connected folders appear under `$HOME/mnt/<folder-name>` |
| Claude Code (local) | `coo/` at the repo root (or working directory) of the invoking project | local repos or directories | the local shell |
| Cloud session with only a checked-out repo | not durable | the checked-out repo | read-only review; say no state was persisted |

Rules that follow from this:

- Use exactly one shell for every workspace read, lock operation, and write in a run. In Cowork, the cloud container cannot see connected folders; do not stage workspace files into it to edit them.
- Each device-shell call is a fresh process: nothing (variables, working directory) carries between calls. Keep the owner token and run ID in your own working notes and pass them explicitly in every command that needs them.
- Record paths in `CONFIG.md` as the user's own paths. Resolve them to the shell's view at run time from the list of connected folders.
- Get timestamps from the same shell (`date +%FT%T%z`) so "evidence current through" carries the correct timezone.
- Check `command -v git` before relying on Git in that shell. Without Git, use content fingerprints (`sha256sum` or `shasum -a 256`, whichever exists).

## 2. Run lock commands

Set `W` to the workspace path as the shell sees it: in Claude Code `W="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/coo"`; in Cowork `W="$HOME/mnt/<invoking-project-folder>/coo"`. Confirm the workspace exists first so a missing folder is not mistaken for a held lock.

```sh
W="$HOME/mnt/<folder-name>/coo"
test -d "$W/reviews" || { echo "NO_WORKSPACE"; exit 2; }
if mkdir "$W/.run-lock" 2>/dev/null; then
  echo ACQUIRED
else
  echo HELD
  cat "$W/.run-lock/owner.json" 2>/dev/null || echo "owner.json absent or unreadable"
fi
```

Never substitute `mkdir -p`: it succeeds when the directory already exists, which would make two coordinators both believe they hold the lock.

Immediately after `ACQUIRED`, in the next call, allocate the run ID, reserve it with a stub review, and write the owner metadata:

```sh
W="$HOME/mnt/<folder-name>/coo"; SESSION="<session identifier or unknown>"
d=$(date +%F); n=1
while [ -e "$W/reviews/$d-$(printf %02d $n).md" ]; do n=$((n+1)); done
RUN="$d-$(printf %02d $n)"
TOK=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
printf '{"owner_token":"%s","run_id":"%s","session":"%s","host":"%s","acquired_at":"%s"}\n' \
  "$TOK" "$RUN" "$SESSION" "$(hostname)" "$(date -u +%FT%TZ)" > "$W/.run-lock/owner.json" \
  && printf '# COO review — %s\n\nRun ID: %s\nStatus: in progress\n' "$d" "$RUN" > "$W/reviews/$RUN.md" \
  && echo "RUN=$RUN TOK=$TOK" || echo "OWNER_WRITE_FAILED"
```

On `OWNER_WRITE_FAILED`, release your own lock (section 3) and abort the run. Record `RUN` and `TOK`.

For a resumed run, reacquire with the same `mkdir`, then write `owner.json` with a new token and the original run ID; do not allocate a new review file.

In the host field, record what the shell reports. In Cowork this is the workspace VM, not necessarily the Mac's name; that is expected.

## 3. Releasing the lock, and the no-delete fallback

Always verify ownership first, then remove only your own metadata and the empty directory:

```sh
W="$HOME/mnt/<folder-name>/coo"; TOK="<your token>"; RUN="<run id>"
grep -q "\"owner_token\":\"$TOK\"" "$W/.run-lock/owner.json" 2>/dev/null || { echo "NOT_OWNER"; exit 1; }
if rm "$W/.run-lock/owner.json" 2>/dev/null && rmdir "$W/.run-lock" 2>/dev/null; then
  echo RELEASED
else
  mkdir -p "$W/.released-locks" && mv "$W/.run-lock" "$W/.released-locks/$RUN-$(date -u +%Y%m%dT%H%M%SZ)" && echo RELEASED_BY_RENAME
fi
```

- `NOT_OWNER`: do not touch the lock. Report it; someone else's run now holds it.
- Cowork does not permit deleting files in connected folders by default. The rename fallback frees the lock path atomically (a same-folder rename) without deleting anything and without asking for a delete grant, which would cover the whole connected folder and is broader than this needs. If the `rm` of `owner.json` succeeded but `rmdir` did not, the rename still moves the empty directory.
- Never use `rm -r` or `rm -rf` on the lock. Mention in review diagnostics when the fallback was used; the user may clear `.released-locks/` whenever they like.

Release on completion, on any error after acquisition, and before every pause for user input.

## 4. Recovering a lock

When `mkdir` reports `HELD`:

1. Stop. Do not read the mutable baseline, allocate IDs, write COO files, or write Linear.
2. Report the owner metadata exactly as recorded (or that it is absent or unreadable).
3. If the recorded owner is this same session and you still hold its token (for example an earlier step of this run failed before release), release it normally.
4. Otherwise recover only with verified termination or the user's explicit direction. Asking is appropriate here because the run is genuinely blocked: state who holds the lock and since when, and offer "the owning run has stopped, recover the lock" versus "leave it and stop this review". Age alone does not justify recovery.
5. To recover: rename the old lock to `.released-locks/recovered-<old-run>-<timestamp>` (same command pattern as the fallback), then acquire fresh with `mkdir`. Record the recovery and the user's direction in the review diagnostics.

## 5. Project access

- A configured project whose folder is not currently connected: ask once, in a single request covering only the configured projects that are missing, for access to those folders. If the user declines or does not answer, mark those projects `not refreshed (folder not connected)` and continue. Never request folders outside `CONFIG.md` scope.
- Project folders are read-only for this workflow. The only writes go to `coo/` inside the invoking project.
- Honor `CLAUDE.md` or `AGENTS.md` in a project as project instructions for how to read it (for example which files are authoritative for plans).

## 6. Subagent brief

Use the Agent tool for at most two substantial, independent, changed projects at a time (initially). Keep small or unchanged projects in the coordinator. If a subagent cannot reach the project folder from its environment, do that inspection locally instead.

Brief template:

```text
You are inspecting one project for a COO portfolio review. Read-only.

Project: <name>   Location (as your shell sees it): <path or repo>
Previous state: <the project's CURRENT.md section and STATE.json entry>
Detected changes since last inspection: <freshness-pass result>
Evidence locations: <from CONFIG.md>
Project instructions: honor CLAUDE.md / AGENTS.md if present.
Drift lens: consider code, architecture, test, dependency, documentation and infrastructure health;
report only what can affect delivery, reliability, priority or future understanding.

Do not: rank other projects or the portfolio; edit any file; touch coo/ or its lock; write to Linear
or any external system; commit, push, install, deploy, or run state-changing commands.
Do not run broad test suites; run a targeted, safe check only if it resolves a material state question.

Return exactly these sections:
1. Observed state and sources (label each item: verified observation, documented intent,
   inferred state, reported constraint, or unknown)
2. Meaningful drift
3. Blockers and dependencies
4. Candidate next actions (outcomes, not activities)
5. Completed work and possible knowledge candidates
6. Evidence limitations and freshness (what you could not check and why)
Include any Linear or other stable identifiers you encounter; do not look up or change Linear.
```

The coordinator reconciles contradictions between returns and prior state before prioritizing, and alone writes every shared output.

## 7. Decision questions

After the review, pending decision records, run ID and status-update IDs are persisted and the lock is released, you may ask the final consequential choices with the AskUserQuestion tool:

- one question per decision ID, headed with the ID and short title;
- options are the record's real alternatives, plus defer only when deferral is a genuine choice (its revisit condition stays on the record);
- the recommendation is identified as the recommendation, not preselected as a default;
- if more decisions are open than fit comfortably, ask the most consequential and list the rest by ID in the message.

A free-text answer counts as a decision only if it clearly selects an outcome; otherwise the record stays proposed. After answers arrive: reacquire the lock with the same run ID, reload state, update each decided record with a dated history entry (source: "answered in conversation on DATE"), re-read the affected Linear records, then apply and verify the dependent Linear changes.

Do not use the question tool for routine confirmations, for Linear changes already authorized, or while holding the lock.

## 8. Optional durable view

If, and only if, the user asks for a shareable or persistent view, publish the completed review as a private Artifact (a readable page of the review) or as a Claude Docs document. Build it from the saved review file, keep the decision IDs and Linear IDs, and exclude secrets, full logs and private calendar details. The workspace review file stays authoritative; say so on the page. Do not re-publish automatically on later runs unless the user asks.

## 9. Scheduling stance

This workflow is on demand. Claude can create scheduled tasks and delayed self-reminders; this skill never does, never proposes one, and does not list personal follow-up or reminder suggestions. If a run is started by a scheduled task, stop before acquiring the lock and report that the workflow is on-demand by design. Unattended runs would also break the design: nobody is present to answer the decision panel, recover a lock, or grant folder access.
