---
name: sre-incident-lifecycle
description: "Coordinate an SRE incident end to end by phase: declare and triage, keep the live report updated, hand causal work to rca-investigation, draft stakeholder comms, apply a resolution gate, then write the postmortem. Use when the user says \"we have an incident\", \"production is down\", shares an alert to triage, asks \"where are we on the incident\" or \"what's next\", or wants the whole flow run; prefer it over the generic engineering:incident-response for this user. For a single artifact use incident-live-report, rca-investigation, tech-email, or incident-postmortem directly."
---

# SRE Incident Lifecycle

Route an incident through its phases and call the right skill for each one. This skill owns sequencing, gates, authorizations, and the shared incident record; the stage skills own their artifacts.

| Phase | Owner skill | Output |
|---|---|---|
| 0. Intake and routing | this skill | incident record, phase decision |
| 1. Declare / triage | this skill, then `incident-live-report` | first live report within minutes |
| 2. Live update loop | `incident-live-report` | updated live report |
| 3. Causal work | `rca-investigation` (separate workflow) | evidence ledger, ranked hypotheses, confidence |
| 4. Communications | `incident-live-report` status post, `tech-email` | drafts for approval |
| 5. Resolution gate | this skill | status `Resolved` or back to the loop |
| 6. Postmortem | `incident-postmortem` | blameless postmortem draft for review |
| 7. Follow-up (optional) | tracker connector, `engineering:documentation`, `engineering:deploy-checklist` | filed actions, runbooks, deploy checks |

**Load only what the current phase needs.** Read a stage skill when its phase is actually reached, not up front: `incident-live-report` for a report or update, `tech-email` only when an email is requested, `rca-investigation` only when there is a causal question and evidence to work on, `incident-postmortem` only at Phase 6. A request for one artifact can go straight to that stage skill without running the other phases.

## Guardrails (apply in every phase)

- **Authorization.** Do not send communications, page anyone, post to channels, publish documents, create or update tickets, or change production without explicit authorization for that action. A request to draft or prepare never authorizes sending. Record each authorization with its scope (one-off or ongoing for a named destination) and honor it without re-asking inside that scope. Delegation to a subagent never grants extra access or authority.
- **Evidence classes.** Keep what is known, suspected, ruled out, and still unknown separate in every artifact. From RCA, keep `observed` / `reported` / `inferred` / `unknown` and the confidence labels `confirmed` / `strongly supported` / `unconfirmed` / `unknown`. Never upgrade confidence while moving findings between artifacts.
- **Do not invent** customer or financial impact, SLO effects, owners, teams, ETAs, commitments, incident IDs, or recipients. Use `unknown`, `not measured`, `[Team to be assigned]`, or `[INCIDENT-ID]`. Proposed values are labelled `proposed` or `unconfirmed`.
- **Blameless.** Describe system conditions, safeguards, and decision context, never personal fault.
- **Containment first.** When impact is active and critical, prioritize mitigation over completing the RCA; do not present recovery as proof of cause.
- **KPI language.** No `MTTR`/`MTTD`/`MTTA` for a single incident. Use `impact ongoing for ...`, `mitigation pending`, and in the postmortem `time to detect/acknowledge/declare/mitigate/restore` and `impact duration`.
- **Language.** Each artifact follows the language the user writes in, unless the user explicitly names a language for that artifact (for example "the email in Portuguese" changes only the email). Portuguese means Portuguese from Portugal. Keep quoted evidence, identifiers, commands and log lines in their original language.
- **Project instructions.** Read `CLAUDE.md` (and `AGENTS.md` if present) for the organization's templates, timezone, roles, and channels; those are authoritative over generic defaults here.

## Phase 0: intake and routing

Determine the phase from the user's message and the evidence, not from a fixed order:

