# Linear synchronization

The connected Linear workspace is the execution destination for COO-review priorities and project state. Project files remain authoritative for technical implementation and plans.

## Connector capability

Linear is reached through the Linear connector attached to the session. Discover what it offers rather than assuming tool names. Synchronization needs, at minimum:

- read and search: teams, projects, issues, milestones, cycles, workflow states, labels, users, and project status updates;
- write: update issue and project fields, create issues, create (and, where recorded ownership allows, edit) project status updates.

If a needed capability is missing, the affected changes are `blocked: connector lacks <capability>`; independent changes proceed. If no Linear connector is attached at all, run the review without writes and record the whole Linear section as a blocked change plan: each intended change with the target record (by stable ID when known from `CONFIG.md` or the last review), the field, the last observed value and its date, and the intended value. You may tell the user a Linear connector is required; do not attach, configure, or authenticate one on their behalf. Do not use another tracker or connector as a substitute write target.

## Preconditions

Before writing:

1. Confirm the configured Linear workspace and project/team mapping.
2. Read the current project, issue, milestone, status-update, and relevant workflow state.
3. Resolve project and issue identifiers from current Linear data; do not guess them.
4. Reconcile the review outcome with existing Linear content and recent changes.
5. Stop changes that depend on an unresolved decision-panel item until the user decides it.

If the connection or mapping is unavailable, record Linear synchronization as failed or blocked with the exact missing dependency. Do not represent unverified local assumptions as applied Linear state.

## Changes to apply

Apply every supported change needed to align Linear with the completed review, including when relevant:

- issue priority, status, project, milestone, cycle, assignee, estimate, due date, relationships, and labels;
- creation of important work that is not represented by an existing issue;
- project status, priority, dates, milestones, lead, members, summary, or description;
- a current project status update with health, progress, blockers, decisions, and next outcomes.

Preserve unrelated descriptions, comments, labels, relationships, assignments, dates, and workflow fields. Use field-level updates or patches where available. Do not rebuild records merely to change one field.

Do not constrain synchronization to a predetermined number of edits. Change what the review establishes must change. Avoid cosmetic rewrites and duplicate issues because they do not improve operating accuracy.

Do not invent owners, assignees, estimates, or due dates. Set an assignee only from evidence or an accepted decision; set a due date only for a real deadline.

## Idempotency and ownership

One coordinator owns Linear writes for the review. Project subagents return findings and identifiers but never write.

Before creating an issue, search for an existing issue representing the same outcome. Use stable Linear IDs in the review and checkpoint.

### Preserve project-update history

Persist the review run ID and returned Linear status-update IDs when creating updates: record the IDs in the review's Linear section and, in `STATE.json`, the ID plus a fingerprint of the content this run last wrote (see state and storage). Edit a status update only when recorded ownership proves this same review run created it AND its current content still matches the last content this run wrote. Never edit a human-written update or an update belonging to an earlier review. If a human has edited this run's update, preserve it; create a separate material follow-up when needed. If ownership is uncertain (for example `STATE.json` was lost or rebuilt), do not edit the existing update.

A later review creates a new status update only when it has a material change to report. An unchanged review posts nothing. A resumed run reuses its run ID and reconciles its recorded update ID before creating anything; after an uncertain create result, inspect recent updates before retrying to avoid duplication.

### Check immediately before writing

Keep the baseline values of fields being changed. Immediately before each mutation, re-read the affected record. If the target fields already equal the intended values, skip the write. If they match the baseline, apply only the intended fields. If they differ from both baseline and intended values, recompute the change from current evidence; do not overwrite the newer value using the stale plan. An unresolved priority or ownership conflict enters the decision panel while independent changes continue.

Preserve unrelated concurrent edits, including by rebuilding relationship/label updates from current data or using additive/removal operations. Use conditional writes with a revision token if the connector supports them. Otherwise the read/write interval is not atomic; read-back verification detects discrepancies but cannot eliminate every race. On a verification conflict, re-read and reconcile rather than repeatedly forcing the old value. Each retry repeats the pre-write check.

Re-running the same review should result in no further writes once Linear already matches the intended state.

## Verification and failure handling

After every write batch:

1. Read the affected Linear records again.
2. Compare the actual fields with the intended state.
3. Record successful, partially applied, failed, and skipped changes separately.
4. Retry only when the failure is transient and the operation remains safe and unambiguous.
5. Leave an unresolved item in the review when the desired state could not be verified.

Never claim a Linear change succeeded solely because a write call returned without an obvious error. Verification is part of completion.

## Review record

Record a compact change log:

```markdown
## Linear changes

Workspace: name and stable ID

### Applied and verified
- ISSUE-123: priority Medium -> High
- Project name: health At risk -> On track

### Created and verified
- ISSUE-456: concise title
- Status update <id> on Project name (run YYYY-MM-DD-NN)

### Pending decision
- Change and the decision that blocks it (D-NNN)

### Failed or unverified
- Intended change, observed result, and exact blocker

### Blocked change plan (no connector or mapping)
- Record, field: last observed value (date) -> intended value
```

Do not copy entire Linear records into the local review.
