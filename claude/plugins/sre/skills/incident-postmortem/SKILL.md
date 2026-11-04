---
name: incident-postmortem
description: Create a blameless, evidence-led SRE postmortem from a resolved incident, its live report, troubleshooting record, RCA output, telemetry, and change history, with final KPIs (time to detect/mitigate/restore), trigger vs root cause, and owned corrective actions. Use when the incident is resolved or stable and the user wants the final learning document; do not use as the live incident state document (use incident-live-report) or for the causal investigation itself (use rca-investigation).
---

# Incident Postmortem

Turn the resolved issue and its troubleshooting record into a durable learning artifact for SRE, engineering, and leadership. Preserve the path from evidence to conclusion and from conclusion to corrective action.

When the full incident lifecycle is being run, the `sre-incident-lifecycle` skill reaches this stage only after its resolution gate, and passes the live report and the RCA assessment as inputs.

## Readiness and boundary

A postmortem is distinct from the live report. Start when the incident is resolved or stable enough for retrospective analysis.

- If impact is still active, use the `incident-live-report` skill for operations and mark any postmortem as `draft - incident ongoing`.
- A mitigation that improved the symptom does not, by itself, prove root cause.
- Use `confirmed`, `strongly supported`, `unconfirmed`, and `unknown` for causal confidence. If the root cause is not demonstrated, state `root cause not confirmed` and preserve the leading candidates and verification gaps.
- Write blamelessly: explain system behavior, safeguards, conditions, and decision context. Do not attribute failure to carelessness or an individual.
- Do not invent impact, financial values, SLO effects, or owners. Proposed values must be labeled for review.
- Do not share, publish, or file anything (knowledge base, tracker tickets, email, chat) without explicit authorization. Sharing approval and sensitive-data removal are review-checklist items, not assumptions.

## Build the postmortem

1. Collect the live incident document, issue/ticket, alerts, logs, dashboards, traces, captures, deploy and configuration history, communications, and action outcomes. Prefer primary runtime/configuration evidence over recollection.
2. Build an evidence ledger of material claims with source, timestamp, scope, and confidence. Reconcile contradictions explicitly.
3. Reconstruct the timeline in chronological order. Separate user-impact events, detection/coordination events, diagnostic evidence, changes, and verified recovery.
4. Calculate final incident KPIs using the definitions below. Show formulas and observation windows for derived values; write `unknown` or `not measured` when inputs are absent.
5. Analyze trigger, root cause, contributing conditions, detection gaps, and response factors separately. Causal claims must explain the mechanism and cite or name the supporting evidence.
6. Create specific corrective actions that trace to findings. Read [references/postmortem-template.md](references/postmortem-template.md) and use that structure unless the organization has a required template (for example one named in `CLAUDE.md`, `AGENTS.md`, or supplied by the user).
7. Before returning, run the review checks below yourself (do not print them as a checklist), and list unresolved questions under Supporting information. Do not call the document final while material causal or impact claims remain unreviewed.

### Using the RCA assessment

If an `rca-investigation` assessment exists, use its trigger, root cause, contributing conditions, detection gaps, recovery factors, ruled-out candidates, and confidence as the causal input. Carry its confidence labels forward unchanged unless new evidence is cited; never upgrade `strongly supported` to `confirmed` in the postmortem without the evidence that passes the causality gate. If no RCA exists and the causal question is material and unresolved, say so and recommend running `rca-investigation` rather than inventing a mechanism.

### Optional parallel work (subagents)

For large incidents, independent parts may be delegated to subagents: timeline reconstruction from primary sources, KPI calculation from telemetry, and an independent review of the draft for unsupported claims and blame language. Give each subagent the incident window, timezone, the relevant sources, and the definitions in this skill; each returns findings with source references and limitations. This skill's coordinating agent alone writes the postmortem and the evidence ledger, and a subagent review never substitutes for human review.

### Outline (mirrors the template)

Header (window and timezone, status, owner, services, links) → Summary → Impact table (only measurable rows) → Root cause and trigger (trigger, root cause, contributing conditions, ruled out, each with evidence and confidence) → Detection → Resolution → Action items → Lessons learned (went well, went wrong, where we got lucky) → Timeline → Supporting information (evidence, open questions, caveats).

