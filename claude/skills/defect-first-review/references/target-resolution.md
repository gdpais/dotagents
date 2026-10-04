# Target resolution

How to pin down exactly what a review covers. The goal is the diff that would actually land, read without changing the user's repository.

## Contents

- Base branch
- Uncommitted work
- Commit
- Pull request
- Pasted diff or patch
- Custom instructions only
- What never to do

## Base branch

Rule (from the review-agent discipline):

1. If `<branch>` resolves locally and has an upstream that is **ahead** of it, compare against the upstream. Otherwise compare against the local branch.
2. If `<branch>` does not resolve locally, try its configured upstream (`branch.<name>.remote` + `branch.<name>.merge`), then `<remote>/<branch>` for each remote (origin first), before reporting the target unavailable.
3. `git merge-base HEAD <comparison-ref>` → review `git diff <merge-base-sha>`.

`git diff <merge-base>` compares the merge base with the **working tree**, so uncommitted edits on the feature branch are included. Untracked files are not in that diff; read them separately (the helper lists them).

Helper:

```
bun <skill-dir>/scripts/resolve_review_target.ts -C <repo> --base main
```

Equivalent by hand:

```
git rev-parse --verify main
git rev-parse --abbrev-ref --symbolic-full-name main@{upstream}   # e.g. origin/main
git rev-list --count main..origin/main                            # >0 means upstream is ahead
git merge-base HEAD <comparison-ref>
git diff --stat <merge-base>; git diff <merge-base>
git ls-files --others --exclude-standard
```

Stale remote refs: the helper never fetches. If the remote-tracking ref may be stale (for example, the user says main moved today), say so in the coverage note, or run `git fetch <remote> <branch>` only with the user's agreement — fetch updates remote-tracking refs but never the working tree or local branches.

## Uncommitted work

```
bun <skill-dir>/scripts/resolve_review_target.ts -C <repo> --uncommitted
git diff HEAD            # staged + unstaged
git diff --cached        # staged only, if the user asked for "what I'm about to commit"
git ls-files --others --exclude-standard   # untracked: read each file whole
```

In a repository with no commits yet, the helper falls back to `git diff --cached`.

## Commit

```
bun <skill-dir>/scripts/resolve_review_target.ts -C <repo> --commit <rev>
git diff <parent> <sha>        # or: git show --root <sha> for a root commit
```

For a merge commit, the helper diffs against the first parent (what the merge brought into the mainline). Say so in the coverage note. For a range (`A..B`), review `git diff $(git merge-base A B) B`.

## Pull request

With the source-control connector attached, use its capabilities to read: PR metadata (title, body, base ref, head SHA, linked issues), the file list, the unified diff, and file contents at the head SHA. Describe connector calls by capability; tool names vary by connector.

With `gh` available and authenticated:

```
gh pr view <n|url> --json number,title,body,baseRefName,headRefName,headRefOid,files,isCrossRepository
gh pr diff <n|url>
```

To read head versions of files and call sites without touching the working tree:

```
git fetch <remote> pull/<n>/head        # GitHub; updates FETCH_HEAD only
git show <headRefOid>:path/to/file
git grep -n <symbol> <headRefOid> -- <paths>
git merge-base <headRefOid> <remote>/<baseRefName>
```

Fetching the PR ref writes only to `.git` (FETCH_HEAD, objects). If the user has not asked for any git operations and you are unsure they would want even that, ask once; otherwise work from `gh pr diff` alone and mark verification of callers outside the diff as limited.

Never `gh pr checkout` or `git checkout` the PR over the user's working tree. If a full checkout is truly needed, suggest a separate worktree and let the user decide.

With neither connector nor `gh`: ask for the diff (or a local branch), or review the pasted patch.

## Pasted diff or patch

Use it as given. If the matching repository is available locally, read the pre-image files and their callers there (do not apply the patch to the user's tree). If not, verification is limited to the hunks shown:

- Findings that depend on callers outside the diff are at most `plausible`, with the missing caller named as the gap.
- State the limit in the coverage note.

## Custom instructions only

"Review the error handling in the new retry module" with no diff: resolve to the smallest real target that contains it (usually uncommitted work or branch vs base) and confirm the scope in the coverage note. If there is no change at all, this is not a change review — say so and suggest `engineering:tech-debt` or an ordinary code read.

## What never to do

- `git checkout`, `switch`, `reset`, `stash`, `rebase`, `commit`, `push`, `gh pr checkout`, `gh pr review`, `gh pr merge` — none belong to a review.
- Diffing against the base branch tip (`git diff main`) — it shows changes that landed on main since the branch point as if the author had reverted them.
