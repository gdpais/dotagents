# Claude skills and workflows (ported from Codex)

Working copies of the Claude skills ported from `~/.codex/skills`. They live here until they are final and copied into `~/.claude/skills`.

## Layout

- `skills/` - one folder per skill (SKILL.md, references/, scripts/). Copy a folder into `~/.claude/skills/` to install it.
- `workflows/<name>/` - per-workflow decision log (`DECISIONS.md`), summary and Mermaid diagram (`workflow.mmd`).
- `ORCHESTRATION-DECISIONS.md` - cross-workflow decisions (G-xx).
- `overview.mmd` - how the skills hand off to each other.
- `evals/` - test prompts and expectations per iteration (fixtures and run outputs are not stored).

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

Turn off `engineering:incident-response` and `engineering:code-review` in the app when these are installed (G-14).
