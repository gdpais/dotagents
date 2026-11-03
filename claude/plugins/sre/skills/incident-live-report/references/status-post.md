# Optional short status post

A brief update for an incident channel, chat thread, or status line, derived from the current live report. It is a projection of the report, never a separate source of truth: every statement must already be in the report.

Adapted from the four-point status-update checklist in `engineering:incident-response` (what is happening, who is affected, what we are doing, when the next update is), tightened with the live-report rules: no ETA or commitment unless authoritative, hypotheses labelled as such.

```text
[INCIDENT-ID] [Status] - [Concise symptom or affected capability]
Impact: [who/what is affected, with scope and source; or unknown]
Current state: [improving | stable | worsening | unknown] - [one line of evidence]
Since last update: [new evidence, action result, or scope change]
Working on: [next move and owner; label hypotheses as "suspected"]
Next update: [time with timezone, or trigger]
Live report: [link, if one exists and the audience can open it]
```

Rules:

- Keep it to the lines above; drop a line only when it has nothing new and is not required for the audience.
- `Next update` is a time or trigger, not an ETA for resolution. Give a resolution ETA only when the user or an authoritative source supplied it, and attribute it.
- Do not state a cause as established; write "suspected" or "under investigation" unless the RCA confidence is `confirmed`.
- Do not include customer, financial, or contractual impact unless supplied by an authoritative source.
- Remove secrets, tokens, personal data, and internal-only links when the audience is broader than the responding team.
- Return the draft. Posting it, including through a chat or incident-management connector, requires explicit authorization for that post (or a standing authorization the user gave for this incident's channel).
- External or customer-facing notices are out of scope for this post. Draft one only on explicit request, clearly labelled `draft for approval`, and flag that it should go through the organization's communications review.