- Alert, report, or "something is wrong" with no record yet → Phase 1.
- Record exists and impact or investigation is ongoing → Phase 2 (and 3 or 4 if asked).
- "Why did this happen", competing explanations, or a test to design → Phase 3.
- "Tell leadership", "draft the update email", "post in the channel" → Phase 4.
- "Is it over", "can we close", recovery observed → Phase 5.
- Resolved or stable and "write the postmortem" → Phase 6 (via the gate if not yet passed).

If the phase is genuinely ambiguous, ask one short question. Otherwise proceed.

Maintain one compact **incident record** for the session (the coordinator alone writes it): incident ID, timezone, status, authorizations and their scope, output destinations, current live-report version, KPI timestamps captured so far (impact start or bounds, detected, acknowledged, declared, mitigated, restored, closed), latest RCA snapshot and confidence, and a comms log (what was drafted, what was sent, to whom, when, on whose authorization). In Cowork, a task list per phase is a good way to show progress.

Ask once, at the first write, where durable outputs should live: inline in the conversation (default), a Markdown file in a folder the user names (for example `incidents/<INCIDENT-ID>/`), a living document through a document connector (for example Claude Docs), or the organization's knowledge base or incident tool (writing there is sharing and needs authorization). Do not force a choice and do not re-ask per update. Use a structured question (AskUserQuestion) only when the answer is blocking.

## Phase 1: declare and triage

1. Frame the incident from the evidence: symptom, affected capability, scope with denominator if available, current trend, recent changes, and what is unknown.
2. **Roles.** Record roles the user names (Incident Commander, Operations, Communications, responders). For a multi-team or major incident, you may recommend that these roles be designated, labelled as a proposal; do not assign people.
3. **Timestamps.** Capture impact start (or last-known-good / first-known-bad bounds), detected, acknowledged, and declared times with timezone and source. These feed the postmortem KPIs.
4. **Start the live report now** with the `incident-live-report` skill. Do not wait for complete information; missing values are `unknown` with the next check.
5. Note authorizations already granted (for example "you may post in #inc-123") and those still needed.

## Phase 2: live update loop

Run an update with `incident-live-report` whenever there is new evidence, an action result, a scope or trend change, a decision, a role or shift handoff, or the stated next-update time arrives. Each loop:

- update `Updated`, the Now section (impact, trend, what changed, next move), known/suspected/ruled-out/unknown, and actions (moving completed work to `Done` with its measured result);
- append material timeline entries, including any new KPI timestamps;
- decide whether to trigger Phase 3 (causal question is open and evidence exists), Phase 4 (an update is due or requested), or Phase 5 (recovery observed).

For a shift handoff, fill the live report's Handoff line (current state, what not to repeat, what to watch, next owner and acknowledgement).

If a mitigation or fix involves a production deployment, `engineering:deploy-checklist` can prepare pre-deploy checks and rollback triggers. Thresholds come from baselines or the user, never invented; executing the deploy needs explicit authorization.

## Phase 3: hand-off to rca-investigation

Use the `rca-investigation` skill for causal work: evidence ledger, ranked hypotheses, discriminating tests, and the causality gate. This skill does not perform its own causal analysis.

- **Pass:** the causal question, symptom and scope, incident window and timezone, the current live report, evidence sources and locations, recent changes, current mitigation state, and the authorization scope (read-only by default; production-changing tests need stated risk, explicit approval, rollback readiness, and post-change verification).
- **Receive:** RCA status and confidence, observed/reported/inferred/unknown facts, ranked hypotheses with supporting and contradicting evidence, tests run versus only proposed, ruled-out candidates, remaining gaps and next tests.
- **Map back** into the live report's Investigation section using the mapping in `incident-live-report`. The live report never states a final root cause; that belongs to the postmortem.
- Ticket tracking for the investigation (draft, create, update) is owned by `rca-investigation`'s optional issue tracking; do not run a second tracker for the same ticket.

While impact is active, RCA can run in a subagent in parallel (see "Subagents") so the coordinator stays on mitigation and the live report.

## Phase 4: communications

Choose the form by audience and channel; every form is a draft until authorized:

