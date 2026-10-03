# Optional issue tracking

Use the [Troubleshooting template](issue-template.md) for ticket descriptions. This mode is application-neutral and runs within the active investigation session.

## Activation

Tracking is off by default. The user can request a draft, create a ticket, connect an existing ticket, or enable ongoing updates at any time during an investigation. On activation, use the latest reconciled evidence snapshot, including relevant earlier work. Do not restart the investigation or require a milestone.

Distinguish one-off creation or update from ongoing tracking. A request for one ticket does not silently enable future writes. Authorization for ongoing updates to an identified ticket persists within its agreed scope; do not ask again for every routine update. If the destination or required fields are missing, prepare the draft while resolving those details.

## Shared evidence and parallel consumers

The investigation coordinator reconciles incoming evidence and publishes a versioned snapshot containing facts, source references, timestamps, impact, actions, results, hypotheses and confidence, recovery state, and preventive recommendations (schema in [Parallel investigation](parallel-investigation.md)). Reports and the tracker consume this same snapshot when requested or active.

After each published evidence update, the investigation can continue while a separate tracker worker (an Agent-tool subagent) evaluates whether the ticket needs a material change. The worker uses the supplied evidence and performs no independent causal investigation. It owns its draft and output; it does not edit the shared evidence ledger or report files.

Parallelism is an implementation option when the work justifies its overhead, not a mandatory agent spawn per evidence event. Batch bursts of changes and keep the latest snapshot. Performance benefits remain unmeasured until a representative trial.

## Material update gate

Create a ticket only when requested and no matching selected record exists. For an existing ticket, propose or apply an authorized update when a template field materially changes: symptoms, incident or escalation timestamps, impact, mitigation recommendations, an action actually executed, its result, causal confidence, validated recovery (Fim), or preventive work. Incorporate factual corrections as well.

Skip new logs that do not change the description, formatting-only differences, repeated findings, and unchanged hypotheses. Keep evidence references without transcribing every observation.

## Choosing the destination (connectors by capability)

Use whatever the user has chosen and the session can reach, in this order of preference:

1. An attached tracker connector: Linear, Atlassian (Jira), GitHub, or another project-tracker connector. Find it by what it can do, not by a fixed tool name.
2. A CLI the user has authorized in this environment (for example `gh` or a Jira CLI).
3. An authorized browser session (for example Claude in Chrome), only if the user asks for it.
4. Otherwise, a **portable draft** (below). Suggest connecting a tracker only if the user wants publication. Never install or connect anything on your own.

The operation needs these capabilities. Check which ones the chosen connector actually offers before relying on it:

| Capability | Needed for | Linear | Jira | GitHub Issues |
|---|---|---|---|---|
| Search or list issues in a scope | Duplicate check before create; finding a connected ticket | team / project | project (JQL if available) | repository |
| Read an issue (fields, description, comments) | Read before update; conflict detection; verification | yes | yes | yes |
| Discover required fields, issue types and states | Avoid inventing values | team workflow states, labels | issue types and required (possibly custom) fields per project | labels; issue types only if the repo uses them |
| Create an issue | One-off or first write | title + markdown description | summary + description (the connector may expect markdown, wiki markup or ADF; check) | title + markdown body |
| Update the description | Material updates | yes | yes | yes (edit body) |
| Add a comment | Fallback when description edits are unavailable, or an update log the user wants | yes | yes | yes |

If a capability is missing (for example, no edit, only comments), tell the user and offer the closest safe alternative. Do not silently change the write strategy.

**Title:** the template does not define a title. Use the symptom and the affected service or environment as stated in the evidence (for example, "Intermittent 503 on checkout API – production"). Do not add severity, owner or blame. The user may override the title.

**Portable draft:** return markdown containing the intended destination (if known), the title, the filled template body, the snapshot version it reflects, and the unresolved required fields. The user can paste it anywhere.

## Ordering and external operations

Inspect the destination's required fields and existing issue types; ask only for unresolved required choices. When the choice blocks publication, use AskUserQuestion if available. Do not invent a project, team, repository, owner, assignee, priority, labels, due date or issue type. A draft-only request never authorizes publication. Check for a matching issue within the selected scope before creating one when access permits.

Keep a compact session record: destination and ticket ID/URL, mode (draft / one-off / ongoing), authorized scope, latest snapshot version, last published version, pending draft version, and publication result. Give a delegated worker the snapshot, template, ticket identity, authorization scope and last published version. The worker returns the version processed, the field changes, and a verified publication result or blocker. Only one worker may publish to a given ticket, and it must discard superseded pending drafts before writing.

Prepare and perform authorized tracker operations in parallel with analysis and report preparation, but serialize writes to the same ticket. Wait for creation to return the record identity before sending updates. Track the snapshot version used and the last successful publication; never let an older draft overwrite a newer one.

Read the existing ticket before updating, and preserve user edits and unrelated content. If concurrent edits conflict with the intended change, show the conflict rather than overwrite it. If a create request times out with an uncertain result, look for the created record before retrying; do not blindly create a duplicate.

An unavailable integration or failed write leaves a pending portable draft and does not block the investigation. Report publication state separately from incident state. No background watcher or scheduler is implied by this design: do not create scheduled tasks for ticket updates.

Verify success from the application's returned record identity and saved content when available. For an uncertain update, read the ticket before retrying. Stop repeated failed publication attempts, keep the newest pending draft, and state the blocker. Resume when access or the failure condition changes. Omit secrets and unnecessary personal data, and use evidence links the intended audience can access. Upload attachments or create related records only within the user's authorized scope.

## Completion

After recovery is validated, prepare the final update with Fim and Validação da resolução, keeping unconfirmed root-cause language where appropriate. Preventive tasks can remain outstanding. Ticket closure or separately assigned follow-up tasks require the user's requested scope; service recovery does not automatically close the record.
