/**
 * Tests for scripts/cleanup_merged.ts. Run with `bun test` from the skill folder.
 * Each test builds a bare "origin", a working clone ("repo") and a second clone ("other")
 * that merges PRs on the remote side, so the working clone is behind like after a real merge.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupMerged, parseWorktrees, remoteHeads, render, within, type Cleanup } from "../scripts/cleanup_merged";

// Passed explicitly: Bun.spawnSync doesn't see process.env changes, and CI runners have no git identity.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};

let root: string, origin: string, repo: string, other: string;
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
const commit = (cwd: string, msg: string) => {
  writeFileSync(join(cwd, `${msg.replace(/\W+/g, "-")}.txt`), msg);
  sh(cwd, "add", ".");
  sh(cwd, "commit", "-q", "-m", msg);
};
const has = (b: string) => Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${b}`], { cwd: repo, env: GIT_ENV }).exitCode === 0;

/** A feature branch pushed from `repo` with its own commit. */
const pushBranch = (b: string, upstream = "origin") => {
  sh(repo, "switch", "-q", "-c", b, "master");
  commit(repo, `feat: ${b}`);
  sh(repo, "push", "-q", "-u", upstream, b);
  sh(repo, "switch", "-q", "master");
};
/** What the host does when a PR merges: merge commit on master, then delete the head branch. */
const mergeOnRemote = (b: string, del = true) => {
  sh(other, "fetch", "-q", "origin");
  sh(other, "merge", "-q", "--no-ff", "-m", `Merge ${b}`, `origin/${b}`);
  sh(other, "push", "-q", "origin", "master");
  if (del) sh(other, "push", "-q", "origin", "--delete", b);
};
const run = (opts = {}) => cleanupMerged(repo, opts) as Cleanup;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cleanup-merged-")));
  origin = join(root, "origin.git"); repo = join(root, "repo"); other = join(root, "other");
  sh(root, "init", "-q", "--bare", "-b", "master", origin);
  sh(root, "clone", "-q", origin, repo);
  commit(repo, "chore: init");
  sh(repo, "push", "-q", "-u", "origin", "master");
  sh(root, "clone", "-q", origin, other);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("merged + gone: fast-forwards base, removes the clean worktree, deletes the branch", () => {
  pushBranch("feature/a");
  const wt = join(repo, ".claude", "worktrees", "a");
  sh(repo, "worktree", "add", "-q", wt, "feature/a");
  mergeOnRemote("feature/a");
  const c = run();
  expect(c.baseUpdate.status).toBe("updated");
  expect(sh(repo, "rev-parse", "master")).toBe(sh(repo, "rev-parse", "origin/master"));
  expect(c.removedWorktrees).toEqual([wt]);
  expect(c.deleted.map((d) => d.branch)).toEqual(["feature/a"]);
  expect(existsSync(wt)).toBe(false);
  expect(has("feature/a")).toBe(false);
  expect(c.kept).toEqual([]);
});

test("keeps unmerged, dirty, alive and never-pushed branches", () => {
  pushBranch("feature/squashed");          // remote deleted without a merge (squash or closed)
  sh(other, "push", "-q", "origin", "--delete", "feature/squashed");
  pushBranch("feature/dirty");
  const wt = join(root, "wt-dirty");
  sh(repo, "worktree", "add", "-q", wt, "feature/dirty");
  writeFileSync(join(wt, "wip.txt"), "uncommitted");
  mergeOnRemote("feature/dirty");
  pushBranch("feature/alive");             // merged but the remote branch still exists
  mergeOnRemote("feature/alive", false);
  sh(repo, "branch", "feature/local-only");

  const c = run();
  expect(c.deleted).toEqual([]);
  const kept = Object.fromEntries(c.kept.map((k) => [k.branch, k.reason]));
  expect(kept["feature/squashed"]).toContain("not merged into origin/master");
  expect(kept["feature/dirty"]).toContain("uncommitted or untracked");
  expect(Object.keys(kept).sort()).toEqual(["feature/dirty", "feature/squashed"]);
  for (const b of ["feature/squashed", "feature/dirty", "feature/alive", "feature/local-only"]) expect(has(b)).toBe(true);
  expect(existsSync(join(wt, "wip.txt"))).toBe(true);
});

