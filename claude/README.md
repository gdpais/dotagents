# Claude skills and workflows

Working copies of the Claude skills: the incident, RCA, review and COO skills ported from `~/.codex/skills`, and the delivery workflow (planning to production) built here. They live here until they are final and copied into `~/.claude/skills`.

## Layout

- `skills/` - one folder per skill (SKILL.md, references/, scripts/). Copy a folder into `~/.claude/skills/` to install it.
- `plugins/delivery/` - the delivery workflow as a Claude Code plugin: four skills plus hooks (`hooks/`) that run the gates automatically. See *Install the delivery plugin* below.
- `workflows/<name>/` - per-workflow decision log (`DECISIONS.md`), summary and Mermaid diagram (`workflow.mmd`).
- `ORCHESTRATION-DECISIONS.md` - cross-workflow decisions (G-xx).
- `overview.mmd` - how the skills hand off to each other.
- `evals/` - test prompts and expectations per iteration (fixtures and run outputs are not stored); `evals/harness/` runs the delivery evals as real headless sessions.
- `tools/validate_skills.ts` - checks frontmatter, names, script mentions, hand-offs and links. Run `bun run lint` and `bun run test` from the repository root; CI runs both.

## Skills

| Skill | Workflow | Use |
|---|---|---|
| sre-incident-lifecycle | incident-response | Coordinates an active incident and loads the stage skills by phase |
| incident-live-report | incident-response | Short live status report (about 600 words) |
| incident-postmortem | incident-response | Blameless postmortem after the Google SRE example |
| tech-email | incident-response | Technical email, only when explicitly asked |
| rca-investigation | rca | Evidence-led root cause analysis |
| defect-first-review | code-review | Code review that leads with defects |
| coo-portfolio-review | coo-review | Portfolio review, on demand, stored under the project where it runs |

The delivery skills (`delivery-lifecycle`, `feature-planning`, `performance-review`, `ci-cd-pipeline`) ship in the `delivery` plugin.

Turn off `engineering:incident-response` and `engineering:code-review` in the app when these are installed (G-14). The delivery workflow relies on the built-in `security-review` and on `engineering:deploy-checklist`, `architecture`, `system-design`, `testing-strategy`, `debug`, `tech-debt` and `documentation`; keep those on.

## Install the delivery plugin

Requires `bun` on `PATH` or in `~/.bun/bin` (the hooks and scripts are TypeScript run by bun). Without it the gates are skipped rather than failing, and a notice at session start says so.

```
/plugin marketplace add /Users/gabiru/personal/dotagents
/plugin install delivery@dotagents
```

Or for one session only: `claude --plugin-dir /Users/gabiru/personal/dotagents/claude/plugins/delivery`.

What it does without being asked: when Claude finishes a turn in which it edited files, the Stop hook runs `preflight` (the repo's lint, typecheck and tests, a secrets scan on the diff, a CI audit when workflows changed) and sends back failures and any review the change needs (security, performance, migrations, CI). `git commit` is checked for secrets; push, tag, merge, publish and deploy commands always ask first. Per project, `.claude/delivery.json` can set `preflight.run` (which checks), `preflight.timeoutSeconds`, `hotPaths`, `securityPaths`, `ignore`, or `stopGate: false`.

