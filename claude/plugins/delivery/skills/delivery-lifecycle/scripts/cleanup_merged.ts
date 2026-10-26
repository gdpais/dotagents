#!/usr/bin/env bun
/**
 * Clean up after merged pull requests in one deterministic pass, so the agent doesn't
 * re-derive the git steps every time.
 *
 *   1. `git fetch --prune <remote>`
 *   2. fast-forward the local base branch to <remote>/<base> (never a merge commit or reset)
 *   3. pick the merged branches: ones whose remote branch is gone (the PR merged and the host
 *      deleted it), or the names given on the command line
 *   4. for each, when its tip is contained in <remote>/<base>: remove its worktree (only a clean,
 *      unlocked, linked one that you are not in) and delete it with `git branch -d`
 *   5. `git worktree prune` for entries whose directory is already gone
 *
 * Never deletes unmerged work: a gone branch that isn't contained in <remote>/<base>
 * (squash-merged or closed) is kept and reported, as is any dirty or locked worktree.
 *
 * Usage: cleanup_merged.ts [-C PATH] [--base BRANCH] [--remote NAME] [--dry-run] [--json] [BRANCH...]
 *   --base      default: autonomy.base in .claude/delivery.json, else <remote>/HEAD, else main/master
 *   --dry-run   fetches (remote-tracking refs only) but changes no local branch or worktree
 * Exit: 0 done (kept branches are reported, not errors), 2 usage error, not a repository or fetch failed.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, parseAutonomy } from "../../../hooks/autonomy";

export interface Worktree { path: string; branch: string | null; locked: boolean; main: boolean }
export interface Cleanup {
  base: string; remote: string; dryRun: boolean;
  pruned: number;
  baseUpdate: { status: "updated" | "current" | "skipped"; from?: string; to?: string; reason?: string };
  removedWorktrees: string[];
  deleted: { branch: string; sha: string }[];
  kept: { branch: string; reason: string }[];
  prunedWorktrees: number;
}

const git = (args: string[], cwd: string) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};
const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.replace(/^(error|fatal|hint):\s*/, "") ?? "unknown error";
const short = (sha: string) => sha.slice(0, 7);

