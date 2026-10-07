/**
 * Tests for the delivery plugin hooks and preflight. Run with `bun test` from the plugin folder.
 * End-to-end tests feed the hooks the JSON Claude Code sends on stdin, inside throwaway repos.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { classifyCommand } from "../hooks/bash_guard";
import { sessionEdited, skillUsed, toolUses } from "../hooks/stop_gate";
import { preflight, render } from "../skills/delivery-lifecycle/scripts/preflight";

const ROOT = join(import.meta.dir, "..");
const STOP = join(ROOT, "hooks", "stop_gate.ts");
const GUARD = join(ROOT, "hooks", "bash_guard.ts");
const AWS = "AKIA" + "Q7XK2M4N8P3R5T6W";
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

const use = (name: string, input: object) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

test("toolUses reads tool calls from a JSONL transcript and skips junk", () => {
  const t = [use("Read", { file_path: "a" }), "not json tool_use", use("Edit", { file_path: "b" }), JSON.stringify({ type: "user" })].join("\n");
  expect(toolUses(t).map((u) => u.name)).toEqual(["Read", "Edit"]);
});

test("sessionEdited: edit tools and file-writing shell commands, not reads or 2>&1", () => {
  expect(sessionEdited([{ name: "Read", input: {} }, { name: "Bash", input: { command: "bun test 2>&1 | tail" } }])).toBe(false);
  expect(sessionEdited([{ name: "Write", input: {} }])).toBe(true);
  expect(sessionEdited([{ name: "Bash", input: { command: "sed -i '' s/a/b/ src/x.ts" } }])).toBe(true);
  expect(sessionEdited([{ name: "Bash", input: { command: "echo hi > notes.txt" } }])).toBe(true);
});

test("skillUsed matches plugin-namespaced skills and SKILL.md reads", () => {
  expect(skillUsed([{ name: "Skill", input: { skill: "delivery:performance-review" } }], "performance-review")).toBe(true);
  expect(skillUsed([{ name: "Skill", input: { skill: "security-review" } }], "security-review")).toBe(true);
  expect(skillUsed([{ name: "Read", input: { file_path: "/x/skills/deploy-checklist/SKILL.md" } }], "engineering:deploy-checklist")).toBe(true);
  expect(skillUsed([{ name: "Skill", input: { skill: "code-review" } }], "security-review")).toBe(false);
});

test("bash guard classifies commits and outward actions", () => {
  expect(classifyCommand("git commit -m 'x'")).toEqual({ commit: true, irreversible: null });
  expect(classifyCommand("git -C repo push origin main").irreversible).toBe("git push");
  expect(classifyCommand("git tag -a v2.0.0 -m v2").irreversible).toBe("git tag");
  expect(classifyCommand("git tag -l").irreversible).toBeNull();
  expect(classifyCommand("git tag v2.0.0").irreversible).toBe("git tag");
  expect(classifyCommand("git tag -am 'v2' v2.0.0").irreversible).toBe("git tag");
  expect(classifyCommand("git -C repo tag -s v2.0.0 HEAD").irreversible).toBe("git tag");
  expect(classifyCommand("echo; git tag v2.0.0 && git log").irreversible).toBe("git tag");
  expect(classifyCommand("npm publish --access public").irreversible).toBe("package publish");
  expect(classifyCommand("kubectl apply -f k8s/").irreversible).toBe("cluster change");
  expect(classifyCommand("git status && bun test").irreversible).toBeNull();
});

// ------------------------------------------------------------------ repos
let dir: string;
const sh = (...a: string[]) => { const p = Bun.spawnSync(["git", ...a], { cwd: dir, env: ENV }); if (p.exitCode) throw new Error(p.stderr.toString()); };
const put = (f: string, t: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); };
const hook = (script: string, input: object) => {
  const p = Bun.spawnSync([process.execPath, script], { stdin: Buffer.from(JSON.stringify(input)), env: ENV });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "delivery-"));
  sh("init", "-q", "-b", "main");
  put("package.json", JSON.stringify({ name: "x", packageManager: "bun@1.4.2", scripts: { test: "bun test" } }));
  put("src/a.ts", "export const a = 1;\n");
  put("tests/a.test.ts", 'import { expect, test } from "bun:test"; import { a } from "../src/a"; test("a", () => expect(a).toBe(1));\n');
  sh("add", "."); sh("commit", "-qm", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("preflight: docs-only change runs no quality commands and passes", async () => {
  put("README.md", "hello\n");
  const p = await preflight(dir);
  expect(typeof p).toBe("object");
  if (typeof p === "string") return;
  expect(p.ok).toBe(true);
  expect(p.quality).toEqual([]);
  expect(render(p)).toContain("quality  not run");
});

test("bash guard: listing tags is not creating one", () => {
  for (const cmd of ["git tag", "git tag --sort=-creatordate | head", "git tag --sort -v:refname", "git tag -n5", "git tag --contains HEAD",
    "git tag --merged main", "git tag --points-at HEAD", "git tag -l 'v1.*'", "git tag --format='%(refname:short)'", "git tag -d tmp"]) {
    expect([cmd, classifyCommand(cmd).irreversible]).toEqual([cmd, null]);
  }
});

test("preflight: a test runner that finds no test files is a note, not a failure", async () => {
  sh("rm", "-q", "tests/a.test.ts"); sh("commit", "-qm", "no tests");
  put("package.json", JSON.stringify({ name: "x", version: "2.0.0", packageManager: "bun@1.4.2", scripts: { test: "bun test" } }));
  const p = await preflight(dir);
  if (typeof p === "string") throw new Error(p);
  expect({ blocking: p.blocking, tail: p.quality[0]?.output_tail }).toEqual({ blocking: [], tail: expect.any(String) });
  expect(p.quality[0]).toMatchObject({ kind: "test", passed: true, no_tests: true });
  expect(p.advisories.join("\n")).toContain("found no test files");
  expect(render(p)).toContain("no test files");
});

test("preflight: failing test and a secret block; auth change asks for security review", async () => {
  put("src/a.ts", `export const a = 2; const k = "${AWS}";\n`);
  put("src/auth/token.ts", "export const t = Math.random();\n");
  const p = await preflight(dir);
  if (typeof p === "string") throw new Error(p);
  expect(p.ok).toBe(false);
  expect(p.blocking.join("\n")).toContain("test failed");
  expect(p.blocking.join("\n")).toContain("aws-access-key-id");
  expect(p.reviews.map((r) => r.skill)).toEqual(["security-review"]);
});

test("stop gate: allows stop when the session made no edits", () => {
  put("src/a.ts", "export const a = 2;\n"); // failing change, but not made by this session
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, use("Read", { file_path: "src/a.ts" }));
  expect(hook(STOP, { session_id: "s0", transcript_path: transcript, cwd: dir }).code).toBe(0);
});

test("stop gate: blocks on a failing test after an edit, at most twice", () => {
  put("src/a.ts", "export const a = 2;\n");
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, use("Edit", { file_path: join(dir, "src/a.ts") }));
  const sid = `s-${Date.now()}`;
  const first = hook(STOP, { session_id: sid, transcript_path: transcript, cwd: dir });
  expect(first.code).toBe(2);
  expect(first.err).toContain("test failed");
  expect(hook(STOP, { session_id: sid, transcript_path: transcript, cwd: dir, stop_hook_active: true }).code).toBe(2);
  expect(hook(STOP, { session_id: sid, transcript_path: transcript, cwd: dir, stop_hook_active: true }).code).toBe(0);
});

test("stop gate: asks once for a security review, not again after the skill ran", () => {
  put("src/auth/token.ts", "export const t = () => Math.random();\n");
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, use("Write", { file_path: join(dir, "src/auth/token.ts") }));
  const r = hook(STOP, { session_id: `r-${Date.now()}`, transcript_path: transcript, cwd: dir });
  expect(r.code).toBe(2);
  expect(r.err).toContain("`security-review` skill");
  writeFileSync(transcript, [use("Write", { file_path: "x" }), use("Skill", { skill: "security-review" })].join("\n"));
  expect(hook(STOP, { session_id: `r2-${Date.now()}`, transcript_path: transcript, cwd: dir }).code).toBe(0);
});

test("stop gate: respects stopGate false in .claude/delivery.json", () => {
  put("src/a.ts", "export const a = 2;\n");
  put(".claude/delivery.json", JSON.stringify({ stopGate: false }));
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, use("Edit", { file_path: "src/a.ts" }));
  expect(hook(STOP, { session_id: "off", transcript_path: transcript, cwd: dir }).code).toBe(0);
});

test("bash guard: denies a commit with a staged secret; asks before push", () => {
  put("src/key.ts", `export const k = "${AWS}";\n`);
  sh("add", "src/key.ts");
  const deny = JSON.parse(hook(GUARD, { tool_name: "Bash", tool_input: { command: "git commit -m key" }, cwd: dir }).out);
  expect(deny.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(deny.hookSpecificOutput.permissionDecisionReason).not.toContain(AWS);
  const ask = JSON.parse(hook(GUARD, { tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: dir }).out);
  expect(ask.hookSpecificOutput.permissionDecision).toBe("ask");
  expect(hook(GUARD, { tool_name: "Bash", tool_input: { command: "bun test" }, cwd: dir }).out).toBe("");
});

test("stop gate: a safe change under auth/ is a note, not a block", () => {
  put("src/auth/token.ts", 'import { randomBytes } from "node:crypto";\nexport const t = () => randomBytes(32).toString("hex");\n');
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, use("Write", { file_path: join(dir, "src/auth/token.ts") }));
  expect(hook(STOP, { session_id: `safe-${Date.now()}`, transcript_path: transcript, cwd: dir }).code).toBe(0);
});

test("stop gate: a path the project marked as security-sensitive still asks for review", () => {
  put(".claude/delivery.json", JSON.stringify({ securityPaths: ["src/billing/**"] }));
  put("src/billing/charge.ts", "export const charge = (n: number) => n * 100;\n");
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, use("Write", { file_path: join(dir, "src/billing/charge.ts") }));
  const r = hook(STOP, { session_id: `cfg-${Date.now()}`, transcript_path: transcript, cwd: dir });
  expect(r.code).toBe(2);
  expect(r.err).toContain("configured security path");
});

test("classifier: RegExp.exec is not command execution; child_process exec is", async () => {
  const { classify } = await import("../skills/delivery-lifecycle/scripts/classify_change");
  const f = (text: string) => classify([{ path: "src/a.ts", added: 1, deleted: 0, binary: false, addedLines: [{ line: 1, text }] }]).gates.security.signals.map((s) => s.signal);
  expect(f("const m = /^(\\d+)$/.exec(amount);")).not.toContain("dynamic code execution");
  expect(f("const m = pattern.exec(s);")).not.toContain("dynamic code execution");
  expect(f("execSync(`git ${arg}`);")).toContain("dynamic code execution");
  expect(f("cp.exec(cmd, cb);")).toContain("dynamic code execution");
});

test("stop gate: a migration is a non-blocking note, not a block", () => {
  put("src/migrations/003.sql", "ALTER TABLE users RENAME COLUMN user_name TO username;\n");
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, use("Write", { file_path: join(dir, "src/migrations/003.sql") }));
  const r = hook(STOP, { session_id: `mig-${Date.now()}`, transcript_path: transcript, cwd: dir });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).systemMessage).toContain("migrations");
});

// ------------------------------------------------------------------ run.sh (bun launcher)
const RUN = join(ROOT, "hooks", "run.sh");
const launch = (args: string[], input: object, env: Record<string, string | undefined>) => {
  const p = Bun.spawnSync(["/bin/sh", RUN, ...args], { stdin: Buffer.from(JSON.stringify(input)), env });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

test("run.sh: passes stdin, output and exit code through bun", () => {
  const env = { ...ENV, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
  const ask = launch([GUARD], { tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: dir }, env);
  expect(JSON.parse(ask.out).hookSpecificOutput.permissionDecision).toBe("ask");
  put("src/a.ts", "export const a = 2;\n");
  const transcript = join(dir, "t.jsonl");
  writeFileSync(transcript, use("Edit", { file_path: join(dir, "src/a.ts") }));
  expect(launch([STOP], { session_id: `run-${Date.now()}`, transcript_path: transcript, cwd: dir }, env).code).toBe(2);
  expect(launch(["--check"], {}, env).out).toBe("");
});

test("run.sh: without bun, gates are skipped silently and --check warns once", () => {
  const env = { PATH: "/usr/bin:/bin", HOME: dir };
  const guard = launch([GUARD], { tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: dir }, env);
  expect(guard).toEqual({ code: 0, out: "", err: "" });
  expect(launch([STOP], { session_id: "nobun", cwd: dir }, env).code).toBe(0);
  expect(JSON.parse(launch(["--check"], {}, env).out).systemMessage).toContain("bun not found");
});
