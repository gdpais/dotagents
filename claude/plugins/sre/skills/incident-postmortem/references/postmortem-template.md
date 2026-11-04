# Postmortem template

A blameless learning document, structured after the Google SRE example postmortem (summary, impact, root causes and trigger, resolution, detection, action items, lessons learned, timeline, supporting information). More complete than the live report, but every section must earn its place: leave out rows and sections that have nothing measured or nothing to say, and write `not measured` once instead of padding.

```markdown
# [INCIDENT-ID] [Title] - Postmortem

**Date:** [impact window, timezone] · **Status:** Draft | In review | Final · **Owner:** [as given, or to be assigned]
**Services:** [scope] · **Links:** [live report, tickets, related changes]

## Summary
[3-5 sentences: what happened, impact in numbers, duration, cause and its confidence, how it was resolved, the most important action.]

## Impact
| Measure | Value | Window / source |
|---|---|---|
| Affected requests / users | [n of N, %] | |
| Error rate / latency | [peak and overall] | |
| Impact duration | [start - end] | |
| Time to detect / mitigate / restore | [values; formulas below] | |
| SLO / error budget | [value, or not measured] | |
| Business / data impact | [value, or not measured] | |

## Root cause and trigger
- **Trigger:** [event that exposed the failure - evidence - confidence]
- **Root cause:** [underlying mechanism - evidence - confidence; or "root cause not confirmed" with leading candidates]
- **Contributing conditions:** [condition - how it widened impact or slowed recovery - confidence]
- **Ruled out:** [candidate - evidence]

## Detection
[How it was detected, when, and what should have detected it sooner.]

## Resolution
[What mitigated and what restored service, with the measured effect of each step; temporary vs permanent fix.]

## Action items
| # | Action | Type (prevent/detect/mitigate/process) | Priority | Owner | Due | Tracking | Done when | Status |
|---|---|---|---|---|---|---|---|---|

## Lessons learned
- **What went well:**
- **What went wrong:**
- **Where we got lucky:**

## Timeline ([timezone])
| Time | Event | Source |
|---|---|---|

## Supporting information
[Key evidence with links/locators, open questions with owners, data caveats.]
```

Source: Google SRE book, "Example postmortem" and "Postmortem culture" (sre.google/sre-book/example-postmortem, sre.google/workbook/postmortem-culture).