Review checks before returning: impact and KPI figures computed once and consistent everywhere; timeline matches primary sources; trigger, root cause and contributing conditions separated with confidence; SLO/error budget computed from the real SLI or marked not measured; every action maps to a finding and has type, owner (or `to be assigned`), due date, tracking and a done-when criterion; language is blameless; sensitive data removed.

Compute each KPI once and reuse that exact value in the executive summary, impact section, KPI table and timeline. Before returning, check that every repeated figure matches and every percentage equals its stated count divided by its total; do not add counts from different sources unless they are shown to be distinct events that measure the same outcome (an internal call failure is not a customer-facing failure unless the evidence shows it surfaced).

## KPI definitions

Use precise single-incident labels; `MTTD`, `MTTA`, and `MTTR` are portfolio averages and should not label one incident.

- `time to detect = detected - impact start`
- `time to acknowledge = acknowledged - detected`
- `time to declare = declared - detected`
- `time to mitigate = mitigated - impact start`
- `time to restore = restored - impact start`
- `impact duration = end of user/SLI impact - impact start`

State if `mitigated`, `restored`, and `closed` differ. If the precise impact start is unknown, provide a bounded range when the last-known-good and first-known-bad timestamps support one.

Report only the KPIs that are measurable for this incident: affected requests/users with denominator, peak and overall error rate or latency, impact duration, time to detect/mitigate/restore, SLO/error budget (from the real SLI and SLO window, never from duration alone for event-based SLIs), and business or data impact. Each needs a window and source; say whether it is measured, estimated or bounded. Leave out the rest rather than filling rows with `not measured`.

## Causal and action-item quality

- Separate `trigger` (the event that exposed the failure) from `root cause` (the underlying mechanism) and `contributing conditions` (factors that increased likelihood, impact, or recovery time).
- Do not use missing monitoring, a responder action, or a nearby change as root cause without mechanism evidence.
- Do not reduce the analysis to a single linear "5 whys" chain; multiple contributing conditions and detection/response factors must stay visible with their own evidence and confidence.
- State what evidence would falsify or confirm an unresolved causal claim.
- Include what went well, what went wrong, and where we got lucky.
- Prefer system and process changes over reminders to be more careful.
- Each action item must have a type (`prevent`, `detect`, `mitigate`, or `process`), priority, one accountable owner, due date, tracking ID, a done-when criterion, and status. If not assigned, label it `proposed` rather than fabricating details.
- Link every action to a finding or lesson; avoid vague verbs such as `improve` without a measurable outcome.

## Writing standard

Write in the language the user writes in, unless they explicitly ask for another. Portuguese means Portuguese from Portugal. A language request for one output (for example "the email in Portuguese") applies only to that output. Keep quoted evidence, identifiers, commands and log lines in their original language.

Lead with a short answer-first summary and the impact table. Keep detailed evidence and chronology below. Aim for something a reviewer can read in about five minutes. Use neutral language, exact technical identifiers where helpful, and enough background for readers outside the responding team.

## Where the postmortem lives and what happens next

Ask once where the user wants it kept; do not force a destination:

- **Inline** in the conversation (default when unspecified);
- **a Markdown file** in the working or connected folder the user names (for example next to the live report, `incidents/<INCIDENT-ID>/postmortem.md`);
- **a living document** through an attached document connector (for example a Claude Docs doc), which suits review comments;
- **the organization's knowledge base** through a connector, only with explicit authorization, after the sensitive-data and sharing-approval checklist items are addressed.

Optional follow-ons, each only when the user asks:

- Filing accepted corrective actions in the project tracker through a connector (authorized writes only; never invent project, owner, priority, or due date; keep `proposed` items as proposals).
- A leadership or team summary email via the `tech-email` skill.
- A corrective action that is "write or update a runbook" may use `engineering:documentation` (runbook structure); one that ships a fix may use `engineering:deploy-checklist`. Neither changes production without authorization.

## Finish

Return the complete postmortem. If the evidence supports only a partial analysis, deliver a clearly labeled draft that is still useful and lists the exact remaining validation work.
