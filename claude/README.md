# Claude skills and workflows

The Claude skills, packaged as plugins in the `dotagents` marketplace: the incident, RCA, review and COO skills ported from `~/.codex/skills`, and the delivery workflow (planning to production) built here. Installed plugins show their skills namespaced, e.g. `sre:tech-email`.

## Layout

- `plugins/<plugin>/skills/` - one folder per skill (SKILL.md, references/, scripts/). See *Install the plugins* below.
- `plugins/delivery/` - the delivery workflow: five skills plus hooks (`hooks/`) that run the gates automatically.
- `plugins/sre/` - incident response and RCA: five skills.
- `plugins/coo/` - the COO portfolio review.
- `workflows/<name>/` - per-workflow decision log (`DECISIONS.md`), summary and Mermaid diagram (`workflow.mmd`).
- `ORCHESTRATION-DECISIONS.md` - cross-workflow decisions (G-xx).
- `overview.mmd` - how the skills hand off to each other.
- `evals/` - test prompts and expectations per iteration (fixtures and run outputs are not stored); `evals/harness/` runs the delivery evals as real headless sessions; `evals/routing/` and `evals/headtohead/` measure the overlapping incident and review skills (G-47).
- `tools/validate_skills.ts` - checks frontmatter, names, script mentions, hand-offs and links. Run `bun run lint` and `bun run test` from the repository root; CI runs both.
- `tools/usage_report.ts` - reads the Claude Code transcripts in `~/.claude/projects` and writes the datasets behind the "Skills and workflows usage" dashboard (skill and workflow runs, delivery gate events, cost, models, tools, permissions) to `~/.claude/usage-report/`, outside the repository. Run `bun run usage`, then ask Claude to refresh the dashboard from those files. Custom skills and workflows are read from this folder, so new ones show up without changes to the script.
- `tools/permission_audit.ts` - lists the tool calls that stopped for permission and who stopped them (you, a hook, or auto mode's classifier), from the `permissionDecision` Claude Code records on each tool result. Run `bun claude/tools/permission_audit.ts --project Heartbeat --since 2026-10-22` when Claude asks for things it shouldn't.

## Skills

| Skill | Workflow | Plugin | Use |
|---|---|---|---|
| sre-incident-lifecycle | incident-response | sre | Coordinates an active incident and loads the stage skills by phase |
| incident-live-report | incident-response | sre | Short live status report (about 600 words) |
| incident-postmortem | incident-response | sre | Blameless postmortem after the Google SRE example |
| tech-email | incident-response | sre | Technical email, only when explicitly asked |
| rca-investigation | rca | sre | Evidence-led root cause analysis |
| coo-portfolio-review | coo-review | coo | Portfolio review, on demand, stored under the project where it runs |

The delivery skills (`delivery-lifecycle`, `feature-planning`, `performance-review`, `ci-cd-pipeline`) ship in the `delivery` plugin.

Turn off `engineering:incident-response` in the app when it is installed (G-14). Keep `engineering:code-review` on: it is the delivery workflow's reviewer (G-46). The delivery workflow also relies on the built-in `security-review` and on `engineering:deploy-checklist`, `architecture`, `system-design`, `testing-strategy`, `debug`, `tech-debt` and `documentation`; keep those on.

## Install the plugins

Install at user scope so every project gets them. The delivery hooks and the RCA helpers need `bun` on `PATH` or in `~/.bun/bin`; without it the gates are skipped rather than failing, and a notice at session start says so.

```
claude plugin marketplace add gdpais/dotagents
claude plugin install delivery@dotagents --scope user
claude plugin install sre@dotagents --scope user
claude plugin install coo@dotagents --scope user
```

After a merge, `claude plugin marketplace update dotagents` and `claude plugin update <plugin>@dotagents` pick up the new version. Don't also copy these skills into `~/.claude/skills` or upload them to claude.ai: the copy shows up a second time without the plugin prefix.

Or for one session only: `claude --plugin-dir /Users/gabiru/personal/dotagents/claude/plugins/<plugin>`.

## Delivery plugin

What it does without being asked: when Claude finishes a turn in which it edited files, the Stop hook runs `preflight` (the repo's lint, typecheck and tests, a secrets scan on the diff, a CI audit when workflows changed) and sends back failures and any review the change needs (security, performance, migrations, CI). `git commit` is checked for secrets; push, tag, merge, publish and deploy commands ask first. Per project, `.claude/delivery.json` can set `preflight.run` (which checks), `preflight.timeoutSeconds`, `hotPaths`, `securityPaths`, `ignore`, or `stopGate: false`.

**Autonomy (v3, opt-in per project).** An `autonomy` block in `.claude/delivery.json` approves the mechanical shipping steps once, so Claude stops asking for them:

```json
{ "autonomy": { "push": ["feature/*"], "openPr": true, "autoFix": true, "cleanupMerged": true,
                "continue": { "backlog": "TODO.md" }, "localClusters": ["kind-*", "minikube"] } }
```

With it, the policy is added to each new session, pushes of matching branches and kubectl/helm against the listed local clusters stop asking, and the Stop hook nudges once when finished work isn't pushed or has no PR, unless the user said to hold. Add `"merge": { "low": "green", "medium": "decide" }` to merge by risk (low on green, medium Claude's call, breaking always the user's), and `"review": "session"` (optionally `"reviewPreset": "<app preset>"`) to give every PR its own review session: it shows `engineering:code-review`'s tables, fixes, rates the PR with `pr_risk.ts` and merges or stops, while the session that opened the PR moves on. In every project with the plugin (policy or not), a turn that runs `engineering:code-review` must show its tables; `"stopGate": {"reviews": false}` turns that off. Merges (beyond `autonomy.merge` below), tags, releases, deploys, pushes to the base branch and force pushes still ask. Without the block, behaviour is v2.3's. With `cleanupMerged`, cleanup after a merge is one call to `cleanup_merged.ts` (fetch with prune, fast-forward the base, remove clean worktrees of merged branches, `git branch -d`); it keeps anything unmerged or dirty and says why.

