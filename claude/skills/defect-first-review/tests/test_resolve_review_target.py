"""Tests for scripts/resolve_review_target.py.

Run with `python3 -m pytest tests/` or `python3 -m unittest discover -s tests`.
Each test builds throwaway git repositories in a temp directory.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "resolve_review_target.py")

GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
    "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
}


def sh(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, env=GIT_ENV, check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()


def write(cwd, name, text):
    with open(os.path.join(cwd, name), "w") as fh:
        fh.write(text)


def commit(cwd, name, text, msg):
    write(cwd, name, text)
    sh(cwd, "add", name)
    sh(cwd, "commit", "-q", "-m", msg)
    return sh(cwd, "rev-parse", "HEAD")


def run(cwd, *args):
    proc = subprocess.run([sys.executable, SCRIPT, "-C", cwd, *args], env=GIT_ENV,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return proc.returncode, json.loads(proc.stdout)


class ResolveReviewTargetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.origin = os.path.join(self.root, "origin")
        os.makedirs(self.origin)
        sh(self.origin, "init", "-q", "-b", "main")
        self.c0 = commit(self.origin, "a.txt", "one\n", "c0")
        self.work = os.path.join(self.root, "work")
        subprocess.run(["git", "clone", "-q", self.origin, self.work], env=GIT_ENV, check=True)
        sh(self.work, "checkout", "-q", "-b", "feature")
        self.f1 = commit(self.work, "b.txt", "feat\nline2\n", "feature work")

    def tearDown(self):
        self.tmp.cleanup()

    def test_base_uses_local_branch_when_upstream_not_ahead(self):
        code, out = run(self.work, "--base", "main")
        self.assertEqual(code, 0)
        self.assertEqual(out["comparison_ref"], "main")
        self.assertEqual(out["merge_base"], self.c0)
        self.assertEqual([f["path"] for f in out["changed"]], ["b.txt"])
        self.assertEqual(out["totals"], {"files": 1, "added": 2, "deleted": 0})

    def test_base_prefers_upstream_when_ahead(self):
        # origin/main advances and the feature branch is rebased onto it,
        # but local main is stale: the upstream must be used.
        c1 = commit(self.origin, "a.txt", "one\ntwo\n", "c1 on origin")
        sh(self.work, "fetch", "-q", "origin")
        sh(self.work, "rebase", "-q", "origin/main")
        code, out = run(self.work, "--base", "main")
        self.assertEqual(code, 0)
        self.assertEqual(out["comparison_ref"], "origin/main")
        self.assertEqual(out["merge_base"], c1)
        # Only the feature's own file, not origin's a.txt change.
        self.assertEqual([f["path"] for f in out["changed"]], ["b.txt"])

    def test_base_falls_back_to_remote_when_local_branch_missing(self):
        sh(self.origin, "branch", "release")
        sh(self.work, "fetch", "-q", "origin")
        code, out = run(self.work, "--base", "release")
        self.assertEqual(code, 0)
        self.assertEqual(out["comparison_ref"], "origin/release")
        self.assertIn("origin/release", out["tried"])

    def test_base_unresolvable_reports_error(self):
        code, out = run(self.work, "--base", "does-not-exist")
        self.assertEqual(code, 2)
        self.assertIn("error", out)
        self.assertEqual(out["tried"][0], "does-not-exist")

    def test_base_includes_uncommitted_edits_and_untracked(self):
        write(self.work, "a.txt", "one\nlocal edit\n")
        write(self.work, "new.txt", "untracked\n")
        code, out = run(self.work, "--base", "main")
        self.assertEqual(code, 0)
        self.assertEqual(sorted(f["path"] for f in out["changed"]), ["a.txt", "b.txt"])
        self.assertEqual(out["untracked"], ["new.txt"])

    def test_commit_mode(self):
        code, out = run(self.work, "--commit", "HEAD")
        self.assertEqual(code, 0)
        self.assertEqual(out["commit"], self.f1)
        self.assertEqual(out["parent"], self.c0)
        self.assertEqual(out["diff_command"], f"git diff {self.c0} {self.f1}")

    def test_commit_mode_root_commit(self):
        code, out = run(self.work, "--commit", self.c0)
        self.assertEqual(code, 0)
        self.assertIsNone(out["parent"])
        self.assertEqual([f["path"] for f in out["changed"]], ["a.txt"])

    def test_uncommitted_mode(self):
        write(self.work, "b.txt", "feat\nchanged\n")
        sh(self.work, "add", "b.txt")
        write(self.work, "a.txt", "one\nunstaged\n")
        write(self.work, "u.txt", "x\n")
        code, out = run(self.work, "--uncommitted")
        self.assertEqual(code, 0)
        self.assertEqual(sorted(f["path"] for f in out["changed"]), ["a.txt", "b.txt"])
        self.assertEqual(out["untracked"], ["u.txt"])

    def test_script_is_read_only(self):
        before = sh(self.work, "status", "--porcelain=v1", "--branch")
        refs_before = sh(self.work, "for-each-ref")
        run(self.work, "--base", "main")
        run(self.work, "--uncommitted")
        run(self.work, "--commit", "HEAD")
        self.assertEqual(sh(self.work, "status", "--porcelain=v1", "--branch"), before)
        self.assertEqual(sh(self.work, "for-each-ref"), refs_before)

    def test_not_a_repo(self):
        plain = os.path.join(self.root, "plain")
        os.makedirs(plain)
        proc = subprocess.run([sys.executable, SCRIPT, "-C", plain, "--uncommitted"],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                              env={**GIT_ENV, "GIT_CEILING_DIRECTORIES": self.root})
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error", json.loads(proc.stdout))


if __name__ == "__main__":
    unittest.main()
