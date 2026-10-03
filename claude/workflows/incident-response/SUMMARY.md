# IR workflow summary: SRE incident lifecycle

**Skills produced** (`skills/`): `sre-incident-lifecycle` (orchestrator, routes by phase with send, prod, and resolution gates), `incident-live-report` (port of incident-report-live, plus short status post), `incident-postmortem` (port of postmortem), `tech-email` (port of email-ala-cross, standalone and shared). Causal work is handed to `rca-investigation` (RCA workflow). Templates are copied verbatim into `references/`.

**Trigger examples:** "We have an incident, checkout 5xx at 12%" → lifecycle. "Update the incident doc with this log" → live report. "Give me a Slack update" → live report status post. "Draft the email to leadership, in Portuguese" → tech-email (PT-PT). "It's been stable 2h, can we close?" → resolution gate. "Write the postmortem for INC-123" → postmortem.

**Reused from Anthropic, and why:**
- `engineering:incident-response`: phase framing; SEV1-4 scale only as a `proposed, unconfirmed` fallback when the org has none; four-point status-update checklist (as the short status post); role names; connector categories. These fill gaps in the user's skills.
- `engineering:deploy-checklist`: optional for fix or mitigation deploys (rollback triggers from baselines, never invented).
- `engineering:documentation`: only for runbook corrective actions.

**Substituted with the user's standards, and why:** user's live-report and postmortem templates (richer); single-incident KPI definitions instead of "Duration"/MTTR; trigger, root cause, and contributing conditions with confidence instead of "5 whys"; known/suspected/ruled-out/unknown instead of "no speculation"; full action schema with `proposed` labels; no ETA or response-time commitments; paging, posting, and sending only with explicit authorization (Anthropic's skill does these automatically when connected).

**Added:** resolution gate (exit criteria + observation period + IC confirmation); live capture of KPI timestamps; RCA-to-live-report evidence mapping with no confidence upgrades; subagent contracts with a single coordinator-writer; ask-once output destination (inline, file, Claude Docs, KB); PT-PT vocabulary guardrails and secret masking in tech-email. No scheduled tasks. 42 decisions in `DECISIONS.md`; diagram in `workflow.mmd` (render-checked).

**Open questions:**
1. Does the org have severity definitions or an update cadence to put in `CLAUDE.md`? Until then severity stays `proposed, unconfirmed`.
2. Should `Detail #N` labels be localized in Portuguese emails, and are the suggested PT-PT headings acceptable?
3. Should `engineering:incident-response` be disabled to avoid trigger overlap?
4. Is masking secrets in DETAILS acceptable (it changes "preserve exact evidence")?
