# Roles and communications reference

Read when recommending roles for a larger incident or choosing a communications form.

## 1. Roles

Role names follow the live report's optional major-incident section:

- **Incident Commander:** coordinates, decides, owns the resolution gate confirmation.
- **Operations:** runs diagnostics and mitigations.
- **Communications:** owns stakeholder updates and the approval path for outbound messages.
- **Responders / subject-matter experts:** as named.

Record the names the user gives. Recommending that roles be designated is allowed, labelled as a proposal; choosing people is not. For a handoff, capture current state, what not to repeat, what to watch, the next owner, and their acknowledgement.

## 2. Communications forms

| Form | Owner | Use for | Key rules |
|---|---|---|---|
| Live report | `incident-live-report` | the shared operational record | not a broadcast; sharing it to a new destination needs authorization |
| Short status post | `incident-live-report` (references/status-post.md) | incident channel, chat, status line | four points: what is happening, who is affected, what is being done, next update time or trigger |
| Structured email | `tech-email` | executives, managers, technical teams | required hierarchy with DETAILS; PT-PT or American English logic |
| External notice | this skill, on explicit request only | customers, partners | draft for approval; no unsupplied impact, cause, ETA, or commitment; organization's comms review |

Every form is a draft until the user authorizes sending it to a specific destination and recipient list.

## 3. Cadence

- Use the organization's update cadence when one is defined.
- Otherwise the live report's `Next update` field carries a time or trigger, proposed for the Incident Commander or user to confirm.
- "Next update" is a promise to communicate again, not an ETA for resolution.
- No scheduled or background posting: the source workflow does not permit scheduling.

## 4. Connectors by capability

| Capability | Read (within the user's access) | Write (explicit authorization only) |
|---|---|---|
| Monitoring | alerts, metrics, dashboards | none expected |
| Incident management | incident record, timeline, responders | create/update incident, page on-call |
| Chat | incident channel history | post updates, create channels |
| Email | existing thread for context | save draft on request; send only when authorized |
| Project tracker | linked tickets | create/update tickets (investigation tickets are owned by `rca-investigation`) |
| Knowledge base / docs | prior incidents, runbooks | publish live report or postmortem |
| Source control, CI/CD | recent changes and deploys | none during the incident without authorization |

Without connectors, work from pasted notes, files, and screenshots, and return portable drafts.
