/**
 * Tests for scripts/resolve_review_target.ts. Run with `bun test` from the skill folder.
 * Each test builds throwaway git repositories in a temp directory.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "resolve_review_target.ts");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};

function sh(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return proc.stdout.toString().trim();
}

const write = (cwd: string, name: string, text: string) => writeFileSync(join(cwd, name), text);

function commit(cwd: string, name: string, text: string, msg: string): string {
  write(cwd, name, text);
  sh(cwd, "add", name);
  sh(cwd, "commit", "-q", "-m", msg);
  return sh(cwd, "rev-parse", "HEAD");
}

function run(cwd: string, ...args: string[]): [number, any] {
  const proc = Bun.spawnSync([process.execPath, SCRIPT, "-C", cwd, ...args], { env: GIT_ENV });
  return [proc.exitCode!, JSON.parse(proc.stdout.toString())];
}

let root: string, origin: string, work: string, c0: string, f1: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "review-target-"));
  origin = join(root, "origin");
  mkdirSync(origin);
  sh(origin, "init", "-q", "-b", "main");
  c0 = commit(origin, "a.txt", "one\n", "c0");
  work = join(root, "work");
  sh(root, "clone", "-q", origin, work);
  sh(work, "checkout", "-q", "-b", "feature");
  f1 = commit(work, "b.txt", "feat\nline2\n", "feature work");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("base uses local branch when upstream not ahead", () => {
  const [code, out] = run(work, "--base", "main");
  expect(code).toBe(0);
  expect(out.comparison_ref).toBe("main");
  expect(out.merge_base).toBe(c0);
  expect(out.changed.map((f: any) => f.path)).toEqual(["b.txt"]);
  expect(out.totals).toEqual({ files: 1, added: 2, deleted: 0 });
});

test("base prefers upstream when ahead", () => {
  // origin/main advances and the feature branch is rebased onto it,
  // but local main is stale: the upstream must be used.
  const c1 = commit(origin, "a.txt", "one\ntwo\n", "c1 on origin");
  sh(work, "fetch", "-q", "origin");
  sh(work, "rebase", "-q", "origin/main");
  const [code, out] = run(work, "--base", "main");
  expect(code).toBe(0);
  expect(out.comparison_ref).toBe("origin/main");
  expect(out.merge_base).toBe(c1);
  // Only the feature's own file, not origin's a.txt change.
  expect(out.changed.map((f: any) => f.path)).toEqual(["b.txt"]);
});

test("base falls back to remote when local branch missing", () => {
  sh(origin, "branch", "release");
  sh(work, "fetch", "-q", "origin");
  const [code, out] = run(work, "--base", "release");
  expect(code).toBe(0);
  expect(out.comparison_ref).toBe("origin/release");
  expect(out.tried).toContain("origin/release");
});

test("base unresolvable reports error", () => {
  const [code, out] = run(work, "--base", "does-not-exist");
  expect(code).toBe(2);
  expect(out).toHaveProperty("error");
  expect(out.tried[0]).toBe("does-not-exist");
});

test("base includes uncommitted edits and untracked", () => {
  write(work, "a.txt", "one\nlocal edit\n");
  write(work, "new.txt", "untracked\n");
  const [code, out] = run(work, "--base", "main");
  expect(code).toBe(0);
  expect(out.changed.map((f: any) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
  expect(out.untracked).toEqual(["new.txt"]);
});

test("commit mode", () => {
  const [code, out] = run(work, "--commit", "HEAD");
  expect(code).toBe(0);
  expect(out.commit).toBe(f1);
  expect(out.parent).toBe(c0);
  expect(out.diff_command).toBe(`git diff ${c0} ${f1}`);
});

test("commit mode root commit", () => {
  const [code, out] = run(work, "--commit", c0);
  expect(code).toBe(0);
  expect(out.parent).toBeNull();
  expect(out.changed.map((f: any) => f.path)).toEqual(["a.txt"]);
});

test("uncommitted mode", () => {
  write(work, "b.txt", "feat\nchanged\n");
  sh(work, "add", "b.txt");
  write(work, "a.txt", "one\nunstaged\n");
  write(work, "u.txt", "x\n");
  const [code, out] = run(work, "--uncommitted");
  expect(code).toBe(0);
  expect(out.changed.map((f: any) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
  expect(out.untracked).toEqual(["u.txt"]);
});

test("script is read-only", () => {
  const before = sh(work, "status", "--porcelain=v1", "--branch");
  const refsBefore = sh(work, "for-each-ref");
  run(work, "--base", "main");
  run(work, "--uncommitted");
  run(work, "--commit", "HEAD");
  expect(sh(work, "status", "--porcelain=v1", "--branch")).toBe(before);
  expect(sh(work, "for-each-ref")).toBe(refsBefore);
});

test("not a repo", () => {
  const plain = join(root, "plain");
  mkdirSync(plain);
  const proc = Bun.spawnSync([process.execPath, SCRIPT, "-C", plain, "--uncommitted"], { env: { ...GIT_ENV, GIT_CEILING_DIRECTORIES: root } });
  expect(proc.exitCode).toBe(2);
  expect(JSON.parse(proc.stdout.toString())).toHaveProperty("error");
});