- **Channel or chat status post:** the short status post from `incident-live-report` (what is happening, who is affected, what is being done, next update time or trigger; no ETA unless authoritative).
- **Structured email** to executives, managers, and technical teams: the `tech-email` skill, given the current live-report snapshot and, if available, the RCA snapshot. It uses `Root Cause:` only for a `confirmed` cause and `Summary:` otherwise.
- **External or customer-facing notice:** only on explicit request, labelled `draft for approval`, with no impact, cause, ETA, or commitment that an authoritative source has not supplied; flag the organization's communications review.

**Approval gate:** show the draft, the destination, and the recipients (from the user, never guessed). Send or post only on explicit authorization for that message, or under a standing authorization the user gave for that destination. Log it in the comms log.

**Cadence:** use the organization's cadence if defined. Otherwise propose the next-update time or trigger as a proposal for the Incident Commander or user to confirm. Do not create scheduled tasks or background posting; nothing in this workflow runs on a schedule.

## Phase 5: resolution gate

Set status to `Resolved` only when all hold:

1. Exit criteria are defined (a specific service criterion and an observation period), from the user or proposed and accepted.
2. The criteria are met for the full observation period, with evidence (metric, window, source).
3. The user or Incident Commander confirms resolution.

If any fails, stay in `Mitigated` or `Monitoring` and return to Phase 2. Record `mitigated`, `restored`, and `closed` as separate timestamps when they differ. Resolution does not close tickets or follow-up work automatically; that needs the user's requested scope. Consider a final status post or email (Phase 4).

## Phase 6: postmortem

Use the `incident-postmortem` skill with the live report, the incident record's timestamps and comms log, the RCA assessment, and the change history. If the gate has not passed, the postmortem is `draft - incident ongoing`. The postmortem carries RCA confidence forward unchanged, and is not `Final` while material causal or impact claims are unreviewed.

## Phase 7: follow-up (optional, on request)

- File accepted corrective actions in the project tracker through a connector, with authorization; keep unassigned ones labelled `proposed`.
- Runbook actions can use `engineering:documentation`; fix deployments can use `engineering:deploy-checklist`.
- Tracking corrective actions to completion happens in the tracker, on request; this workflow does not hand off to other review workflows.
- A summary email to leadership or teams uses `tech-email`.

## Subagents

Use subagents only when independent work materially helps; small incidents stay with one agent. The coordinator alone writes the incident record, the live report, and the postmortem, and serializes any production-affecting or external action.

| Subagent | Receives | Must return |
|---|---|---|
| RCA worker (runs `rca-investigation`) | causal question, window, timezone, evidence locations, live-report snapshot version, read-only scope | findings with source refs, hypotheses and confidence, tests run vs proposed, gaps; the snapshot version it used |
| Comms drafter (runs `tech-email` or the status post) | one live-report/RCA snapshot version, audience, language request, greeting or sender if supplied | the draft only, plus the snapshot version used; never sends |
| Postmortem helpers (timeline, KPI calculation, review) | incident window, timezone, sources, KPI definitions from `incident-postmortem` | timeline or KPI values with formulas, sources, confidence; or a list of unsupported claims and blame language found |

Discard a returned draft if a newer snapshot has changed its facts; regenerate from the latest one. Agreement between agents reading the same source is not independent corroboration.

## Relationship to engineering:incident-response

For this user this skill replaces the generic `engineering:incident-response` workflow. Borrowed from it: the phase framing (triage, communicate, mitigate, postmortem), the four-point status-update checklist, the role names, and the connector categories (monitoring, incident management, chat). Substituted by the user's standards: the live-report and postmortem templates, the KPI definitions, the trigger/root cause/contributing-conditions analysis in place of "5 whys", evidence classes in place of "no speculation", and no ETA or response-time commitments unless authoritative.

## Finish

Each turn, return the artifact(s) for the current phase (for example the updated live report, or a draft email), then one or two lines stating the current phase, the next gate, and any authorization or decision needed from the user.
