# Review format

Keep the review short enough to operate from. Omit empty sections and avoid repeating unchanged project detail already available through `CURRENT.md` or the prior review.

```markdown
# COO review — YYYY-MM-DD

Run ID: YYYY-MM-DD-NN
Scope: selected projects
Previous review: link or none
Evidence current through: timestamp and timezone

## Executive state

Material changes, current constraints, and overall direction.

## Portfolio priorities

Up to three outcomes, each with rationale, completion signal, dependencies, displacement, and confidence.

## Decision panel

Only consequential choices requiring user judgment. Include each stable decision ID, record link, originating review and current status. Carry unresolved choices forward using their existing IDs. Mark new entries proposed until the user decides them.

## Project changes

### Project name — health

- Last inspected:
- Freshness: refreshed | freshness-only | not refreshed (reason)
- Material changes:
- Current milestone:
- Blockers:
- Drift:
- Completed work:
- Evidence and limitations:

## Knowledge candidates

New or changed candidates only, with stable IDs, source work, possible destination, reusable value, evidence, and status.

## Linear changes

Workspace identity plus applied and verified changes, created records, decision-blocked changes, and failures or unverified results. When no Linear connector was available, a change plan marked blocked.

## Suggested hand-offs

Only when warranted: project debt audit, project ADR, knowledge-candidate review. This workflow is standalone and does not hand off to, or receive hand-offs from, the incident workflow.

## Review diagnostics

- elapsed time when observable;
- projects selected, deeply inspected, and freshness-only;
- subagents used and why;
- repeated findings avoided through checkpoint reuse;
- missing access or failed checks (including folders not connected, lock release fallback used);
- actual usage data only when available.
```

## Current-state update

After a successful inspection, refresh factual state in `CURRENT.md` with source dates and limitations. A project's earlier state must not be represented as current when the project was inaccessible or its evidence was not refreshed. Linear changes supported by the completed review are applied directly; only changes depending on unresolved decision-panel items remain pending.

## Knowledge candidate record

Use a stable ID and one compact record:

```markdown
### K-NNN — title

- Source review:
- Source work:
- Status: unreviewed
- Suggested destination:
- Reusable value:
- Evidence:
- Duplicate check:
- Next action:
```

## Decision record

Create the record when a consequential choice is proposed. Update its status and append a dated history entry when the user decides:

```markdown
# D-NNN — title

- Scope:
- Status: proposed | accepted | rejected | deferred | superseded
- Originating review:
- Proposed on:
- Decision:
- Source and date:
- Why:
- Alternatives considered:
- Evidence and assumptions:
- Revisit when:
- Consequences and related work: what becomes easier, what becomes harder, and linked work
- Status history: date, transition, reason and user decision source
```

`Source and date` and the status history record how the user decided (for example: answered the decision question in this conversation on DATE, or stated it in a message). A decision taken through a question tool is recorded the same way as one stated in chat; silence, an unanswered question, or general interest is not a decision.

Acceptance records the choice, not completion of the resulting work. Do not add implementation action items to the decision record; resulting work goes to Linear and project plans. Preserve superseded records and link their replacements.
