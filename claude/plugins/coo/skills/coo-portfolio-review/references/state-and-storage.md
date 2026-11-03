# State and storage

The COO workspace lives inside the project the review is invoked from (the user's choice: reviews belong with the project where they are run). Other reviewed projects never receive workflow files. Project files remain authoritative for their technical and planning state.

## Where the workspace lives

The workspace is a `coo/` directory at the root of the invoking project:

- **Claude Code**: `$(git rev-parse --show-toplevel)/coo` when the working directory is in a Git repository, otherwise `<working directory>/coo`.
- **Cowork**: `coo/` at the root of the connected folder for the project the user is working in. The device shell sees it under its mount (for example `$HOME/mnt/<folder-name>/coo`); record the user's own path for the project in `CONFIG.md` so later sessions can find and reconnect it. If several folders are connected and the invoking project is unclear, ask once.

Each project's workspace is independent: its own `CONFIG.md`, reviews, `D-NNN` and `K-NNN` sequences, `STATE.json` and lock. Never read, write or continue another project's `coo/` as if it were this one. A review invoked from project A may still cover projects B and C when A's `CONFIG.md` lists them; those projects stay read-only.

Because the workspace sits inside a reviewed project, exclude `coo/` from that project's revision, working-tree and fingerprint checks. If the project uses Git, suggest (do not make) a `.gitignore` entry for `coo/.run-lock/` and `coo/.released-locks/`; whether to commit reviews and decisions is the user's choice.

Do not keep the workspace in an ephemeral cloud container, in Claude memory, in a claude.ai Project, or in an Artifact database: none of these gives the atomic create-exclusive primitive the lock needs, and the first two are not durable or are about the user rather than the portfolio. If only an ephemeral location is available, run a read-only review, present it, and say that no review state was persisted.

Create the workspace only when implementing or running the workflow in an authorized location. Do not prepopulate project conclusions.

## Layout

```text
coo/
|-- CONFIG.md
|-- CURRENT.md
|-- STATE.json
|-- KNOWLEDGE_QUEUE.md
|-- reviews/
|   `-- YYYY-MM-DD-NN.md
|-- decisions/
|   `-- D-NNN-short-title.md
|-- .run-lock/            (transient; exists only while a coordinator runs)
|   `-- owner.json
`-- .released-locks/      (only if the delete fallback was needed)
```


## Workspace run lock

Use atomic directory creation of `coo/.run-lock` as the local workspace lock before reading mutable review state or allocating IDs. Never use `mkdir -p` to acquire it: success must mean this coordinator created the directory. Only the successful creator owns the lock. Save `owner.json` inside with a unique owner token, run ID, task/session identifier, host, and acquisition timestamp. If writing ownership metadata fails, the creator cleans up its own lock and aborts the run.

An existing lock blocks another coordinator from reading a mutable baseline, allocating IDs, updating local COO records or writing Linear. Report its recorded owner. Age alone is not proof the owner has stopped. Recover an abandoned lock only after verifying the owning task has terminated or obtaining explicit recovery direction from the user; an absent or unreadable owner file is not permission to steal the lock.

On completion, error or a pause awaiting user input, verify the owner token still matches, remove only that owner's metadata and remove the empty lock directory. Do not recursively delete it. If the environment does not permit deletion in the workspace folder, use the release fallback in the Claude runtime reference (an atomic rename out of the lock path) rather than leaving the lock held. On resume, reacquire the lock and reload current state. Subagents never acquire, release or modify the coordinator's lock.

This lock coordinates cooperating runs using the same local workspace. It does not lock Linear against human changes or coordinate separate copies on different hosts (including copies kept in sync by a cloud file-sync service); the Linear pre-write checks remain required.

## File ownership

### CONFIG.md

Human-maintained scope and routing. Record project name, path or project identifier (the user's own path; note whether it is a connected folder, a local path, or a remote repo), inclusion state, relevant evidence locations, Linear workspace/project/team mapping, and project-specific boundaries. The workflow may propose configuration changes but should not silently broaden its scope.

### CURRENT.md

Latest factual portfolio view. Keep it compact and replace its project state after a successful inspection. For every project include the last successful inspection time, evidence freshness, current health, milestone, blockers, and links to the supporting review. Keep pending recommendations visibly separate from observed state. List proposed and deferred decisions with their IDs, links, and revisit conditions.

### STATE.json

Machine-maintained incremental checkpoint. It is an optimization, not an authority, and must be rebuildable from project sources and reviews. Use a versioned structure similar to:

```json
{
  "version": 1,
  "last_review": "coo/reviews/2026-09-18-01.md",
  "projects": {
    "heartbeat": {
      "last_successful_inspection": "2026-09-18T10:30:00+01:00",
      "revision": "full-revision-if-available",
      "working_tree_fingerprint": "implementation-defined",
      "linear_project_id": "stable-linear-id-if-configured",
      "tracked_sources": {
        "TODO.md": {
          "fingerprint": "implementation-defined",
          "modified_at": "2026-09-18T09:14:00+01:00"
        }
      },
      "open_finding_ids": ["F-004"],
      "knowledge_candidate_ids": ["K-002"]
    }
  },
  "runs": {
    "2026-09-18-01": {
      "status": "completed | awaiting_decision | failed",
      "linear_status_updates": {
        "status-update-id": {
          "project_id": "stable-linear-id",
          "last_written_fingerprint": "sha256-of-body-this-run-wrote"
        }
      }
    }
  }
}
```

The `runs` block is what lets a resumed run reuse its run ID and prove ownership of a status update it created. Keep only recent or unresolved runs there. Store metadata, stable identifiers, and fingerprints only. Do not store secrets, full file contents, logs, private calendar details, or conversation transcripts. Write the checkpoint atomically when practical (write a temporary file in the same directory, then rename it over the old one). If inspection fails, retain the last successful checkpoint and record the failure in the dated review.

### KNOWLEDGE_QUEUE.md

Persistent queue of unreviewed, accepted-for-review, promoted, deferred, or discarded knowledge candidates. Deduplicate using source work, subject, destination, and existing candidate identifiers. Capturing a candidate does not authorize changes to its suggested destination.

### reviews/

One immutable historical snapshot per run. Use `YYYY-MM-DD-01.md`, incrementing the suffix for additional reviews that day; the file stem is the run ID. Append a dated correction when a material factual error is found; do not rewrite history to match later knowledge. A run paused for a decision and later resumed completes the same review file, appending the resumed section with its timestamp.

### decisions/

Create a record for each consequential proposed decision, using `D-NNN` allocated under the workspace lock by checking existing decision records. Never reuse an ID. Before creating a record, check unresolved decisions for the same choice; update or reference the existing record instead of duplicating it.

Include the originating review path, proposal date, affected projects, current status, and dated status history. Statuses are proposed, accepted, rejected, deferred, or superseded. Carry proposed and deferred choices forward in `CURRENT.md` and relevant reviews with their original IDs and links. Deferral must retain its revisit condition; do not silently accept or expire a decision. Later resolution updates the same record and appends the user's decision source/date. Superseding a choice links both records and preserves prior rationale. Start with one folder; add project subfolders only when volume justifies them.

## Incremental comparison

Use the cheapest reliable signals first:

1. Project accessibility and identity (is the folder or repo reachable, is it the configured project).
2. Revision and working-tree status when Git is available in that shell.
3. Configured planning and documentation file changes.
4. Open findings, unresolved decisions, and evidence freshness.
5. Focused content inspection where a signal changed or is inconclusive.

Do not equate an unchanged Git revision with an unchanged project. Account for uncommitted files, generated evidence, external blockers, and non-Git projects. When timestamps alone are unreliable (connected and synced folders can rewrite modification times), use a content fingerprint for configured sources.
