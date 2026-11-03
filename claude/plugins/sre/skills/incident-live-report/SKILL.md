---
name: incident-live-report
description: Create or update a short, living SRE incident report (current state, known/suspected/ruled-out/unknown, actions, timeline) from the active issue, troubleshooting notes, logs, metrics, and decisions. Use whenever impact or investigation is still ongoing, including "update the incident doc", "start an incident report", or a short status update/post for the incident channel (Slack, Teams), even when no report exists yet; do not use for final root-cause analysis (use rca-investigation) or postmortems (use incident-postmortem).
---

# Incident Live Report

Turn the issue being worked and the available troubleshooting notes into a short, living investigation report. It must be quick for responders to write and update, while still giving SRE and leadership the impact, direction, and timing they need.

When the full incident lifecycle is being run (declare → update → RCA → comms → resolution → postmortem), the `sre-incident-lifecycle` skill coordinates and calls this skill for every live-report update.

## Non-negotiable boundary

This is an operational notebook for an active incident, not a postmortem.

- Keep it brief enough to update during troubleshooting. Link to detailed logs and dashboards instead of copying them.
- Treat causal explanations as working hypotheses, never as a final root cause. Distinguish what is known, suspected, ruled out, and still unknown.
- Do not assign customer impact, financial impact, an ETA, or commitments unless the user or an authoritative source provides the value.
- Do not send updates, change production, or make external commitments without explicit authorization. Saving the report where the user asked is fine; posting it to a channel, paging, emailing, or publishing it to a shared space is a communication and needs explicit authorization for that action.

Authoritative sources include the user, the organization's incident tooling, and project instructions (`CLAUDE.md`, `AGENTS.md`) that define templates, timezone, or roles.

## Build or update the report

1. Use the current issue, alert, ticket, logs, metrics, changes, commands, and responder notes as the factual base. Do not replace specific evidence with generic language.
2. Read [references/live-report-template.md](references/live-report-template.md). Fill the four sections: Now, Investigation, Actions, Timeline. Keep it short: a responder should read it in under a minute. If the template file is unavailable, use the outline below.
3. Do not delay the report because information is missing. Write `unknown` or `not measured`, then record the next check that can resolve the gap.
4. Use one stated timezone. On every update, change `last updated`, summarize what changed, retain important factual timeline entries, and move completed work to `Done` with its observed result.
5. Add the optional Coordination block only when multiple teams, formal roles, a handoff, or scheduled stakeholder communication make it useful.

### Outline (mirrors the template)

- Header: `# [INCIDENT-ID] [Symptom]`; Status; Updated (with timezone); Next update (time or trigger); Lead / channel / ticket.
- Now: Impact (number + source/window), Trend, Changed since last update, Next move (owner).
- Investigation: Known; Suspected; Ruled out; Unknown (with the next check).
- Actions: Done (time - action - measured result); In progress / next (owner, expected result or rollback condition).
- Timeline table: Time | Event, decision or change | Source.
- Optional Coordination: roles, exit criteria, handoff.

Do not invent the incident ID, owner, channel, or ticket. Use a visible placeholder such as `[INCIDENT-ID]` or `unknown` until supplied.

## Numbers in the report

Put the one or two decision-useful numbers in the Impact line (scope with denominator, and the main error/latency measure), each with its window and source. Use elapsed or `pending` while impact is active; never `MTTR`. If sources disagree, say so under Unknown rather than picking one. `No evidence observed` is not `no impact`. Final KPIs and SLO/error-budget calculations belong in the postmortem.

## Writing standard

- Lead with what is affected, how badly, whether it is improving, what changed, and what the team will do next.
- Write the report in the language the user writes in, unless they explicitly ask for another language for the report. Portuguese means Portuguese from Portugal. A language request for one output (for example "the email in Portuguese") applies only to that output. Keep quoted evidence, identifiers, commands and log lines in their original language.
- Use neutral, factual, non-blaming language. Describe system conditions and decision context, not personal fault.
- Keep completed mitigations distinct from planned actions. Record the measured result of each change; correlation is not proof of causality.
- Include unaffected scope only when it materially narrows the blast radius.
- Prefer short bullets; the timeline is the only table.
- Keep the whole report to about 600 words or fewer (one screen). Leave out any line that has nothing new or nothing known yet instead of writing "none" or "n/a", keep the timeline to decision-relevant events, and link to logs and dashboards instead of pasting them. On updates, replace stale lines rather than appending.

## Using causal findings from rca-investigation

When the `rca-investigation` skill (or its output) supplies findings, map them into section 3 without upgrading confidence:

- `observed` → **We know** (with time/source).
- `reported` → **We know**, tagged `reported, unverified`, or **Still unknown** if it is contested.
- `inferred`, `unconfirmed`, or `strongly supported` hypotheses → **We suspect**, keeping the confidence label and the next discriminating test.
- eliminated candidates → **Ruled out**, with the test and result.
- `unknown` and evidence gaps → **Still unknown**, with the next check.
- A mechanism rated `confirmed` may appear under **We know** as "causal mechanism confirmed by RCA (evidence: ...)", but do not write a "root cause" section or lessons here; the final root-cause statement belongs to the postmortem.

## Where the report lives

Ask once, at the first write, where the user wants the report kept; do not force a destination and do not ask again on each update. Options:

- **Inline in the conversation** (default when the user does not say): return the full report each time.
- **A Markdown file** in the working or connected folder the user names (for example `incidents/<INCIDENT-ID>/live-report.md`): edit it in place on each update.
- **A living document** through an attached document connector (for example a Claude Docs doc): update the same doc in place and keep its link in the header.
- **The organization's knowledge base or incident tool** through a connector: writing there shares the report, so do it only with explicit authorization for that destination.

Keep one current version. Do not create a new file or doc per update.

## Evidence inputs and connectors

Read from whatever is attached, described by capability: monitoring (alerts, metrics, dashboards), incident management (incident record, timeline, responders), chat (incident channel history), source control and CI/CD (recent changes and deploys), project tracker (linked tickets). Reading is fine within the user's access. Writing to any of them (posting, paging, creating incidents, updating tickets) requires explicit authorization for that action. If no connector is attached, work from pasted notes, files, and screenshots, and name what evidence would help next.

## Optional short status post

When the user asks for a quick channel/chat update derived from the report, read [references/status-post.md](references/status-post.md). Draft it only; posting it needs explicit authorization. For a structured email, use the `tech-email` skill instead.

## Finish

Return the filled report, not advice about writing one. Do not add postmortem sections such as final root cause, lessons learned, or corrective-action analysis while the investigation is active.