test("branch whose remote is a URL (https fallback push) is still detected", () => {
  pushBranch("feature/url", origin);       // branch.<b>.remote is the path, not "origin"
  mergeOnRemote("feature/url");
  const c = run();
  expect(c.deleted.map((d) => d.branch)).toEqual(["feature/url"]);
});

test("named branches are cleaned when merged, even if the remote branch is alive", () => {
  pushBranch("feature/named");
  mergeOnRemote("feature/named", false);
  const c = run({ branches: ["feature/named", "feature/missing"] });
  expect(c.deleted.map((d) => d.branch)).toEqual(["feature/named"]);
  expect(c.kept).toEqual([{ branch: "feature/missing", reason: "no such local branch" }]);
});

test("dry run changes nothing", () => {
  pushBranch("feature/a");
  const wt = join(root, "wt-a");
  sh(repo, "worktree", "add", "-q", wt, "feature/a");
  mergeOnRemote("feature/a");
  const before = sh(repo, "rev-parse", "master");
  const c = run({ dryRun: true });
  expect(c.deleted.map((d) => d.branch)).toEqual(["feature/a"]);
  expect(c.removedWorktrees).toEqual([wt]);
  expect(sh(repo, "rev-parse", "master")).toBe(before);
  expect(has("feature/a")).toBe(true);
  expect(existsSync(wt)).toBe(true);
  expect(render(c, repo)).toContain("dry run: nothing changed");
  expect(render(c, repo)).toContain("~ would be deleted feature/a");
});

test("won't remove the worktree it runs from, or the main checkout's branch", () => {
  pushBranch("feature/here");
  const wt = join(root, "wt-here");
  sh(repo, "worktree", "add", "-q", wt, "feature/here");
  pushBranch("feature/main");
  mergeOnRemote("feature/here");
  mergeOnRemote("feature/main");
  sh(repo, "switch", "-q", "feature/main");
  const c = cleanupMerged(wt) as Cleanup;
  const kept = Object.fromEntries(c.kept.map((k) => [k.branch, k.reason]));
  expect(kept["feature/here"]).toContain("you are inside its worktree");
  expect(kept["feature/main"]).toContain("checked out in the main checkout");
  expect(has("feature/here") && has("feature/main")).toBe(true);
});

test("base with local-only commits is not touched; stale worktree entries are pruned", () => {
  commit(repo, "local: unpushed");
  commit(other, "remote: ahead");
  sh(other, "push", "-q", "origin", "master");
  const wt = join(root, "wt-gone");
  sh(repo, "worktree", "add", "-q", "-b", "scratch", wt);
  rmSync(wt, { recursive: true, force: true });
  const c = run();
  expect(c.baseUpdate).toMatchObject({ status: "skipped" });
  expect(c.prunedWorktrees).toBe(1);
  expect(sh(repo, "worktree", "list")).not.toContain("wt-gone");
});

test("errors: not a repository, unreachable remote", () => {
  expect(cleanupMerged(root)).toBe("not a git repository");
  sh(repo, "remote", "set-url", "origin", join(root, "nope.git"));
  expect(String(cleanupMerged(repo))).toContain("git fetch --prune origin failed");
});

test("parsers", () => {
  const wts = parseWorktrees("worktree /r\nHEAD abc\nbranch refs/heads/master\n\nworktree /r/w\nHEAD def\nbranch refs/heads/feature/x\nlocked\n\nworktree /r/d\nHEAD 123\ndetached\n");
  expect(wts).toEqual([
    { path: "/r", branch: "master", locked: false, main: true },
    { path: "/r/w", branch: "feature/x", locked: true, main: false },
    { path: "/r/d", branch: null, locked: false, main: false },
  ]);
  expect([...remoteHeads("abc\trefs/heads/master\ndef\trefs/heads/feature/a\n")]).toEqual(["master", "feature/a"]);
  expect(within("/r/w/sub", "/r/w")).toBe(true);
  expect(within("/r/w2", "/r/w")).toBe(false);
});
