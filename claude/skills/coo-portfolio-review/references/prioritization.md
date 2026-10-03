# Portfolio prioritization

Prioritize outcomes across projects after project findings have been reconciled. Avoid false numerical precision; use the following questions as judgment criteria. Do not substitute a numeric scoring formula (for example impact x risk x effort) for these questions.

## Selection criteria

- What is the consequence of delay?
- Does the work unblock other work or remove a material dependency?
- Is there a real deadline supplied by the user or an authoritative source?
- Does the work reduce a current operational, security, financial, or delivery risk?
- Is another task logically required first?
- Is the outcome close enough to completion that finishing it has disproportionate value?
- How strong and current is the evidence supporting the recommendation?
- Does it align with an explicit user objective or accepted decision?

Select up to three portfolio outcomes. Do not fill empty positions with weak work. A priority is an outcome, not a vague activity; prefer `verify production paging delivery` over `work on reliability`.

## Recommendation fields

For each selected outcome state:

- project and outcome;
- why it matters now;
- evidence supporting urgency or value;
- dependencies and blockers;
- expected completion signal;
- what will be deferred or displaced;
- confidence and material unknowns.

Use external tracker priority levels according to their native meaning. Do not turn every selected item into `Urgent`. A due date represents a real deadline, not an aspirational completion date.

## Drift lens

When a worker or the coordinator deeply inspects a project, these health dimensions help avoid blind spots. They are a checklist for where to look, not a ranking:

| Dimension | Typical material signal |
| --- | --- |
| Code | duplicated or diverging logic that is causing defects or blocking a planned change |
| Architecture | a structural limit that blocks a milestone or a stated scaling need |
| Test | missing or flaky checks around work that is about to ship |
| Dependency | outdated or unmaintained dependency with a known security or compatibility consequence |
| Documentation | plans, runbooks or READMEs that now contradict observed state |
| Infrastructure | manual or unmonitored operation that creates current operational risk |

A dimension hit becomes a COO finding only when it can affect delivery, reliability, priority, or future understanding. Otherwise leave it out.

## Decision panel gate

Create a decision entry when at least one of these is true:

- two meaningful outcomes compete for limited capacity;
- the recommendation changes an accepted direction or materially defers work;
- acting commits meaningful time, cost, risk, or external expectations;
- credible alternatives have different consequences that only the user can choose;
- missing evidence creates a material choice between investigating and acting.

Each entry includes the decision, recommendation, actual alternatives, evidence, trade-offs, priority consequences, and a concrete revisit condition. Do not invent alternatives merely to make the panel look complete.
