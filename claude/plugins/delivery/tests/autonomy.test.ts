/**
 * Tests for the v3 autonomy policy: parsing, push and cluster classification, the SessionStart
 * context and the Stop gate's ship check. Run with `bun test` from the plugin folder.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { globMatch, parseAutonomy, pushOutsidePolicy, segments } from "../hooks/autonomy";
import { outsidePolicy } from "../hooks/bash_guard";
import { asksToHold, lastUserPrompt } from "../hooks/stop_gate";

const ROOT = join(import.meta.dir, "..");
const STOP = join(ROOT, "hooks", "stop_gate.ts");
const GUARD = join(ROOT, "hooks", "bash_guard.ts");
const CONTEXT = join(ROOT, "hooks", "session_context.ts");
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const POLICY = { autonomy: { push: ["feature/*"], openPr: true, cleanupMerged: true, continue: { backlog: "TODO.md", maxItems: 2 }, localClusters: ["kind-*", "minikube"] } };
const policy = parseAutonomy(POLICY)!;

test("parseAutonomy: absent policy is null; defaults are conservative", () => {
  expect(parseAutonomy({})).toBeNull();
  expect(parseAutonomy({ autonomy: {} })).toMatchObject({ push: [], openPr: false, autoFix: false, cleanupMerged: false, continue: null });
  expect(policy).toMatchObject({ push: ["feature/*"], openPr: true, continue: { backlog: "TODO.md", maxItems: 2 } });
});

test("globMatch: * stays within a segment, ** crosses", () => {
  expect(globMatch("feature/*", "feature/2.1-slugs")).toBe(true);
  expect(globMatch("feature/*", "feature/a/b")).toBe(false);
  expect(globMatch("feature/**", "feature/a/b")).toBe(true);
  expect(globMatch("kind-*", "kind-heartbeat")).toBe(true);
  expect(globMatch("feature/*", "master")).toBe(false);
});

test("segments split on shell separators but not inside quotes", () => {
  expect(segments(`git commit -m "a && b" && git push -u origin HEAD; echo ok | tail`)).toEqual([`git commit -m "a && b"`, "git push -u origin HEAD", "echo ok", "tail"]);
});

test("pushOutsidePolicy: feature branches pass; base, force, tags, deletes and other branches don't", () => {
  const p = (cmd: string, cur = "feature/2.1-slugs") => pushOutsidePolicy(cmd, policy, cur);
  for (const ok of ["git push", "git push -u origin HEAD", "git push origin feature/2.1-slugs", "git push --set-upstream origin feature/x", "git push origin HEAD:refs/heads/feature/x", "git -C repo push origin feature/x"]) expect([ok, p(ok)]).toEqual([ok, null]);
  expect(p("git push origin master")).toContain("base branch");
  expect(p("git push", "master")).toContain("base branch");
  expect(p("git push -f origin feature/x")).toContain("force");
  expect(p("git push --force-with-lease")).toContain("force");
  expect(p("git push origin +feature/x")).toContain("force");
  expect(p("git push --tags")).toContain("tag");
  expect(p("git push origin v1.2.0")).toContain("v1.2.0");
  expect(p("git push origin :feature/x")).toContain("deletion");
  expect(p("git push origin --delete feature/x")).toContain("delete");
  expect(p("git push origin release/1.0")).toContain("not in autonomy.push");
  // Redirections aren't refspecs (DEL v3 asked on every real push: `git push ... 2>&1 | grep -v ^remote:`).
  for (const ok of ["git push -q -u origin feature/x 2>&1", "git push origin feature/x 2> /dev/null", "git push origin feature/x >push.log 2>&1", "git push &>/dev/null"]) expect([ok, p(ok)]).toEqual([ok, null]);
  expect(p("git push origin master 2>&1")).toContain("base branch");
  expect(p("git push -f origin feature/x 2>&1")).toContain("force");
});

test("bash guard: the policy covers feature pushes and local clusters, nothing else", () => {
  const out = (cmd: string, ctx: string | null = null) => outsidePolicy(cmd, policy, "/nonexistent", () => ctx);
  expect(out("git push origin feature/x && gh pr create --base master --fill")).toBeNull();
  expect(out(`git push -q -u origin feature/x 2>&1 | grep -v "^remote:" ; gh pr create --base master --head feature/x --fill`)).toBeNull();
  expect(out(`git commit -q -F - <<'EOF'\nfix: x\n\ngit push origin master is not part of this\nEOF\ngit push -q -u origin feature/x 2>&1 | tail -2`)).toBeNull();
  expect(out(`git commit -q -F - <<'EOF'\nfix: x\nEOF\ngit push origin master`)).toContain("base branch");
  expect(out("git push origin feature/x && git tag v1.0.0")).toBe("git tag");
  expect(out("gh pr merge 12 --merge")).toBe("gh pr merge");
  expect(out("kubectl --context kind-heartbeat apply -f k8s/")).toBeNull();
  expect(out("helm upgrade hb ./chart --kube-context minikube")).toBeNull();
  expect(out("kubectl apply -f k8s/", "kind-dev")).toBeNull();
  expect(out("kubectl apply -f k8s/", "arn:aws:eks:prod")).toBe("cluster change");
  expect(out("kubectl apply -f k8s/")).toBe("cluster change");
  expect(out("terraform apply")).toBe("infrastructure apply");
});

test("asksToHold and lastUserPrompt", () => {
  for (const s of ["Implement 2.1 but don't push yet", "do not open a PR", "Keep it local only", "I want to look at it first", "not yet", "hold off on shipping"]) expect([s, asksToHold(s)]).toEqual([s, true]);
  for (const s of ["Start on TODO 2.1.", "Push the branch and open the PR.", "Wait for CI and then push it", "PR #12 is merged."]) expect([s, asksToHold(s)]).toEqual([s, false]);
  const t = [
    JSON.stringify({ type: "user", message: { content: "Implement 2.1, don't push" } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Stop hook feedback: x" }] } }),
  ].join("\n");
  expect(lastUserPrompt(t)).toBe("Implement 2.1, don't push");
});

// ------------------------------------------------------------------ repos with a remote
let dir: string, remote: string;
const git = (cwd: string, ...a: string[]) => { const p = Bun.spawnSync(["git", ...a], { cwd, env: ENV }); if (p.exitCode) throw new Error(p.stderr.toString()); return p.stdout.toString().trim(); };
const put = (f: string, t: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); };
const hook = (script: string, input: object) => {
  const p = Bun.spawnSync([process.execPath, script], { stdin: Buffer.from(JSON.stringify(input)), env: ENV });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const use = (name: string, input: object) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const prompt = (text: string) => JSON.stringify({ type: "user", message: { content: text } });

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "delivery-auto-"));
  dir = join(root, "repo"); remote = join(root, "remote.git");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "master");
  put("package.json", JSON.stringify({ name: "x", scripts: { test: "bun test" } }));
  put("src/a.ts", "export const a = 1;\n");
  put("tests/a.test.ts", 'import { expect, test } from "bun:test"; import { a } from "../src/a"; test("a", () => expect(a).toBe(1));\n');
  git(dir, "add", "."); git(dir, "commit", "-qm", "init");
  git(root, "clone", "-q", "--bare", dir, remote);
  git(dir, "remote", "add", "origin", remote); git(dir, "fetch", "-q", "origin");
  git(dir, "branch", "-q", "--set-upstream-to=origin/master", "master");
});
afterEach(() => rmSync(dirname(dir), { recursive: true, force: true }));

test("bash guard end to end: no output for a policy push, ask for master and without a policy", () => {
  git(dir, "switch", "-q", "-c", "feature/x");
  put(".claude/delivery.json", JSON.stringify(POLICY));
  expect(hook(GUARD, { tool_name: "Bash", tool_input: { command: "git push -u origin HEAD" }, cwd: dir }).out).toBe("");
  expect(JSON.parse(hook(GUARD, { tool_name: "Bash", tool_input: { command: "git push origin master" }, cwd: dir }).out).hookSpecificOutput.permissionDecision).toBe("ask");
  put(".claude/delivery.json", "{}");
  expect(JSON.parse(hook(GUARD, { tool_name: "Bash", tool_input: { command: "git push -u origin HEAD" }, cwd: dir }).out).hookSpecificOutput.permissionDecision).toBe("ask");
});

test("session context: adds the policy at startup, silent on resume and without a policy", () => {
  expect(hook(CONTEXT, { cwd: dir, source: "startup" }).out).toBe("");
  put(".claude/delivery.json", JSON.stringify(POLICY));
  const ctx = JSON.parse(hook(CONTEXT, { cwd: dir, source: "startup" }).out).hookSpecificOutput.additionalContext;
  expect(ctx).toContain("standing authorization");
  expect(ctx).toContain("against master");
  expect(ctx).toContain("TODO.md");
  expect(ctx).toMatch(/run `bun "\/[^"]+\/skills\/delivery-lifecycle\/scripts\/cleanup_merged\.ts" -C/);
  expect(ctx).toContain("Still stop and ask");
  expect(hook(CONTEXT, { cwd: dir, source: "resume" }).out).toBe("");
});

test("stop gate: nudges once to ship an unpushed feature branch", () => {
  put(".claude/delivery.json", JSON.stringify(POLICY));
  git(dir, "switch", "-q", "-c", "feature/2.1-x");
  put("src/b.ts", "export const b = 2;\n");
  git(dir, "add", "src/b.ts"); git(dir, "commit", "-qm", "feat: b");
  const transcript = join(dir, "..", "t.jsonl");
  writeFileSync(transcript, [prompt("Start on TODO 2.1."), use("Write", { file_path: join(dir, "src/b.ts") })].join("\n"));
  const sid = `ship-${Date.now()}`;
  const r = hook(STOP, { session_id: sid, transcript_path: transcript, cwd: dir });
  expect(r.code).toBe(2);
  expect(r.err).toContain("1 commit(s) not pushed");
  expect(r.err).toContain("open the pull request against master");
  expect(hook(STOP, { session_id: sid, transcript_path: transcript, cwd: dir, stop_hook_active: true }).code).toBe(0);
});

test("stop gate: no ship nudge when the user asked to hold, without a policy, or once shipped", () => {
  git(dir, "switch", "-q", "-c", "feature/2.1-x");
  put("src/b.ts", "export const b = 2;\n");
  const transcript = join(dir, "..", "t.jsonl");
  writeFileSync(transcript, [prompt("Start on TODO 2.1."), use("Write", { file_path: join(dir, "src/b.ts") })].join("\n"));
  expect(hook(STOP, { session_id: `np-${Date.now()}`, transcript_path: transcript, cwd: dir }).code).toBe(0);
  put(".claude/delivery.json", JSON.stringify(POLICY));
  writeFileSync(transcript, [prompt("Implement 2.1 but don't push yet, I want to look first."), use("Write", { file_path: join(dir, "src/b.ts") })].join("\n"));
  expect(hook(STOP, { session_id: `hold-${Date.now()}`, transcript_path: transcript, cwd: dir }).code).toBe(0);
  git(dir, "add", "src/b.ts"); git(dir, "commit", "-qm", "feat: b"); git(dir, "push", "-q", "-u", "origin", "HEAD");
  writeFileSync(transcript, [prompt("Start on TODO 2.1."), use("Write", { file_path: join(dir, "src/b.ts") }), use("Bash", { command: "git push -u origin HEAD" }), use("Bash", { command: "gh pr create --fill" })].join("\n"));
  expect(hook(STOP, { session_id: `done-${Date.now()}`, transcript_path: transcript, cwd: dir }).code).toBe(0);
});

test("stop gate: pushed without a PR, and edits on the base branch, get one nudge each", () => {
  put(".claude/delivery.json", JSON.stringify(POLICY));
  const transcript = join(dir, "..", "t.jsonl");
  put("src/b.ts", "export const b = 2;\n");
  writeFileSync(transcript, [prompt("Start on TODO 2.1."), use("Write", { file_path: join(dir, "src/b.ts") })].join("\n"));
  const onBase = hook(STOP, { session_id: `base-${Date.now()}`, transcript_path: transcript, cwd: dir });
  expect(onBase.code).toBe(2);
  expect(onBase.err).toContain("you changed files on master");
  git(dir, "switch", "-q", "-c", "feature/2.1-x"); git(dir, "add", "src/b.ts"); git(dir, "commit", "-qm", "feat: b"); git(dir, "push", "-q", "-u", "origin", "HEAD");
  writeFileSync(transcript, [prompt("Start on TODO 2.1."), use("Write", { file_path: join(dir, "src/b.ts") }), use("Bash", { command: "git push -u origin HEAD" })].join("\n"));
  const noPr = hook(STOP, { session_id: `nopr-${Date.now()}`, transcript_path: transcript, cwd: dir });
  expect(noPr.code).toBe(2);
  expect(noPr.err).toContain("no pull request was opened");
});

test("worktrees: the guard finds the main checkout's policy and the branch a `cd` switches to", () => {
  put(".claude/delivery.json", JSON.stringify(POLICY));
  git(dir, "worktree", "add", "-q", ".claude/worktrees/2.1-x", "-b", "feature/2.1-x");
  const wt = join(dir, ".claude/worktrees/2.1-x");
  expect(hook(GUARD, { tool_name: "Bash", tool_input: { command: "git push -u origin HEAD" }, cwd: wt }).out).toBe("");
  expect(hook(GUARD, { tool_name: "Bash", tool_input: { command: "cd .claude/worktrees/2.1-x && git push -u origin HEAD" }, cwd: dir }).out).toBe("");
  expect(JSON.parse(hook(GUARD, { tool_name: "Bash", tool_input: { command: "git push -u origin HEAD" }, cwd: dir }).out).hookSpecificOutput.permissionDecision).toBe("ask");
});

test("stop gate: sees unshipped work in a worktree while the session sits on the base branch", () => {
  put(".claude/delivery.json", JSON.stringify(POLICY));
  git(dir, "worktree", "add", "-q", ".claude/worktrees/2.1-x", "-b", "feature/2.1-x");
  const wt = join(dir, ".claude/worktrees/2.1-x");
  writeFileSync(join(wt, "src/b.ts"), "export const b = 2;\n");
  git(wt, "add", "src/b.ts"); git(wt, "commit", "-qm", "feat: b");
  const transcript = join(dir, "..", "t.jsonl");
  writeFileSync(transcript, [prompt("Start on TODO 2.1."), use("Write", { file_path: join(wt, "src/b.ts") })].join("\n"));
  const r = hook(STOP, { session_id: `wt-${Date.now()}`, transcript_path: transcript, cwd: dir });
  expect(r.code).toBe(2);
  expect(r.err).toContain("feature/2.1-x (worktree");
});
