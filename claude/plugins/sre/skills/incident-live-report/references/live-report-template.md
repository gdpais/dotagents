# Live incident report template

A short status update for an active incident, after the status-update format in Anthropic's `engineering:incident-response` skill: what is happening, who is affected, what we have done, what comes next, and a timeline. It should take a few minutes to start and seconds to update, and stay within about 600 words. Write `unknown` rather than waiting; leave out lines that have nothing to say.

```markdown
## Incident Update: [INCIDENT-ID] [Title]
**Severity:** [organization's severity, as given] | **Status:** Investigating | Identified | Mitigated | Monitoring | Resolved
**Impact:** [who/what is affected, with the number and its source/window; or unknown]
**Last Updated:** [YYYY-MM-DD HH:MM tz] | **Next update:** [time or trigger]

### Current Status
- [What we know now - source/time]
- Suspected: [working hypothesis - why - next check]
- Ruled out: [candidate - test and result]
- Unknown: [gap - next check]

### Actions Taken
- [time - action - measured result]

### Next Steps
- [what happens next - owner - expected result or rollback condition]

### Timeline ([timezone])
| Time | Event |
|------|-------|
| [HH:MM] | [Event, decision or change - source] |
```

Leave out the Severity field when no severity was supplied; do not assign one. Add only when it helps (several teams, formal roles, a handoff, or scheduled stakeholder updates):

```markdown
### Coordination
- **Lead / channel / ticket:** [as given]
- **Roles:** [Incident lead / operations / communications - names as given]
- **Exit criteria:** [service criterion + observation period]
- **Handoff:** [state, what not to repeat, what to watch, next owner]
```

Source: Anthropic `engineering:incident-response` skill, "Output - Status Update". Kept from the earlier template: the `Mitigated` status, the `Next update` field, labelled hypotheses and the optional Coordination block, which `sre-incident-lifecycle` relies on.
