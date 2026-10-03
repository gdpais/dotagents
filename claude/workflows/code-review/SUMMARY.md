# Code review port — summary

**Skill produced:** `skills/defect-first-review/` — SKILL.md (214 lines), references (target-resolution, coverage-lenses, subagent-briefs, github-posting), `scripts/resolve_review_target.py` (read-only merge-base resolver) with 10 unit tests (pass via `python3 -m unittest`).

**Source note:** the Codex source `.system/review-agent` is an OpenAI-shipped system skill, not user-authored (CR-01). Its rules are kept near-verbatim because they are the strongest contract and match the user's evidence-led style.

**Trigger examples:** "review PR 1234" · "review my branch against main before I merge" · "is this diff safe?" (pasted) · "review commit a1b2c3" · "look over my uncommitted changes, focus on security".

**Reused from Anthropic (and why):**
- `engineering:code-review` dimensions → coverage lenses (security classes, N+1, indexes, leaks, concurrency) that review-agent lacked (CR-05/06).
- Its PR intake via source-control connector, stated-intent check, and a bottom-line verdict — the verdict now derived from P-levels, not judgment (CR-10/15/21).
- `engineering:testing-strategy` focus areas as the yardstick for "material test gaps" (CR-26). `engineering:tech-debt` is a hand-off only (CR-27).

**Substituted (and why):**
- Reporting bar, P0–P3, findings-first format, `No findings.`, read-only, smallest diff-overlapping citation, whole-diff coverage — review-agent over Anthropic's emoji table, style items, and "What Looks Good" (CR-07/08/09).
- Added from the user's house style (rca/postmortem): per-finding evidence + confidence (`confirmed` / `plausible (<gap>)`), residual risks kept separate from findings, checks run vs recommended, authorization-scoped posting (CR-11/18/23).
- Claude-native: optional parallel lens subagents + independent verification pass, coordinator alone owns the list (CR-16/17); host findings tool when present (CR-19); CLAUDE.md + AGENTS.md (CR-20).

**Open questions:**
1. `engineering:code-review` stays installed and triggers on the same phrases. Disable it, or keep both and rely on descriptions?
2. Fan-out thresholds (~400 changed lines / ~10 files) are heuristics — adjust after a few real reviews?
3. Should posting default to inline comments when the user says "post", or always show a draft first?
4. Is fetching the PR ref (writes `.git` only) acceptable without asking?
