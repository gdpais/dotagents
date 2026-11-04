---
name: coo-portfolio-review
description: On-demand COO / portfolio operations review across the user's configured projects - refreshes project state from current evidence, flags material drift, selects up to three cross-project priorities, keeps a decision panel with stable IDs, and synchronizes the supported changes to Linear (Linear connector needed for writes). Use when the user asks for a COO review, portfolio or operations review, project-state refresh, or cross-project priorities. Do not use for a single-project tech-debt audit, a daily standup, or writing an ADR, and never run it from, or set it up as, a scheduled task.
---

# COO Portfolio Review

Produce a concise, evidence-backed operating view across the user's selected projects. Project files remain authoritative for implementation, plans, and technical state. The review owns the current portfolio interpretation, cross-project priorities, decisions requiring the user's judgment, and synchronization of execution state to Linear.

Requirements: write access to the project the review is invoked from, which holds the COO workspace (a connected folder in Cowork, or the working repo/directory in Claude Code); read access to the configured project folders or repos; a Linear connector with read and write access for synchronization. Without Linear, the review still runs and records a change plan instead of applying it.

## On demand only

Run only when the user asks in this conversation. Do not create, modify, or suggest creating a Claude scheduled task, recurring task, cron job, or delayed self-reminder as part of this skill. If this session was started by a scheduled task firing rather than by the user, do not acquire the lock or write anything: report that this workflow is on-demand by design and stop. If the user asks to put it on a schedule, explain that this skill is on-demand by design and that changing that is a change to the skill itself, which needs their explicit permission for that specific change.

## Where things run

The lock commands below are all a normal run needs. Read [Claude runtime](references/claude-runtime.md) only for Cowork device-shell details, a held or abandoned lock, the release fallback, subagent briefs, or asking decision questions.

- **COO workspace** (`coo/`): lives at the root of the project the review is invoked from. Claude Code: the repository root of the working directory (`git rev-parse --show-toplevel`), or the working directory when it is not a repo. Cowork: the connected folder for that project, reached through the device shell; if several folders are connected and it is unclear which one the user is working in, ask once. Each project therefore keeps its own reviews, decisions and lock. All workspace reads, the lock, and all writes go through that one shell. A cloud container without a connected folder is not durable storage: say so, and do not present anything written there as saved review state.
- **Projects**: reached as connected folders or repos available to the session. A configured project whose folder is not reachable is `not refreshed`, never assumed unchanged.
- **Linear**: through the Linear connector, described by capability (read and search projects, issues, milestones, cycles, status updates; update fields; create issues; create project status updates). Do not assume specific tool names; discover what the connector offers.
- **Other evidence**: only sources listed as evidence locations in `CONFIG.md`; these may include connector-reachable sources (for example source control or CI), used read-only.
- **Workers**: Agent tool subagents, read-only.

## Start from the review workspace

Use `<invoking project>/coo/` when it exists. Read [state and storage](references/state-and-storage.md) before creating, reading, or updating review files. If it does not exist, do not look for or reuse a workspace in another project: ask to create `coo/` in the invoking project, create it only with the user's authorization, write a `CONFIG.md` skeleton for the user to confirm (the invoking project listed first, other projects only as the user names them), and do not prepopulate project conclusions.

Acquire the workspace run lock before allocating run IDs, loading mutable review state, or writing to Linear:

1. Create `coo/.run-lock` with a plain, atomic `mkdir` (never `mkdir -p`). Success means this coordinator created it and owns it; failure means someone else holds it.
   ```sh
   W="<workspace>/coo"; test -d "$W/reviews" || { echo NO_WORKSPACE; exit 2; }
   mkdir "$W/.run-lock" 2>/dev/null && echo ACQUIRED || { echo HELD; cat "$W/.run-lock/owner.json" 2>/dev/null; }
   ```
2. Allocate the run ID (next free `YYYY-MM-DD-NN` in `coo/reviews/`) and immediately write `coo/.run-lock/owner.json` with a unique owner token, run ID, session identifier (if known; otherwise say unknown), host as reported by the shell, and acquisition timestamp. If this write fails, remove your own lock and abort.
3. If the lock already exists, stop without changing shared state and report the recorded owner. Age alone is not proof the owner has stopped; an absent or unreadable `owner.json` is not permission to take the lock. Recover an abandoned lock only after verifying the owning task has terminated or getting the user's explicit recovery direction.

