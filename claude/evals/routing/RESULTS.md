# Routing test, stage 1 (2026-10-28)

264 headless Claude Code sessions (`claude -p`, Opus 5.5 `claude-opus-5-5`, Claude Code 2.1.310, the user's normal setup): 44 natural prompts that never name a skill × 2 arms × 3 repetitions, interleaved. Each session was stopped at its first `Skill` call; otherwise it ended by itself or at 6 turns. Cost: **$38.87** ($0.147 per session).

**Question.** When the custom incident and review skills are installed next to `engineering:incident-response`, `engineering:code-review` and the built-in `code-review`, which one does Claude Code actually invoke? Would turning off the two engineering skills (G-14) change anything?

**Answer.** Turning them off would not change routing. With the custom skills installed, neither engineering skill won a single run (0/66 each; 0/30 and 0/54 on the prompts where it was a fair pick, so the 95% upper bound is about 10% and 5%). The built-in `code-review` also took no review request away from `defect-first-review`. The engineering skills are not dead, though. With the custom skills absent, `engineering:incident-response` fired in 14 of 30 fair runs. `engineering:code-review` stayed nearly dormant either way (2/54).

## Arms

| Arm | Loaded | Init check |
|---|---|---|
| all | `sre` plugin (5 skills) + `delivery` plugin with `defect-first-review` (`--plugin-dir`, replacing the user-installed delivery 3.1.0) + everything else the user has (synced `engineering` 1.2.0, built-ins, anthropic-skills) | 132/132: each of the 9 competing skills listed exactly once |
| engineering-only | the same without `sre` and `defect-first-review` | 132/132: no custom skill listed, engineering ones and built-in `code-review` once each |

The user-level copies of `rca-investigation` and `tech-email` in `~/.claude/skills` were hidden per session with `--settings '{"skillOverrides":{…:"off"}}'`, so `~/.claude` was not changed. The plugins were built from this branch's `claude/skills/` and the installed delivery 3.1.0. The skill text matches the main checkout's `claude/plugins/` as of today; see `plugins-manifest.json`.

## Results

| Family | Arm | Acceptable pick | Intended custom skill | Wrong skill | Missed (no skill) | False triggers on negatives | Engineering skill fired where fair |
|---|---|---|---|---|---|---|---|
| incident | engineering-only | 25/66 (38%) | – | 1 | 19/33 (58%) | 0/12 (0%) | 14/30 (47%) |
| incident | all | 63/66 (95%) | 50/54 (93%) | 0 | 3/54 (6%) | 0/12 (0%) | 0/30 (0%) |
| review | engineering-only | 37/66 (56%) | – | 0 | 29/48 (60%) | 0/12 (0%) | 2/54 (4%) |
| review | all | 53/66 (80%) | 32/48 (67%) | 0 | 13/48 (27%) | 0/12 (0%) | 0/54 (0%) |

"Acceptable pick" scores against the labels in `prompts.json`, written before any run and restricted to what the arm has installed. "Intended" counts the custom skill each prompt was written for. "Missed" means no skill fired where one was the only acceptable outcome. The engineering-only arm's low scores are mostly misses: with no custom skill there, the model answered directly.

**Picks per arm (132 runs each):**

| Skill | all | engineering-only |
|---|---|---|
| none | 41 | 94 |
| `defect-first-review` | 27 | – |
| `sre-incident-lifecycle` | 14 | – |
| `incident-live-report` | 13 | – |
| `rca-investigation` | 10 | – |
| `tech-email` | 9 | – |
| `incident-postmortem` | 5 | – |
| **`engineering:incident-response`** | **0** | **14** |
| **`engineering:code-review`** | **0** | **2** |
| **built-in `code-review`** | **0** | **9** |
| built-in `security-review` | 3 | 2 |
| `delivery-lifecycle` / `performance-review` | 2 / 3 | 3 / 3 |
| `engineering:tech-debt` / `engineering:documentation` | 3 / 2 | 3 / 1 |
| `anthropic-skills:docs` | 0 | 1 |

## What the data says

1. **Incident family: the custom skills own routing.** 63/66 acceptable picks, 50/54 intended, no wrong skill, and no false trigger on the 4 negatives. The HAProxy-line explanation (in4) did not trigger `rca-investigation`. `tech-email` fired 9/9, `incident-live-report` 12/12 and `sre-incident-lifecycle` 14/15 (the other one went to `incident-live-report`, which is also acceptable). The 3 misses were answered inline: `rca-investigation` on i09 and i11, `incident-postmortem` on i13. In the i13 miss the model tried the Claude Docs connector, which was denied, so nothing was created.
2. **`engineering:incident-response` is a working fallback, not a competitor.** With the custom skills absent it fired on "prod is down" (3/3), an alert to triage (3/3) and "start an incident report" (3/3), and sometimes on i01, i13, i17 and i18. With them present it never fired. G-28's "no Anthropic skill triggers naturally" does not hold for incident prompts.
3. **Review family: `defect-first-review` never loses to another review skill. It loses to no skill at all.** It fired in 27 of the 42 runs written for it. The other 15 were 12 inline reviews and 3 built-in `security-review` picks (r08 "security pass", 3/3). It went 3/3 on "review my branch", "check my uncommitted changes", "is this safe to merge?" plus a diff, "review the last commit", a PR URL, "be strict, only real bugs" and "rank by severity". It was weak on a pasted diff with "review this diff please" (1/3), "quick sanity check… anything broken?" (1/3), "tell me if anything will break in prod" (1/3), "did I miss edge cases or error handling?" (1/3) and "any injection risks?" on a pasted patch (0/3). The inline answers were real reviews (git diff, file reads, findings). They just didn't go through the skill.
4. **Built-in `code-review` is not taking requests from `defect-first-review`** (0/66 with it installed). Without it, the built-in is the one that fires: "review my branch" 2/3, uncommitted changes 2/3, PR URL 3/3, r14 and r16 1/3 each. `engineering:code-review` fired only on "N+1 queries and SQL injection" (2/3), its own trigger words.
5. **Other skills behaved as labelled.** "Ready to merge?" went to `delivery-lifecycle` (5/6), "is it slower, p95" to `performance-review` (6/6), "what should we refactor first" to `engineering:tech-debt` (6/6) and the runbook to `engineering:documentation` (3/6).
6. **Consistency.** 33 of 44 prompts got the same pick in all 3 repetitions, in both arms. Nearly all of the unstable ones swing between a skill and an inline answer, the misses above. Two different skills for the same prompt happened once per arm: i01 in `all` (lifecycle ×2, live report ×1) and the runbook in engineering-only (`engineering:documentation` vs `anthropic-skills:docs`). Every skill call came on the first turn but one, which came on the second.

## Cost

| Arm | Sessions | Cost | Per session | Stopped at a Skill call |
|---|---|---|---|---|
| all | 132 | $18.49 | $0.140 | 91 |
| engineering-only | 132 | $20.39 | $0.154 | 38 |
| **total** | **264** | **$38.87** | **$0.147** | 129 |

Sessions stopped at their Skill call report no cost, so $14.84 of the total is estimated. Cache writes and reads come exactly from the stream. Output tokens come from the stream's `thinking_tokens` estimates plus visible text at 2.5 characters per token, calibrated on completed runs. Prices were fitted on the 135 sessions that reported a cost, with zero residual: $8/MTok 1-hour cache write, $0.20 cache read, $20 output. On those sessions the estimate is off by 1.2% (median) and 3.2% (p90). Another ~$2 went to pilots and init checks, which are not in the data. The arms' costs are not a quality comparison: no-skill sessions ran until they answered. That comparison is stage 2.

## Description changes this suggests

- **`defect-first-review`** (the only one that matters): add the phrasings it missed, such as "anything broken?", "will this break anything in prod?", "sanity-check what I changed", "did I miss edge cases or error handling?", and a pasted patch with a specific-risk question ("any injection risks?"). Also decide whether "security pass" belongs to it. The description claims "a security, performance, or correctness pass on a change", but the built-in `security-review` won that request 3/3, which matches G-41 (Verify uses `security-review`). Either drop "security" from the trigger list or accept the split.
- **`rca-investigation`** (minor, 10/12): add "what's causing it" for recurring failures.
- **`incident-postmortem`** (minor, 5/6): add "write-up for the review".
- No description needs narrowing: no false triggers and no wrong skill in the `all` arm.

## Limits

One model, Opus 5.5, the user's default. Sonnet or Haiku may route differently. `claude -p` lacks the desktop app's system prompt. Three repetitions per cell, so per-prompt rates are coarse; the family totals carry the result. Only the first pick is measured, not later hand-offs between skills. Sessions could edit their own throwaway fixture copy (`acceptEdits`). MCP connectors were not allowed, which is `-p`'s default.

## Proposed decision row (not added to ORCHESTRATION-DECISIONS.md)

| G-46 | Routing test of the overlapping skills (2026-10-28) | Turn off `engineering:incident-response` and `engineering:code-review` (G-14); keep them | G-14 stands: turning both off does not change routing. Keep the built-in `code-review`. Tighten `defect-first-review`'s triggers. | 264 `claude -p` sessions (Opus 5.5), 44 natural prompts × 2 arms × 3 reps, $38.87. With the custom skills installed, neither engineering skill won a run (0/66 each) and the built-in `code-review` took no review request. The custom incident skills took 63/66. `defect-first-review` fired in 27/42 of its runs; the rest were inline reviews (12) and `security-review` (3). Without the custom skills, `engineering:incident-response` fired in 14/30 fair runs and `engineering:code-review` in 2/54. The only loss from turning them off is that fallback. |

## Files

| File | What |
|---|---|
| `route.ts` | Runner: arms, plugin snapshot, init check, stop at first Skill call. Plugin and skill dirs are arguments. |
| `analyze.ts` | Metrics, cost estimate, the tables above (`--md`) |
| `make_fixtures.sh` | `billing-svc` git repo (feature branch + uncommitted change) and `ops` incident evidence |
| `prompts.json` | 44 prompts with labels (intended / acceptable / kind) |
| `runs.jsonl` | One raw record per session: pick, tools before it, usage, init check, end reason |
| `transcripts.jsonl.gz` | Every session's full stream-json, as `{run, event}` lines |
| `summary.json`, `plugins-manifest.json` | Analyzer output; the plugin sources the runs used |

Rerun:

```bash
bun route.ts --out /tmp/rt --sre ../../skills --delivery ~/.claude/plugins/cache/dotagents/delivery/3.1.0 --review-skill ../../skills/defect-first-review
bun analyze.ts --runs /tmp/rt/runs.jsonl --md /tmp/rt/tables.md
```

Once the skills move, `--sre ../../plugins/sre --delivery ../../plugins/delivery` works too.

## Per prompt

| Prompt | Kind | Acceptable (intended first) | all | engineering-only |
|---|---|---|---|---|
| i01 | eng-fair | sre-incident-lifecycle, incident-live-report, eng:incident-response | sre-incident-lifecycle ×2, incident-live-report | none, eng:incident-response ×2 |
| i02 | eng-fair | sre-incident-lifecycle, eng:incident-response | sre-incident-lifecycle ×3 | eng:incident-response ×3 |
| i03 | eng-fair | sre-incident-lifecycle, eng:incident-response | sre-incident-lifecycle ×3 | eng:incident-response ×3 |
| i04 | custom | sre-incident-lifecycle, incident-live-report, eng:incident-response | sre-incident-lifecycle ×3 | none ×3 |
| i05 | custom | incident-live-report, sre-incident-lifecycle, eng:incident-response | incident-live-report ×3 | eng:incident-response ×3 |
| i06 | eng-fair | incident-live-report, sre-incident-lifecycle, eng:incident-response | incident-live-report ×3 | none ×3 |
| i07 | custom | incident-live-report, sre-incident-lifecycle | incident-live-report ×3 | none ×3 |
| i08 | custom | rca-investigation | rca-investigation ×3 | none ×3 |
| i09 | custom | rca-investigation | rca-investigation ×2, none | none ×3 |
| i10 | custom | rca-investigation | rca-investigation ×3 | none ×3 |
| i11 | eng-fair | rca-investigation, eng:debug | rca-investigation ×2, none | none ×3 |
| i12 | eng-fair | incident-postmortem, eng:incident-response | incident-postmortem ×3 | none ×3 |
| i13 | eng-fair | incident-postmortem, eng:incident-response | incident-postmortem ×2, none | eng:incident-response, none ×2 |
| i14 | custom | tech-email | tech-email ×3 | none ×3 |
| i15 | custom | tech-email | tech-email ×3 | none ×3 |
| i16 | custom | tech-email | tech-email ×3 | none ×3 |
| i17 | ambiguous | incident-live-report, incident-postmortem, sre-incident-lifecycle, eng:incident-response | incident-live-report ×3 | eng:incident-response, none ×2 |
| i18 | ambiguous | sre-incident-lifecycle, rca-investigation, incident-live-report, eng:incident-response, eng:debug | sre-incident-lifecycle ×3 | none ×2, eng:incident-response |
| in1 | negative | none, eng:debug | none ×3 | none ×3 |
| in2 | negative | none, eng:documentation | none, eng:documentation ×2 | none, eng:documentation, anthropic-skills:docs |
| in3 | negative | none | none ×3 | none ×3 |
| in4 | negative | none | none ×3 | none ×3 |
| r01 | eng-fair | defect-first-review, built-in code-review, eng:code-review | defect-first-review ×3 | built-in code-review ×2, none |
| r02 | custom | defect-first-review, built-in code-review, eng:code-review | defect-first-review ×3 | built-in code-review ×2, none |
| r03 | eng-fair | defect-first-review, built-in code-review, eng:code-review, security-review | defect-first-review ×3 | none ×3 |
| r04 | custom | defect-first-review, built-in code-review, eng:code-review | none ×2, defect-first-review | none ×3 |
| r05 | eng-fair | defect-first-review, built-in code-review, eng:code-review, security-review, performance-review | defect-first-review ×2, none | none, eng:code-review ×2 |
| r06 | custom | defect-first-review, built-in code-review, eng:code-review | defect-first-review ×3 | none ×3 |
| r07 | eng-fair | defect-first-review, built-in code-review, eng:code-review | defect-first-review ×3 | built-in code-review ×3 |
| r08 | custom | defect-first-review, built-in code-review, eng:code-review, security-review | security-review ×3 | none, security-review ×2 |
| r09 | ambiguous | delivery-lifecycle, defect-first-review, built-in code-review, eng:code-review | delivery-lifecycle ×2, none | delivery-lifecycle ×3 |
| r10 | custom | defect-first-review, built-in code-review, eng:code-review | none ×2, defect-first-review | none ×3 |
| r11 | ambiguous | performance-review, defect-first-review, eng:code-review | performance-review ×3 | performance-review ×3 |
| r12 | custom | defect-first-review, built-in code-review, eng:code-review | none ×2, defect-first-review | none ×3 |
| r13 | eng-fair | defect-first-review, built-in code-review, eng:code-review | none ×2, defect-first-review | none ×3 |
| r14 | custom | defect-first-review, built-in code-review, eng:code-review | defect-first-review ×3 | none ×2, built-in code-review |
| r15 | eng-fair | defect-first-review, built-in code-review, eng:code-review, security-review | none ×3 | none ×3 |
| r16 | custom | defect-first-review, built-in code-review, eng:code-review | defect-first-review ×3 | none ×2, built-in code-review |
| r17 | ambiguous | none, defect-first-review, built-in code-review, eng:code-review | none ×3 | none ×3 |
| r18 | ambiguous | none, eng:code-review, built-in code-review, eng:tech-debt | none ×3 | none ×3 |
| rn1 | negative | none, eng:debug | none ×3 | none ×3 |
| rn2 | negative | none, eng:tech-debt | eng:tech-debt ×3 | eng:tech-debt ×3 |
| rn3 | negative | none, eng:testing-strategy | none ×3 | none ×3 |
| rn4 | negative | none | none ×3 | none ×3 |
