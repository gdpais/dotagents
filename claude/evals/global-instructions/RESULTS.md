# Global instruction files (2026-11-15)

Question: does a global `~/.claude/CLAUDE.md` help, and is the Karpathy-style guide (`claude/CLAUDE.md`) worth adding to it?

81 headless Claude Code sessions (Opus 5.5, effort high, the user's normal settings and 13 installed plugins including `delivery`). 9 implementation tasks (the 4 original ones and the 5-task hard tier, all scored by hidden tests) × 3 arms × 3 repetitions, interleaved. Session cost **$22.25** (API-equivalent), plus $0.55 for the isolation probes. Review tasks were left out: they would have added about $15 and the question is about implementation behaviour.

| Arm | Global CLAUDE.md |
|---|---|
| `g-none` | none |
| `g-min` | `claude/global/AGENTS.md` (22 lines) |
| `g-karp` | `claude/global/AGENTS.md` followed by `claude/CLAUDE.md` (81 lines) |

**Isolation.** Each arm runs under a mirror HOME (`mirrorHome` in `harness/run.ts`): every entry of `~` and `~/.claude` is symlinked except the user's `CLAUDE.md` and per-session state, `.claude.json` is copied, and the arm's own `~/.claude/CLAUDE.md` is written there. The real `~/.claude` is never written. (`CLAUDE_CONFIG_DIR` was ruled out: the live OAuth token is in the macOS keychain, and a custom config dir looks up a different keychain entry.) A one-turn probe per arm confirmed the same model, output style, 13 plugins and 59 skills, and that the model saw exactly the intended file: none; `AGENTS.md` (Language, Tooling, Done means proven, Cost, Decisions); `AGENTS.md` plus Karpathy sections 1–4.

## Per arm

Means over evals of per-eval means (27 runs per arm).

| Arm | Hidden tests passed | Quality (hidden + suite) | Cost $/task | Turns | Duration s | Nudges | Ended asking |
|---|---|---|---|---|---|---|---|
| g-none | 27/27 | 100% | 0.268 | 9.7 | 27.5 | 0.00 | 0% |
| g-min | 27/27 | 100% | 0.279 | 11.3 | 28.2 | 0.00 | 0% |
| g-karp | 27/27 | 100% | 0.278 | 10.3 | 26.8 | 0.00 | 0% |

## Differences vs g-none (95% bootstrap CI, stratified by eval)

| Arm | Δ quality | Δ cost $/task | Δ turns | Δ duration s | Δ nudges |
|---|---|---|---|---|---|
| g-min | 0 pts [0, 0] | +0.011 [−0.003, +0.025] (+4%) | +1.6 [+0.1, +2.9] | +0.7 [−1.8, +3.1] | 0 [0, 0] |
| g-karp | 0 pts [0, 0] | +0.010 [−0.003, +0.023] (+4%) | +0.6 [−0.9, +2.0] | −0.7 [−3.1, +1.5] | 0 [0, 0] |

Per eval, the only sizeable difference was `hard-rename` with `g-min`: 23.7 turns vs 10.0 (cost $0.37 vs $0.28), from making the rename with several small commands and re-running the checks; same outcome. Full per-eval table: `bun harness/report.ts --out DIR --ref g-none`.

## Findings

1. **No quality effect is measurable here.** Every arm passed every hidden test, including the five trap tasks. Opus 5.5 is at the ceiling on these tasks, so a global file cannot show a gain; it also caused no loss.
2. **The cost is small and not significant.** Both files add about +$0.01 per task (+4%, CI −1% to +9%), in line with the extra context they put on every turn. Adding Karpathy on top of the minimal file cost nothing more (−$0.001).
3. **Karpathy's "if uncertain, ask" did not cause extra stops.** No arm ended a run asking the user or needed a nudge.
4. **The minimal file's rules barely showed in these runs.** Final replies named a check result in 1/27 (none), 2/27 (minimal) and 2/27 (Karpathy) runs. The minimal file's other rules (reply language, bun, cost, when to ask) aren't exercised by these tasks, so this eval can't value them.

## Verdict

Keep the minimal file and don't adopt Karpathy, in whole or in part. On 81 hidden-test runs neither file changed outcomes; both cost about 4% more per task (not significant). Karpathy adds nothing over the minimal file. Its four sections restate what Opus already does here: it ran the tests, kept the changes small and didn't over-build. That matches the controlled study (arXiv:2602.11988): generic context files bring no success gain at a cost. The minimal file earns its place through what this harness doesn't measure (PT-PT replies, `bun`, the proof-before-done habit, when to ask). At about $0.01 per task, that's cheap insurance, provided it stays short. Re-test if a cheaper model becomes the default, where instructions have more room to help.

## Limits

- Ceiling effect: on these 9 tasks at 100%, only cost, turns and time can differ. A harder or more ambiguous task set (or Sonnet/Haiku) would be needed to show a quality effect.
- 3 repetitions per cell; small fixtures; one model at effort high.
- Fixtures, mirror HOMEs and runs are not stored (G-33). Reproduce with `bun harness/pipeline.ts --out DIR --md FILE --arms g-none,g-min,g-karp --ref g-none --reps 3 --evals impl-typo,impl-discount,impl-remember,impl-bugfix,hard-rename,hard-format,hard-search,hard-migration,hard-idempotent`.
