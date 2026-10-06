/**
 * Tests for scripts/release_plan.ts. Run with `bun test` from the skill folder.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpFor, changelog, nextVersion, parseCommit } from "../scripts/release_plan";

const SCRIPT = join(import.meta.dir, "..", "scripts", "release_plan.ts");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
const p = (subject: string, body = "") => parseCommit({ sha: "abcdef1234567", subject, body });

test("parses type, scope, bang and breaking footer", () => {
  expect(p("feat(api): add orders endpoint")).toMatchObject({ type: "feat", scope: "api", breaking: false, description: "add orders endpoint" });
  expect(p("refactor!: drop node 16").breaking).toBe(true);
  const f = p("fix: rename field", "Some text.\n\nBREAKING CHANGE: `user_id` is now `userId`.");
  expect(f.breaking).toBe(true);
  expect(f.breakingNote).toBe("`user_id` is now `userId`.");
  expect(p("Update stuff").conventional).toBe(false);
});

test("bump rules including 0.x breaking changes", () => {
  expect(bumpFor([p("feat: x"), p("fix: y")], "1.2.3")).toBe("minor");
  expect(bumpFor([p("fix: y")], "1.2.3")).toBe("patch");
  expect(bumpFor([p("feat!: y")], "1.2.3")).toBe("major");
  expect(bumpFor([p("feat!: y")], "0.4.0")).toBe("minor");
  expect(bumpFor([p("docs: y"), p("chore: z")], "1.0.0")).toBe("none");
});

test("next version arithmetic", () => {
  expect(nextVersion("1.2.3", "major")).toBe("2.0.0");
  expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
  expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
  expect(nextVersion("1.2.3", "none")).toBe("1.2.3");
  expect(nextVersion("2.0.0-rc.1", "patch")).toBe("2.0.0");
  expect(nextVersion(null, "minor")).toBe("0.1.0");
});

test("changelog groups sections, hides maintenance, flags unconventional", () => {
  const md = changelog("v1.3.0", "2026-10-05", [p("feat(ui): dark mode"), p("fix: crash on empty cart"), p("chore: bump deps"), p("Quick hotfix"), p("perf!: new cache", "BREAKING CHANGE: cache keys changed")]);
  expect(md).toContain("## v1.3.0 (2026-10-05)");
  expect(md).toContain("### Breaking changes\n\n- cache keys changed (abcdef1)");
  expect(md).toContain("- **ui:** dark mode (abcdef1)");
  expect(md).toContain("### Unclassified (review before release)\n\n- Quick hotfix");
  expect(md).toContain("_1 maintenance commit(s)");
  expect(md).not.toContain("bump deps");
});

let dir: string;
const sh = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
const commit = (msg: string) => {
  writeFileSync(join(dir, "f.txt"), msg + Math.random());
  sh("add", ".");
  sh("commit", "-q", "-m", msg);
};
const cli = (...args: string[]) => {
  const r = Bun.spawnSync([process.execPath, SCRIPT, "-C", dir, ...args], { env: GIT_ENV });
  return [r.exitCode, r.stdout.toString()] as const;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "release-"));
  sh("init", "-q", "-b", "main");
  commit("feat: initial");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("CLI uses the latest semver tag and proposes the next one without tagging", () => {
  sh("tag", "v1.0.0");
  commit("fix: a bug");
  sh("tag", "not-a-version");
  commit("feat(api): new thing");
  const [code, out] = cli();
  const j = JSON.parse(out);
  expect(code).toBe(0);
  expect(j).toMatchObject({ from: "v1.0.0", current_version: "1.0.0", bump: "minor", next_version: "1.1.0", next_tag: "v1.1.0", commits: 2 });
  const tags = Bun.spawnSync(["git", "tag"], { cwd: dir, env: GIT_ENV }).stdout.toString().trim().split("\n");
  expect(tags.sort()).toEqual(["not-a-version", "v1.0.0"]);
});

test("CLI with no tags uses whole history; md format prints changelog", () => {
  const [, out] = cli();
  expect(JSON.parse(out)).toMatchObject({ from: null, next_version: "0.1.0" });
  const [, md] = cli("--format", "md");
  expect(md.startsWith("## v0.1.0")).toBe(true);
});

test("CLI errors on an unknown ref", () => {
  expect(cli("--to", "nope")[0]).toBe(2);
});
