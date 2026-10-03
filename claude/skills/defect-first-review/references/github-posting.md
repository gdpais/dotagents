# Publishing review comments

Only when the user explicitly asks. A review is complete without publishing.

## Authorization

- Clear instruction ("post these on PR 1234", "leave inline comments") → authorized for that PR and those findings. Do not re-ask per comment.
- Ambiguous ("put this on the PR?", "share with the author") → show the exact comments as a draft, then post on confirmation.
- Approve / request changes / merge / close / label / assign → only when the user names that action. Default review event is `COMMENT`.
- Never push commits, suggested-change commits, or branches as part of publishing.

## What to post

- Only findings that passed verification, one inline comment per finding, anchored to a line in the PR head that the diff contains (the right side of the diff). If the cited line is not commentable (for example, outside any hunk after a rebase), put the finding in the summary comment with its `path:line`.
- Comment body: `[P1] <title>` on the first line, then the scenario paragraph and the evidence line. No confidence jargon beyond `Confidence: plausible (<gap>)` when applicable.
- One summary comment with the assessment, test gaps, residual risks, and a one-line coverage note.
- Do not post "No findings." as an approval; if there are none, post the summary only if asked.

## With the source-control connector

Use its capabilities to: create a pending review on the PR head SHA, add inline comments (path, line, side RIGHT), and submit it with event COMMENT and the summary body. Report the review URL.

## With `gh`

```
# Head SHA the comments anchor to
gh pr view <n> --json headRefOid -q .headRefOid

# One review with inline comments, submitted as COMMENT
gh api repos/{owner}/{repo}/pulls/<n>/reviews \
  --method POST \
  -f commit_id=<headRefOid> \
  -f event=COMMENT \
  -f body="<summary>" \
  -f 'comments[][path]=billing/api/invoices.py' \
  -F 'comments[][line]=42' \
  -f 'comments[][side]=RIGHT' \
  -f 'comments[][body]=[P1] Scope the invoice lookup to the caller'"'"'s tenant ...'
```

For many comments, build the JSON payload in a temp file and pass `--input <file>` instead of repeated flags. `{owner}` and `{repo}` are filled by `gh` from the current repository.

If the post fails (permissions, stale head SHA), report the error, keep the drafted comments in the reply, and do not retry with broader permissions or a different account.

## Without either

Return ready-to-paste comments grouped by file with `path:line` headers, plus the summary comment.
