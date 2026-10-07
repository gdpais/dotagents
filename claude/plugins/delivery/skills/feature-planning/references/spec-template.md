# Spec template

Omit sections that do not apply; never pad. Keep IDs stable so tests, commits and review can cite them.

```markdown
# <Feature title>

**Recommendation:** ready | ready with gaps (Q1, Q3) | not ready (<why>)
Source: <ticket/link or "conversation"> · Repo: <path> · Date: <YYYY-MM-DD>

## Problem and outcome
<who is affected, what changes for them>. Success measure: <metric from user/data> | [to be defined]

## Scope
- In: …
- Non-goals: …

## Acceptance criteria
- AC1 Given <state>, when <action>, then <observable result>.
- AC2 … (failure path: invalid input / unauthorized / dependency down / empty / large)

## Design notes
- Change goes in `<path:line>` because <reason>; follows the pattern in `<path:line>`.
- Data: <model/schema changes, backfill>.
- API/contract: <new or changed endpoints, events, schemas>.
- ADR: required (<trigger>) → engineering:architecture | not needed (<reason>)

## Risks
| ID | Area | Risk | Mitigation / owner |
|---|---|---|---|
| R1 | security | new public endpoint accepts file uploads | size/type limits, authz check; [owner to be assigned] |

## Slices
| # | Slice | ACs | Size (estimate) | Likely gates | Flag |
|---|---|---|---|---|---|
| 1 | Expand schema: add nullable column | – | S | migration | – |
| 2 | Backend behind flag | AC1, AC2 | M | review, security | `feature_x` |

## Test approach
- AC1, AC2 → integration tests in `<path>`; AC3 → e2e.

## Rollout
Flag ramp / migration order / kill switch.

## Dependencies
- <team, service, access, data>

## Assumptions
- A1 <assumption to confirm>

## Definition of Ready
| Line | Result |
|---|---|
| Problem stated | pass |
| Testable ACs | pass |
| Scope and non-goals | pass |
| Risks with mitigations | gap (R2 owner) |
| Independent slices | pass |
| Dependencies named | pass |
| Design decision | pass (not needed) |
| Sizes labelled estimate | pass |

## Open questions
- Q1 <question> — decision-maker: <name> | [to be assigned]
```
