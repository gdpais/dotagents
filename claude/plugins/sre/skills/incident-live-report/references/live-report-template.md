# Live incident report template

A short shared working note for an active incident, after the Google SRE incident state document: current state first, then what we know, what we're doing, and a timeline. It should take a few minutes to start and seconds to update, and stay within about 600 words. Write `unknown` rather than waiting; leave out lines that have nothing to say.

```markdown
# [INCIDENT-ID] [Symptom or affected capability]

**Status:** Investigating | Identified | Mitigated | Monitoring | Resolved · **Updated:** [YYYY-MM-DD HH:MM tz] · **Next update:** [time or trigger]
**Lead / channel / ticket:** [as given, or unknown]

## Now
- **Impact:** [who/what is affected, with the number and its source/window; or unknown]
- **Trend:** [improving | stable | worsening | unknown] - [one line of evidence]
- **Changed since last update:** [new evidence, action result, or scope change]
- **Next move:** [check or mitigation - owner]

## Investigation
- **Known:** [observation - source/time]
- **Suspected:** [working hypothesis - why]
- **Ruled out:** [candidate - test and result]
- **Unknown:** [gap - next check]

## Actions
- **Done:** [time - action - measured result]
- **In progress / next:** [action - owner - expected result or rollback condition]

## Timeline ([timezone])
| Time | Event, decision or change | Source |
|---|---|---|
```

Add only when it helps (several teams, formal roles, a handoff, or scheduled stakeholder updates):

```markdown
## Coordination
- **Roles:** [Incident lead / operations / communications - names as given]
- **Exit criteria:** [service criterion + observation period]
- **Handoff:** [state, what not to repeat, what to watch, next owner]
```

Source: Google SRE book, "Managing incidents" and the example incident document (sre.google/sre-book/managing-incidents, sre.google/sre-book/incident-document).
