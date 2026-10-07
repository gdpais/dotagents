---
name: feature-planning
description: "Turn a feature idea, ticket, bug report or vague request into an implementation-ready spec: problem, users, scope and non-goals, testable acceptance criteria, risks, dependencies, and PR-sized slices, ending with a Definition of Ready check. Use when the user says \"plan this feature\", \"write a spec / PRD / tech plan\", \"break this ticket down\", \"how should we slice this\", \"is this ready to build\", or pastes a ticket and asks what it would take. Not for choosing between technologies or writing an ADR (engineering:architecture), designing a whole new system (engineering:system-design), test plans alone (engineering:testing-strategy), or portfolio priorities (coo-portfolio-review)."
---

# Feature Planning

Produce the smallest spec that lets an engineer start building without guessing, and say plainly what is still unknown. A plan is useful when its acceptance criteria are testable and its slices can each merge on their own.

## Inputs

Read only what is relevant:

1. The request, ticket, or linked issue (source-control or tracker connector, read-only, when the user points to one).
2. `CLAUDE.md` / `AGENTS.md` for conventions, architecture notes, and definitions the team already uses.
3. The code the feature touches: entry points, data models, existing tests, similar features to copy from. Cite files as `path:line`. For a large or unfamiliar area, one read-only Explore subagent can map it; ask it for file locations and call paths, not opinions.

If the request is too vague to write a single acceptance criterion, ask up to three focused questions (who is it for, what outcome, what is out of scope), then proceed with labelled assumptions for anything still open.

## Spec

Use [references/spec-template.md](references/spec-template.md). Rules for the sections that matter most:

- **Problem and outcome.** One or two sentences on who is affected and what changes for them. A measurable success signal only if the user or data supplies one; otherwise `success measure: [to be defined]`.
- **Scope and non-goals.** Non-goals are as important as goals: they stop scope creep in review.
- **Acceptance criteria.** Given/When/Then, observable from outside the code (API response, UI state, stored row, emitted event). Include the main failure paths: invalid input, unauthorized caller, dependency down, empty and very large data. Each criterion gets an ID (AC1, AC2…) so tests and review can cite it.
- **Design notes.** Where the change goes and why, grounded in cited code. If the plan needs a new service or data store, a public API or schema contract, an irreversible migration, a new critical dependency, or a cross-team interface, mark `ADR required` and hand that decision to `engineering:architecture`; do not decide it inside the plan, and link or summarise the ADR in one or two lines instead of pasting it into the plan.
- **Risks.** Security (new input surface, authz, PII), data (migration, backfill, consistency), performance (hot path, new queries, payload size), operability (new alerts, config, flags), and rollout (backward compatibility, mixed versions during deploy). Each risk gets a mitigation or `[owner to be assigned]`.
- **Slices.** Ordered, each independently mergeable and valuable or safely dark (behind a flag). Prefer vertical slices (one path working end to end) over layers. Typical order: schema expand → backend behind flag → UI → enable → contract/cleanup. Each slice lists its ACs, rough size (S/M/L, labelled `estimate`), and verification gates it will likely trigger (security, migration, performance).
- **Test approach.** Which ACs are unit, integration, or end-to-end tests. For a full test strategy hand off to `engineering:testing-strategy`.
- **Rollout.** Flag or not, migration order, how to turn it off.

## Definition of Ready

End with the checklist from the delivery workflow: problem, testable ACs, scope and non-goals, risks with mitigations, independent slices, dependencies, design decision made (ADR or `not needed`), sizes labelled `estimate`. Mark each `pass` / `gap`. List gaps as open questions with the decision-maker the user names, or `[to be assigned]`.

## Guardrails

- **Do not invent** requirements, users, metrics, deadlines, owners, or estimates presented as commitments. Assumptions are labelled `assumption` and listed together so they can be confirmed in one pass.
- **No gold-plating.** If a requirement is not in the request and not needed for an AC, it is a non-goal or a follow-up, not a slice.
- **Tracker writes only on request.** Filing slices as tickets (Linear, Jira, GitHub issues) needs explicit authorization and the target project from the user; never invent project, assignee, priority, or due date.
- **Language.** Write in the language the user writes in unless they name another; Portuguese means Portuguese from Portugal. Identifiers and code stay as in the repo.

## Output

Answer-first: one line with the recommendation (ready / ready with gaps / not ready and why), then the spec. Keep it to what an engineer needs; a typical feature fits in about one page (roughly 800–1,000 words). Put supporting detail (full ADR, long option analysis) in separate files when the user wants files, not in the reply. Save to `plan.md` (or the location the user names) only when asked or when the delivery workflow's work record lives in the repository.