Then load `CONFIG.md`, `CURRENT.md`, pending decision records, `KNOWLEDGE_QUEUE.md`, and `STATE.json`. A request may narrow or override the configured project scope for that run; it does not silently broaden `CONFIG.md`. Do not access private calendar data, even if a calendar connector is attached; use only deadlines, constraints, and availability the user supplies or authorizes.

## Review efficiently

Begin with a lightweight freshness pass for every selected project:

- confirm access and the current project location;
- compare the current revision, working-tree state, relevant planning files, and available evidence with the previous checkpoint;
- identify additions, removals, and changes that may affect project state (exclude the `coo/` workspace itself when fingerprinting the invoking project, so the review's own files never count as project drift);
- mark inaccessible or insufficiently checked projects as `not refreshed` rather than carrying an old state forward as current.

Deeply inspect only projects with relevant changes, unresolved prior findings, stale evidence, or an explicit user request. For unchanged projects, retain the prior state with the current freshness result and any limitations. Git history is one signal; include uncommitted and untracked work, and use configured file metadata or content fingerprints where Git is unavailable. Do not equate an unchanged Git revision with an unchanged project.

Do not run broad test suites by default. Reuse valid recent results, inspect relevant existing evidence, and run targeted checks when they are safe, proportionate, and needed to resolve a material state or priority question.

## Parallel project inspection

Parallelize only independent, substantial project inspections when doing so is likely to reduce elapsed time. Keep small reviews local. Use at most two project subagents initially unless the user asks for broader parallelism or measured review results justify it. Parallel execution may reduce time but can increase total model usage; do not delegate unchanged or trivial projects.

Give each subagent exactly one project, its previous state (its `CURRENT.md` section and `STATE.json` entry), the detected changes, relevant evidence locations, the drift lens below, and this required return shape:

- observed state and sources;
- meaningful drift;
- blockers and dependencies;
- candidate next actions;
- completed work and possible knowledge candidates;
- evidence limitations and freshness.

Subagents must not rank the whole portfolio, edit shared COO files, touch the lock, write to Linear, or change the project (no edits, commits, installs, or state-changing commands). The coordinator reconciles contradictions, performs cross-project prioritization, owns the decision panel, writes every shared output, and is the only Linear writer for the review.

**Drift lens (optional checklist, not a scoring model).** When deeply inspecting, check whether a change touches code, architecture, test, dependency, documentation, or infrastructure health. A lens hit becomes a finding only if it passes the materiality test in the next section. Do not score items numerically.

## Build the operating view

For each project, separate verified observations, documented intent, inferred state, reported constraints, and unknowns. Detect drift only when it can affect delivery, reliability, priority, or future understanding. Cosmetic differences do not become COO findings.

Read [prioritization](references/prioritization.md) before ranking work. Select up to three portfolio outcomes; return fewer when fewer are supported. Do not fill empty positions with weak work. Explain why each matters now, the expected outcome, dependencies, what it displaces, and confidence.

Create a decision-panel entry only when the user must choose a consequential trade-off, direction, deferral, or commitment. Routine work and already accepted priorities bypass the panel. Persist each consequential candidate immediately as a proposed decision record (`D-NNN`, allocated under the lock, never reused) with an originating-review link. Before creating one, check unresolved records for the same choice and reuse that ID. Reuse IDs in later reviews until resolved; interest or silence does not establish acceptance.

Identify completed work that may contain reusable knowledge. Add a compact unreviewed candidate (`K-NNN`) to the queue when it contains a verified procedure, durable explanation, useful failure pattern, decision criterion, or correction to existing documentation. Capturing a candidate does not authorize changes to its destination; promotion requires a later review of the candidate and destination.

## Apply Linear changes

If a Linear connector is attached, read [Linear synchronization](references/linear-synchronization.md) before using it. If none is attached, skip that reference and record the blocked change plan described below.

Linear reflects the operating priorities and project state established by the review; it does not replace project files. Read current Linear data, calculate the required changes, re-read each record immediately before writing it, apply the change directly, then read the affected records again to verify the result. Change every field needed to make Linear consistent with the supported review outcome while preserving unrelated content. Never claim a change succeeded because a write call returned without an obvious error.

The user has authorized direct Linear synchronization for this workflow. Do not request separate confirmation for routine Linear changes supported by the completed review or an already accepted decision. When a Linear change depends on a decision-panel choice, wait for the user's decision, then apply and verify it directly. This authorization covers Linear only. It does not extend to reminders, calendars, scheduled tasks, chat, email, other trackers, or any other external system.

If no Linear connector is attached, or the workspace/project mapping cannot be confirmed, record synchronization as `blocked` with the exact missing dependency and include the intended changes (with the current values you could observe) as a change plan. Do not represent unverified local assumptions as applied Linear state.

Do not produce personal follow-up or reminder suggestions (dated nudges, review dates, "remind me" items), and do not create reminders, calendar events, or scheduled tasks. Dates that matter belong in the priorities, decision records (revisit conditions), or Linear.

## Save and present the review

Read [review format](references/review-format.md) before writing the result.

Write one dated review for the run (`coo/reviews/YYYY-MM-DD-NN.md`). Update `STATE.json` only for projects whose inspection completed successfully; keep the last successful checkpoint for the rest and record the failure in the review. Refresh factual observed state in `CURRENT.md` without requiring approval, preserving source dates and limitations. Record completed Linear changes and verification results. Keep only unresolved decision-panel items pending.

Collect knowledge candidates as unreviewed without interrupting the review. Update the existing decision record after the user explicitly accepts, rejects, defers, or supersedes it, retaining the original proposal and a dated status history. Carry unresolved and deferred decisions into the current view. Preserve historical reviews; append a dated correction rather than rewriting history.

### Checkpoints and the lock

Release the lock on completion, on error, and before any pause for user input:

1. Verify `owner.json` still carries your owner token.
2. Remove only your `owner.json`, then remove the empty lock directory (non-recursive): `rm "$W/.run-lock/owner.json" && rmdir "$W/.run-lock"`. If deleting in the connected folder is not permitted, follow the release fallback in [Claude runtime](references/claude-runtime.md); never delete recursively.

Before asking for a decision, persist the review, pending decision records, run ID, and any recorded Linear status-update IDs, then release the lock. A follow-up reacquires the lock with the same run ID, reloads current state, and re-reads affected Linear records; it never reuses a stale write plan.

### Decision panel with the user

Write the review and the presentation in the language the user writes in, unless they explicitly ask for another; Portuguese means Portuguese from Portugal. Present the executive state, supported portfolio priorities, decision panel, meaningful changes, knowledge candidates, and Linear synchronization results. Omit empty or unchanged sections. End with the few decisions actually needed.

For those final consequential choices only (after the lock is released), you may use the AskUserQuestion tool: one question per decision ID, offering the real alternatives from the record plus defer where deferral is genuine. Do not invent alternatives to fill the question. If there are more open decisions than fit comfortably, ask the most consequential and list the rest with their IDs. Do not use it for routine confirmations or Linear changes the user has already authorized.

### Optional durable view

Only if the user asks for a shareable or durable view, publish the review as a private Artifact or a Claude Docs document. The local review file remains the record of truth; the published view is a derived copy and must not include secrets, full logs, or private calendar details.

## Hand-offs, not part of this run

Suggest these, do not perform them: a full debt audit of one project (`engineering:tech-debt`); an ADR inside a project repo for an accepted technical decision (`engineering:architecture`, a project change that needs separate authorization); promoting a knowledge candidate (a later candidate review).

## Boundaries

- Never change an existing skill or its supporting files without the user's explicit permission for that specific change.
- Do not commit, push, deploy, modify production, or change reviewed projects unless separately authorized. The only writes are inside `coo/` of the invoking project; do not commit them or edit `.gitignore` (suggest ignoring `coo/.run-lock/` and `coo/.released-locks/` instead).
- Do not create or modify schedules, scheduled tasks, or reminders.
- Do not manufacture priorities to fill a quota or treat missing evidence as healthy state.
- Do not copy full logs, conversations, or project contents into the checkpoint.
- Keep observed facts distinct from recommendations and accepted decisions.
- Honor project instructions in `CLAUDE.md` and `AGENTS.md` when present in a reviewed project.
