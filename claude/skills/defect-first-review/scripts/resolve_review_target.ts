#!/usr/bin/env bun
/**
 * Resolve what a defect-first review should diff, without changing the repository.
 *
 * Read-only: runs only `git rev-parse`, `git config --get`, `git rev-list`,
 * `git merge-base`, `git diff --numstat`, `git ls-files`, `git remote` and
 * `git show --numstat`. It never fetches, checks out, commits, or writes files.
 * Independent git commands run concurrently.
 *
 * Modes (exactly one):
 *   --base BRANCH     changes that would merge into BRANCH (merge-base diff)
 *   --commit REV      changes introduced by one commit
 *   --uncommitted     staged + unstaged changes against HEAD, plus untracked files
 *
 * Output: one JSON object on stdout. Exit 0 on success, 2 when the target
 * cannot be resolved (the JSON then carries "error" and "tried").
 *
 * Base-branch rule (ported from the review-agent discipline):
 *   1. If BRANCH resolves locally and has an upstream that is ahead of it,
 *      compare against the upstream; otherwise compare against the local branch.
 *   2. If BRANCH does not resolve locally, try its configured upstream
 *      (branch.<name>.remote / branch.<name>.merge), then <remote>/BRANCH for
 *      each remote (origin first), before reporting the target unavailable.
 *   3. merge_base = git merge-base HEAD <comparison_ref>; review
 *      `git diff <merge_base>` (working tree vs merge base, so local edits count).
 */
import { writeSync } from "node:fs";
import { parseArgs } from "node:util";

type Cwd = string | undefined;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const WS = "[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const EDGES = new RegExp(`^${WS}+|${WS}+$`, "g");
const strip = (text: string) => text.replace(EDGES, "");
const splitlines = (text: string) => {
  const lines = text ? text.split(/\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/) : [];
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Run a git command; return stripped stdout, or null on non-zero exit. */
export async function git(args: string[], cwd: Cwd): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? strip(out) : null;
  } catch {
    return null; // e.g. -C path does not exist
  }
}

const refExists = async (ref: string, cwd: Cwd) => (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)) !== null;

async function configuredUpstream(branch: string, cwd: Cwd): Promise<string | null> {
  const [remote, merge] = await Promise.all([
    git(["config", "--get", `branch.${branch}.remote`], cwd),
    git(["config", "--get", `branch.${branch}.merge`], cwd),
  ]);
  if (!remote || !merge) return null;
  const short = merge.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : merge;
  return remote === "." ? short : `${remote}/${short}`;
}

/** Return [comparison_ref, tried_refs, reason]. */
export async function resolveComparisonRef(branch: string, cwd: Cwd): Promise<[string | null, string[], string]> {
  const tried = [branch];
  const [exists, upstream] = await Promise.all([
    refExists(branch, cwd),
    git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`], cwd),
  ]);
  if (exists) {
    if (upstream) {
      const [upstreamExists, ahead] = await Promise.all([refExists(upstream, cwd), git(["rev-list", "--count", `${branch}..${upstream}`], cwd)]);
      if (upstreamExists) {
        tried.push(upstream);
        if (ahead !== null && parseInt(ahead, 10) > 0) return [upstream, tried, `upstream ${upstream} is ${ahead} commit(s) ahead of local ${branch}`];
        return [branch, tried, `local ${branch} is up to date with or ahead of upstream ${upstream}`];
      }
    }
    return [branch, tried, `local ${branch} has no resolvable upstream`];
  }

  const [configured, remoteList] = await Promise.all([configuredUpstream(branch, cwd), git(["remote"], cwd)]);
  const remotes = (remoteList ?? "").split(/\s+/).filter(Boolean);
  remotes.sort((a, b) => Number(a !== "origin") - Number(b !== "origin") || (a < b ? -1 : a > b ? 1 : 0));
  const candidates: string[] = [];
  for (const cand of [...(configured ? [configured] : []), ...remotes.map((r) => `${r}/${branch}`)]) {
    if (!tried.includes(cand) && !candidates.includes(cand)) candidates.push(cand);
  }
  const found = await Promise.all(candidates.map((c) => refExists(c, cwd)));
  for (let i = 0; i < candidates.length; i++) {
    tried.push(candidates[i]);
    if (found[i]) return [candidates[i], tried, `local ${branch} not found; using ${candidates[i]}`];
  }
  return [null, tried, `could not resolve ${branch} locally or via upstream/remotes`];
}

interface FileStat { path: string; added: number | null; deleted: number | null; binary: boolean }

export function numstatFiles(raw: string | null): FileStat[] {
  const files: FileStat[] = [];
  for (const line of splitlines(raw ?? "")) {
    const parts = line.split("\t");
    if (parts.length !== 3) continue;
    const [added, deleted, path] = parts;
    files.push({ path, added: added === "-" ? null : parseInt(added, 10), deleted: deleted === "-" ? null : parseInt(deleted, 10), binary: added === "-" });
  }
  return files;
}

const totals = (files: FileStat[]) => ({
  files: files.length,
  added: files.reduce((n, f) => n + (f.added ?? 0), 0),
  deleted: files.reduce((n, f) => n + (f.deleted ?? 0), 0),
});

const untrackedFiles = async (cwd: Cwd) => splitlines((await git(["ls-files", "--others", "--exclude-standard"], cwd)) ?? "");

type Result = [Record<string, Json>, number];

export async function modeBase(branch: string, cwd: Cwd): Promise<Result> {
  const untracked = untrackedFiles(cwd); // independent of the ref resolution
  untracked.catch(() => {});
  const [ref, tried, reason] = await resolveComparisonRef(branch, cwd);
  if (ref === null) return [{ mode: "base", base: branch, error: reason, tried }, 2];
  const mb = await git(["merge-base", "HEAD", ref], cwd);
  if (!mb) return [{ mode: "base", base: branch, comparison_ref: ref, error: `no merge base between HEAD and ${ref}`, tried }, 2];
  const [diff, others] = await Promise.all([git(["diff", "--numstat", mb], cwd), untracked]);
  const files = numstatFiles(diff);
  return [{
    mode: "base", base: branch, comparison_ref: ref, reason, tried, merge_base: mb, diff_command: `git diff ${mb}`,
    untracked: others, changed: files as unknown as Json, totals: totals(files),
  }, 0];
}

export async function modeCommit(rev: string, cwd: Cwd): Promise<Result> {
  const [sha, parent] = await Promise.all([
    git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cwd),
    git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}^`], cwd),
  ]);
  if (!sha) return [{ mode: "commit", commit: rev, error: `cannot resolve commit ${rev}`, tried: [rev] }, 2];
  let raw: string | null, cmd: string;
  if (parent) {
    raw = await git(["diff", "--numstat", parent, sha], cwd);
    cmd = `git diff ${parent} ${sha}`;
  } else {
    raw = await git(["show", "--numstat", "--format=", "--root", sha], cwd);
    cmd = `git show --root ${sha}`;
  }
  const files = numstatFiles(raw);
  return [{ mode: "commit", commit: sha, parent, diff_command: cmd, changed: files as unknown as Json, totals: totals(files) }, 0];
}

