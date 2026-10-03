# RCA workflow port: summary

**Skill produced:** `skills/rca-investigation/`: SKILL.md (341 lines) plus references (evidence-intake, evidence-inventory, log-parsers, capture-inspection, issue-tracker, issue-template [PT, verbatim], parallel-investigation [new]), scripts (3, byte-identical) and tests (3). `python3 -m pytest` from the skill folder: 21 passed, 1 skipped (`test_real_pcap` needs `capinfos`). No companion skill (RCA-02).

**Trigger examples:** "Why did checkout return 503s between 12:00 and 12:40 yesterday?"; "Here are HAProxy + IIS logs and a pcap, find the root cause"; "Does this RCA actually hold up?"; "Just prepare these logs for investigation"; "Open a Jira ticket for this troubleshooting and keep it updated."

**Reused from Anthropic and why:**
- `engineering:debug`: its reproduce → isolate → fix → regression-test loop becomes delegated step 7 when the mechanism localizes to accessible code. The Codex rca had no fix or regression-test step. Results return to the ledger and the causality gate is re-applied (RCA-07).
- `engineering:debug`: reproduction becomes a discriminating-test type, the change-history lookup (commits and PRs on the affected path) is added, and exact error text is required (RCA-04/05/10).
- `engineering:deploy-checklist` and `engineering:testing-strategy`: pointers only, used after a fix (RCA-14/15).

**Substituted with the user's method and why:**
- debug's "diagnose / root cause" and "Debug Report" → evidence classes, ranked falsifiable hypotheses, causal roles, the causality gate, 4 confidence levels and `root cause not confirmed` (RCA-06/08).
- incident-response's SEV table and 5 whys are excluded: they conflict with "no invented severity" and with separating causal roles (RCA-11/12).
- debug's "create a ticket" → off-by-default tracking with a capability map for Linear, Jira and GitHub and a portable-draft fallback (RCA-09/19).

**Claude mechanics:** Agent-tool role contracts (intake, evidence-source analyst, hypothesis generate/challenge, reviewer, tracker, code-fix); coordinator alone writes shared state via a versioned snapshot schema; AskUserQuestion only for production-changing tests and blocking tracker fields; no scheduled tasks.

**Hand-offs:** snapshot goes to `incident-live-report` (Investigation section), `incident-postmortem`, `tech-email` and `sre-incident-lifecycle`.

**Open questions:**
1. May step 7 commit or open PRs by default, or only on request (currently only on request)?
2. Which Jira description format does the user's connector accept?
3. The real-capinfos test has not been verified in this environment.
4. Is the ticket-title rule (RCA-20) acceptable?
