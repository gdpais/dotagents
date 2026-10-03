#!/usr/bin/env python3
"""Resolve what a defect-first review should diff, without changing the repository.

Read-only: runs only `git rev-parse`, `git config --get`, `git rev-list`,
`git merge-base`, `git diff --numstat`, `git ls-files`, `git remote` and
`git show --numstat`. It never fetches, checks out, commits, or writes files.

Modes (exactly one):
  --base BRANCH     changes that would merge into BRANCH (merge-base diff)
  --commit REV      changes introduced by one commit
  --uncommitted     staged + unstaged changes against HEAD, plus untracked files

Output: one JSON object on stdout. Exit 0 on success, 2 when the target
cannot be resolved (the JSON then carries "error" and "tried").

Base-branch rule (ported from the review-agent discipline):
  1. If BRANCH resolves locally and has an upstream that is ahead of it,
     compare against the upstream; otherwise compare against the local branch.
  2. If BRANCH does not resolve locally, try its configured upstream
     (branch.<name>.remote / branch.<name>.merge), then <remote>/BRANCH for
     each remote (origin first), before reporting the target unavailable.
  3. merge_base = git merge-base HEAD <comparison_ref>; review
     `git diff <merge_base>` (working tree vs merge base, so local edits count).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from typing import Optional


def git(args: list[str], cwd: Optional[str] = None) -> Optional[str]:
    """Run a git command; return stripped stdout, or None on non-zero exit."""
    proc = subprocess.run(
        ["git", *args],
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


def ref_exists(ref: str, cwd: Optional[str]) -> bool:
    return git(["rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"], cwd) is not None


def configured_upstream(branch: str, cwd: Optional[str]) -> Optional[str]:
    remote = git(["config", "--get", f"branch.{branch}.remote"], cwd)
    merge = git(["config", "--get", f"branch.{branch}.merge"], cwd)
    if not remote or not merge:
        return None
    short = merge[len("refs/heads/"):] if merge.startswith("refs/heads/") else merge
    if remote == ".":
        return short
    return f"{remote}/{short}"


def resolve_comparison_ref(branch: str, cwd: Optional[str]) -> tuple[Optional[str], list[str], str]:
    """Return (comparison_ref, tried_refs, reason)."""
    tried: list[str] = [branch]
    if ref_exists(branch, cwd):
        upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", f"{branch}@{{upstream}}"], cwd)
        if upstream and ref_exists(upstream, cwd):
            tried.append(upstream)
            ahead = git(["rev-list", "--count", f"{branch}..{upstream}"], cwd)
            if ahead is not None and int(ahead) > 0:
                return upstream, tried, f"upstream {upstream} is {ahead} commit(s) ahead of local {branch}"
            return branch, tried, f"local {branch} is up to date with or ahead of upstream {upstream}"
        return branch, tried, f"local {branch} has no resolvable upstream"

    candidates: list[str] = []
    cfg = configured_upstream(branch, cwd)
    if cfg:
        candidates.append(cfg)
    remotes = (git(["remote"], cwd) or "").split()
    remotes.sort(key=lambda r: (r != "origin", r))
    candidates.extend(f"{r}/{branch}" for r in remotes)
    for cand in candidates:
        if cand in tried:
            continue
        tried.append(cand)
        if ref_exists(cand, cwd):
            return cand, tried, f"local {branch} not found; using {cand}"
    return None, tried, f"could not resolve {branch} locally or via upstream/remotes"


def numstat_files(raw: Optional[str]) -> list[dict]:
    files = []
    for line in (raw or "").splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        added, deleted, path = parts
        files.append({
            "path": path,
            "added": None if added == "-" else int(added),
            "deleted": None if deleted == "-" else int(deleted),
            "binary": added == "-",
        })
    return files


def totals(files: list[dict]) -> dict:
    return {
        "files": len(files),
        "added": sum(f["added"] or 0 for f in files),
        "deleted": sum(f["deleted"] or 0 for f in files),
    }


def mode_base(branch: str, cwd: Optional[str]) -> tuple[dict, int]:
    ref, tried, reason = resolve_comparison_ref(branch, cwd)
    if ref is None:
        return {"mode": "base", "base": branch, "error": reason, "tried": tried}, 2
    mb = git(["merge-base", "HEAD", ref], cwd)
    if not mb:
        return {"mode": "base", "base": branch, "comparison_ref": ref,
                "error": f"no merge base between HEAD and {ref}", "tried": tried}, 2
    files = numstat_files(git(["diff", "--numstat", mb], cwd))
    untracked = (git(["ls-files", "--others", "--exclude-standard"], cwd) or "").splitlines()
    return {
        "mode": "base",
        "base": branch,
        "comparison_ref": ref,
        "reason": reason,
        "tried": tried,
        "merge_base": mb,
        "diff_command": f"git diff {mb}",
        "untracked": untracked,
        "changed": files,
        "totals": totals(files),
    }, 0


def mode_commit(rev: str, cwd: Optional[str]) -> tuple[dict, int]:
    sha = git(["rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}"], cwd)
    if not sha:
        return {"mode": "commit", "commit": rev, "error": f"cannot resolve commit {rev}", "tried": [rev]}, 2
    parent = git(["rev-parse", "--verify", "--quiet", f"{sha}^"], cwd)
    if parent:
        raw = git(["diff", "--numstat", parent, sha], cwd)
        cmd = f"git diff {parent} {sha}"
    else:
        raw = git(["show", "--numstat", "--format=", "--root", sha], cwd)
        cmd = f"git show --root {sha}"
    files = numstat_files(raw)
    return {
        "mode": "commit",
        "commit": sha,
        "parent": parent,
        "diff_command": cmd,
        "changed": files,
        "totals": totals(files),
    }, 0


def mode_uncommitted(cwd: Optional[str]) -> tuple[dict, int]:
    head = git(["rev-parse", "--verify", "--quiet", "HEAD"], cwd)
    if head:
        files = numstat_files(git(["diff", "--numstat", "HEAD"], cwd))
        cmd = "git diff HEAD"
    else:  # repository with no commits yet
        files = numstat_files(git(["diff", "--numstat", "--cached"], cwd))
        cmd = "git diff --cached"
    untracked = (git(["ls-files", "--others", "--exclude-standard"], cwd) or "").splitlines()
    return {
        "mode": "uncommitted",
        "head": head,
        "diff_command": cmd,
        "untracked": untracked,
        "changed": files,
        "totals": totals(files),
    }, 0


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--base", metavar="BRANCH")
    group.add_argument("--commit", metavar="REV")
    group.add_argument("--uncommitted", action="store_true")
    ap.add_argument("-C", dest="cwd", default=None, help="repository path (default: current directory)")
    args = ap.parse_args(argv)

    if git(["rev-parse", "--is-inside-work-tree"], args.cwd) != "true":
        print(json.dumps({"error": "not inside a git work tree"}))
        return 2

    if args.base:
        result, code = mode_base(args.base, args.cwd)
    elif args.commit:
        result, code = mode_commit(args.commit, args.cwd)
    else:
        result, code = mode_uncommitted(args.cwd)
    print(json.dumps(result, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