export async function modeUncommitted(cwd: Cwd): Promise<Result> {
  const [head, headDiff, untracked] = await Promise.all([
    git(["rev-parse", "--verify", "--quiet", "HEAD"], cwd),
    git(["diff", "--numstat", "HEAD"], cwd),
    untrackedFiles(cwd),
  ]);
  // A repository with no commits yet has nothing to diff against but the index.
  const files = numstatFiles(head ? headDiff : await git(["diff", "--numstat", "--cached"], cwd));
  return [{
    mode: "uncommitted", head, diff_command: head ? "git diff HEAD" : "git diff --cached",
    untracked, changed: files as unknown as Json, totals: totals(files),
  }, 0];
}

/** json.dumps(value, indent=2) with Python's ensure_ascii=True. */
function dumps(value: Json, level = 0): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    return typeof value === "string" ? text.replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) : text;
  }
  const entries = Array.isArray(value) ? value.map((v) => [null, v] as const) : Object.entries(value);
  if (!entries.length) return Array.isArray(value) ? "[]" : "{}";
  const pad = "\n" + "  ".repeat(level + 1);
  const items = entries.map(([k, v]) => (k === null ? "" : dumps(k) + ": ") + dumps(v, level + 1));
  return (Array.isArray(value) ? "[" : "{") + pad + items.join("," + pad) + "\n" + "  ".repeat(level) + (Array.isArray(value) ? "]" : "}");
}

const USAGE = "[-h] (--base BRANCH | --commit REV | --uncommitted) [-C CWD]";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const error = (message: string) => {
    writeSync(2, `usage: resolve_review_target.ts ${USAGE}\nresolve_review_target.ts: error: ${message}\n`);
    return 2;
  };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: {
      help: { type: "boolean", short: "h" }, base: { type: "string" }, commit: { type: "string" },
      uncommitted: { type: "boolean" }, C: { type: "string", short: "C" } } });
  } catch (e) {
    return error((e as Error).message);
  }
  const o = parsed.values;
  if (o.help) {
    const doc = /\/\*\*([\s\S]*?)\*\//.exec(await Bun.file(import.meta.path).text())![1].replace(/^ \* ?/gm, "").trim();
    writeSync(1, `usage: resolve_review_target.ts ${USAGE}\n\n${doc}\n`);
    return 0;
  }
  const modes = [o.base !== undefined && "--base", o.commit !== undefined && "--commit", o.uncommitted && "--uncommitted"].filter(Boolean);
  if (modes.length === 0) return error("one of the arguments --base --commit --uncommitted is required");
  if (modes.length > 1) return error(`argument ${modes[1]}: not allowed with argument ${modes[0]}`);
  const cwd = o.C;

  // The work-tree check runs alongside the (read-only) mode commands; its answer gates the output.
  const pending = o.base !== undefined ? modeBase(o.base, cwd) : o.commit !== undefined ? modeCommit(o.commit, cwd) : modeUncommitted(cwd);
  pending.catch(() => {});
  if ((await git(["rev-parse", "--is-inside-work-tree"], cwd)) !== "true") {
    writeSync(1, '{"error": "not inside a git work tree"}\n');
    return 2;
  }
  const [result, code] = await pending;
  writeSync(1, dumps(result) + "\n");
  return code;
}

if (import.meta.main) process.exit(await main());