/** `git worktree list --porcelain`, main worktree first. */
export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain.split(/\n\n+/).filter((b) => b.trim()).map((block, i) => {
    const lines = block.split("\n");
    const val = (k: string) => lines.find((l) => l === k || l.startsWith(`${k} `))?.slice(k.length + 1);
    const branch = val("branch");
    return { path: val("worktree") ?? "", branch: branch ? branch.replace(/^refs\/heads\//, "") : null, locked: lines.some((l) => l === "locked" || l.startsWith("locked ")), main: i === 0 };
  });
}

/** Branch names under refs/heads from `git ls-remote --heads` output. */
export function remoteHeads(lsRemote: string): Set<string> {
  return new Set(lsRemote.split("\n").map((l) => l.split("\t")[1]?.replace(/^refs\/heads\//, "")).filter((b): b is string => !!b));
}

/** True when `inner` is `outer` or inside it. */
export const within = (inner: string, outer: string) => { const r = relative(outer, inner); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

function defaultBase(cwd: string, remote: string): string {
  const configured = parseAutonomy(loadConfig(cwd))?.base;
  if (configured) return configured;
  const head = git(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], cwd);
  if (head.ok && head.out) return head.out.replace(new RegExp(`^${remote}/`), "");
  for (const b of ["main", "master"]) if (git(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${b}`], cwd).ok) return b;
  return "main";
}

export function cleanupMerged(cwd: string, opts: { base?: string; remote?: string; branches?: string[]; dryRun?: boolean } = {}): Cleanup | string {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok) return "not a git repository";
  const remote = opts.remote ?? "origin";
  const dry = !!opts.dryRun;
  const fetch = git(["fetch", "--prune", remote], cwd);
  if (!fetch.ok) return `git fetch --prune ${remote} failed: ${firstLine(fetch.err)}`;
  const base = opts.base ?? defaultBase(cwd, remote);
  const target = `refs/remotes/${remote}/${base}`;
  const tip = git(["rev-parse", "--verify", "--quiet", target], cwd);
  if (!tip.ok) return `${remote}/${base} not found`;

  const res: Cleanup = { base, remote, dryRun: dry, pruned: (fetch.err.match(/\[deleted\]/g) ?? []).length, baseUpdate: { status: "current" }, removedWorktrees: [], deleted: [], kept: [], prunedWorktrees: 0 };
  const worktrees = parseWorktrees(git(["worktree", "list", "--porcelain"], cwd).out);
  const mainWt = worktrees.find((w) => w.main)!;
  const here = realpathSync(cwd); // git reports real paths (/private/var/… on macOS)

  // 2. Fast-forward the local base wherever it lives.
  const baseWt = worktrees.find((w) => w.branch === base);
  const local = git(["rev-parse", "--verify", "--quiet", `refs/heads/${base}`], cwd);
  if (local.ok && local.out === tip.out) res.baseUpdate = { status: "current" };
  else if (local.ok && !git(["merge-base", "--is-ancestor", local.out, tip.out], cwd).ok) res.baseUpdate = { status: "skipped", reason: `local ${base} has commits not on ${remote}/${base}` };
  else if (dry) res.baseUpdate = { status: "updated", from: local.ok ? short(local.out) : undefined, to: short(tip.out) };
  else {
    const ff = baseWt ? git(["merge", "--ff-only", "--quiet", target], baseWt.path) : git(["fetch", "--quiet", ".", `${target}:refs/heads/${base}`], cwd);
    res.baseUpdate = ff.ok ? { status: "updated", from: local.ok ? short(local.out) : undefined, to: short(tip.out) } : { status: "skipped", reason: firstLine(ff.err) };
  }

  // 3. Candidates: named branches, else pushed branches whose remote branch no longer exists.
  const locals = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd).out.split("\n").filter(Boolean);
  let candidates: string[];
  if (opts.branches?.length) {
    candidates = opts.branches.filter((b) => locals.includes(b));
    for (const b of opts.branches) if (!locals.includes(b)) res.kept.push({ branch: b, reason: "no such local branch" });
  } else {
    const heads = new Map<string, Set<string> | null>();
    candidates = locals.filter((b) => {
      if (b === base) return false;
      const r = git(["config", "--get", `branch.${b}.remote`], cwd).out;
      const merge = git(["config", "--get", `branch.${b}.merge`], cwd).out.replace(/^refs\/heads\//, "");
      if (!r || !merge || r === ".") return false; // never pushed: not ours to judge
      if (!heads.has(r)) { const ls = git(["ls-remote", "--heads", r], cwd); heads.set(r, ls.ok ? remoteHeads(ls.out) : null); }
      const set = heads.get(r);
      if (!set) { res.kept.push({ branch: b, reason: `couldn't list branches on ${r}` }); return false; }
      return !set.has(merge);
    });
  }

  // 4. Remove worktree + delete branch for each merged candidate.
  for (const b of candidates) {
    if (b === base) { res.kept.push({ branch: b, reason: "it is the base branch" }); continue; }
    const sha = git(["rev-parse", `refs/heads/${b}`], cwd).out;
    if (!git(["merge-base", "--is-ancestor", sha, tip.out], cwd).ok) { res.kept.push({ branch: b, reason: `not merged into ${remote}/${base} (squash-merged or closed?); delete it by hand if intended` }); continue; }
    const wt = worktrees.find((w) => w.branch === b);
    if (wt) {
      if (wt.main) { res.kept.push({ branch: b, reason: `checked out in the main checkout; switch it to ${base} and rerun` }); continue; }
      if (wt.locked) { res.kept.push({ branch: b, reason: `worktree is locked (${wt.path})` }); continue; }
      if (within(here, wt.path)) { res.kept.push({ branch: b, reason: `you are inside its worktree (${wt.path}); rerun from the main checkout` }); continue; }
      const status = git(["status", "--porcelain"], wt.path);
      if (!status.ok || status.out) { res.kept.push({ branch: b, reason: `worktree has uncommitted or untracked files (${wt.path})` }); continue; }
      if (!dry) {
        const rm = git(["worktree", "remove", wt.path], mainWt.path);
        if (!rm.ok) { res.kept.push({ branch: b, reason: `git worktree remove failed: ${firstLine(rm.err)}` }); continue; }
      }
      res.removedWorktrees.push(wt.path);
    }
    if (!dry) {
      // Run from the base's worktree so `-d` checks against the freshly updated base.
      const del = git(["branch", "-d", b], baseWt?.path ?? mainWt.path);
      if (!del.ok) { res.kept.push({ branch: b, reason: `git branch -d refused: ${firstLine(del.err)}` }); continue; }
    }
    res.deleted.push({ branch: b, sha: short(sha) });
  }

  // 5. Admin entries for worktree directories that were deleted by hand.
  const prune = git(["worktree", "prune", "--dry-run", "--verbose"], cwd);
  res.prunedWorktrees = prune.out.split("\n").concat(prune.err.split("\n")).filter((l) => /^Removing /.test(l)).length;
  if (!dry && res.prunedWorktrees) git(["worktree", "prune"], cwd);
  return res;
}

export function render(c: Cleanup, root: string): string {
  const rel = (p: string) => (within(p, root) ? relative(root, p) || "." : p);
  const tag = c.dryRun ? " (dry run: nothing changed)" : "";
  const [ok, would] = c.dryRun ? ["~", "would be "] : ["✓", ""];
  const lines = [`cleanup-merged · base ${c.base} (${c.remote})${tag}`, `✓ fetched ${c.remote}${c.pruned ? `, pruned ${c.pruned} remote branch(es)` : ""}`];
  const u = c.baseUpdate;
  lines.push(u.status === "updated" ? `${ok} ${c.base} ${would}fast-forwarded ${u.from ?? "(new)"}..${u.to}` : u.status === "current" ? `✓ ${c.base} already up to date` : `! ${c.base} not updated: ${u.reason}`);
  for (const w of c.removedWorktrees) lines.push(`${ok} ${would}removed worktree ${rel(w)}`);
  for (const d of c.deleted) lines.push(`${ok} ${would}deleted ${d.branch} (was ${d.sha})`);
  for (const k of c.kept) lines.push(`· kept ${k.branch}: ${k.reason}`);
  if (c.prunedWorktrees) lines.push(`${ok} ${would}pruned ${c.prunedWorktrees} stale worktree entr${c.prunedWorktrees === 1 ? "y" : "ies"}`);
  if (!c.deleted.length && !c.kept.length) lines.push("· no merged branches to clean up");
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)): number {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      help: { type: "boolean", short: "h" }, C: { type: "string", short: "C" }, base: { type: "string" }, remote: { type: "string" },
      "dry-run": { type: "boolean" }, json: { type: "boolean" } } }));
  } catch (e) { console.error((e as Error).message); return 2; }
  if (values.help) { console.log("usage: cleanup_merged.ts [-C PATH] [--base BRANCH] [--remote NAME] [--dry-run] [--json] [BRANCH...]"); return 0; }
  const cwd = resolve(values.C ?? process.cwd());
  const c = cleanupMerged(cwd, { base: values.base, remote: values.remote, branches: positionals, dryRun: values["dry-run"] });
  if (typeof c === "string") { console.log(values.json ? JSON.stringify({ error: c }) : `cleanup-merged: error: ${c}`); return 2; }
  console.log(values.json ? JSON.stringify(c, null, 2) : render(c, git(["rev-parse", "--show-toplevel"], cwd).out || cwd));
  return 0;
}

if (import.meta.main) process.exit(main());
