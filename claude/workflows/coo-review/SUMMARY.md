# COO review port — summary

**Skill produced:** `skills/coo-portfolio-review/`: SKILL.md (about 130 lines, core procedure complete on its own) plus references state-and-storage, linear-synchronization, prioritization, review-format, and claude-runtime (new: lock commands, surfaces, subagent brief, decision questions, scheduling stance).

**Triggers:** "run a COO review", "portfolio review of my projects", "refresh project state and set next priorities", "what should I focus on across projects, and update Linear". Not for: standups, a tech-debt audit of one repo, writing an ADR, or "schedule a weekly COO review" (declined).

**Preserved from Codex:** on-demand only; `mkdir` run lock with `owner.json` token; freshness pass with deep inspection only for changed projects; at most 2 workers at first with a six-part return contract; coordinator does all writes and is the only Linear writer; up to 3 priorities, never padded; stable D-NNN decision panel; K-NNN knowledge queue; checkpoint and lock release before any user pause; Linear-only sync authorization with re-read before and after writes; original boundaries.

**Claude mapping:**
- Workspace: a connected folder (Cowork device shell) or a local directory (Claude Code).
- Lock release: Cowork blocks deletes in connected folders, so an undeletable lock is atomically renamed into `.released-locks/` (no broad delete grant, no recursive delete).
- Workers are read-only Agent-tool subagents. Linear goes through the connector, described by capability; without one, the review records a blocked change plan.
- AskUserQuestion only for the final D-NNN choices, after the lock is released. Artifact or Claude Docs view only on request.

**Reused from Anthropic:** `engineering:tech-debt` contributes only its six categories, as an optional drift-lens checklist gated by the user's materiality test. `engineering:architecture` contributes only the "what becomes easier / harder" prompt in the decision record's Consequences field. Both are also offered as hand-offs (a project debt audit, or a project ADR needing separate authorization).

**Substituted or rejected:**
- Tech-debt scoring formula: conflicts with "avoid false numerical precision".
- ADR as the record format: D-NNN has rejected and deferred statuses, a revisit condition and status history; ADR action items blur acceptance with completion.
- `engineering:standup`: person- and day-centric, no checkpoint, evidence classes or "not refreshed" state, and it pushes a daily habit.
- CONNECTORS.md `~~project tracker` generalization: the write authorization covers Linear only. Its categories are allowed only as opt-in, read-only evidence listed in CONFIG.

**Scheduled tasks:** none created. The skill forbids creating them, stops if a scheduled task starts it, and treats a scheduling request as a skill change that needs the user's permission.

**Open questions:** (1) Resolved: `coo/` lives in the invoking project (COO-31). (2) Is COO-12 acceptable (subagents may not read Linear)? (3) Rename fallback, or grant delete permission on the workspace folder? (4) Name a specific incident sibling skill for the hand-off? (5) `mkdir` exclusivity on the user's Mac mount is untested; it was verified locally only.
