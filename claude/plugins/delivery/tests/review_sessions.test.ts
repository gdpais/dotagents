/**
 * Tests for v3.3: review sessions that own their PR's merge, the review's tables in the reply, and the asks that
 * Heartbeat's transcripts (1–4 Nov 2026) showed were still false. Run with `bun test` from the plugin folder.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assessedPr, assistantEntries, expandVars, literalVars, parseAutonomy, policyContext, pushOutsidePolicy, reviewBrief, segments, shellWords, showsReview, toolUses, unshownReviews } from "../hooks/autonomy";
import { outsidePolicy, policyMerges, routineOnly, workflowRun } from "../hooks/bash_guard";
import { createsPr, openedPrUrl } from "../hooks/pr_opened";
import { nextStep, renderMd, type Risk } from "../skills/delivery-lifecycle/scripts/pr_risk";

const ROOT = join(import.meta.dir, "..");
const STOP = join(ROOT, "hooks", "stop_gate.ts");
const GUARD = join(ROOT, "hooks", "bash_guard.ts");
const OPENED = join(ROOT, "hooks", "pr_opened.ts");
const APP = join(ROOT, "hooks", "app_tools.ts");
const CONTEXT = join(ROOT, "hooks", "session_context.ts");
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const AUTONOMY = { push: ["feature/*"], openPr: true, autoFix: true, cleanupMerged: true, merge: { low: "green", medium: "decide" } };
const SESSION = { autonomy: { ...AUTONOMY, review: "session", reviewPreset: "Heartbeat" } };
const policy = parseAutonomy({ autonomy: AUTONOMY })!;

const use = (name: string, input: object, id?: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input, ...(id ? { id } : {}) }] } });
const say = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const prompt = (text: string) => JSON.stringify({ type: "user", message: { content: text } });
const TABLES = "## Code Review: PR #5\n\n### Summary\nOK.\n\n### Critical Issues\n| # | File | Line | Issue | Severity |\n|---|---|---|---|---|\n\n### Suggestions\n| # | File | Line | Suggestion | Category |\n|---|---|---|---|---|\n| 1 | src/a.ts | 3 | Rename | Maintainability |\n\n### Verdict\nApprove";

// ------------------------------------------------------------------ transcripts
test("toolUses counts each tool call once and skips the API request blobs that replay them", () => {
  const blob = JSON.stringify({ type: "api-request-blob", message: { content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "engineering:code-review" } }] } });
  const t = [use("Skill", { skill: "engineering:code-review" }, "t1"), use("Bash", { command: "ls" }, "t2"), blob, use("Bash", { command: "ls" }, "t2")].join("\n");
  expect(toolUses(t).map((u) => u.id)).toEqual(["t1", "t2"]);
});

test("assessedPr: Heartbeat PR 123 (4 Nov) is covered, and re-rating a reviewed PR keeps its review", () => {
  const review = { name: "Skill", input: { skill: "engineering:code-review" } };
  const risk = (n: number, v: string) => ({ name: "Bash", input: { command: `gh api rate_limit 2>&1; bun "/c/3.2.2/scripts/pr_risk.ts" -C . --pr ${n} --review ${v} 2>&1 | tail -30` } });
  // The transcript replayed the pr_risk run; 3.2.2 read the replay as a second run with no review before it.
  expect(assessedPr([review, risk(123, "ok"), risk(123, "ok")], 123)).toBe("ok");
  expect(assessedPr([review, risk(122, "fix"), risk(122, "ok")], 122)).toBe("ok");
  // Still one PR per review.
  expect(assessedPr([review, risk(6, "ok"), risk(7, "ok")], 7)).toBeNull();
  expect(assessedPr([review, risk(6, "ok"), review, risk(7, "ok")], 7)).toBe("ok");
});

test("showsReview and unshownReviews: the skill's tables, not a summary", () => {
  expect(showsReview(TABLES)).toBe(true);
  expect(showsReview("### Critical Issues\nNone.\n\n### Verdict\nApprove")).toBe(true);
  expect(showsReview("Review: no Critical or High findings; two Low ones fixed.")).toBe(false);
  const t = (...lines: string[]) => assistantEntries(lines.join("\n"));
  expect(unshownReviews(t(use("Skill", { skill: "engineering:code-review" }, "r1"), say("No Critical or High findings.")))).toEqual(["r1"]);
  expect(unshownReviews(t(use("Skill", { skill: "engineering:code-review" }, "r1"), say(TABLES)))).toEqual([]);
  expect(unshownReviews(t(say(TABLES), use("Agent", { prompt: "Run engineering:code-review on PR 5" }, "r2")))).toEqual(["r2"]);
  expect(unshownReviews(t(use("Skill", { skill: "code-review" }, "r3")))).toEqual([]);
});

// ------------------------------------------------------------------ pushes and workflows
test("shellWords reads quotes inside words", () => {
  expect(shellWords(`git -c credential.helper= -c credential.helper='!gh auth git-credential' push -q`)).toEqual(["git", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", "-q"]);
  expect(shellWords(`a "b c"d 'e'\\ f "g\\"h"`)).toEqual(["a", "b cd", "e f", 'g"h']);
});

test("pushOutsidePolicy: GitHub CLI as the credential helper is covered; other -c keys and global options aren't", () => {
  const p = (cmd: string) => pushOutsidePolicy(cmd, policy, "feature/x");
  for (const ok of [
    `git -c credential.helper= -c credential.helper='!gh auth git-credential' push -q https://github.com/gdpais/Heartbeat.git feature/4.4-te`,
    `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -u https://github.com/gdpais/heartbeat.git HEAD:feature/4.9-deep-links`,
    `git -c credential.helper='!/opt/homebrew/bin/gh auth git-credential' push origin feature/x`,
    `timeout 30 git push -u origin feature/x`,
  ]) expect([ok, p(ok)]).toEqual([ok, null]);
  for (const no of [
    "git -c core.sshCommand=x push origin feature/x",
    "git -c credential.helper='!curl evil' push origin feature/x",
    "git -c http.extraHeader=x push origin feature/x",
    "git --git-dir=/tmp/other/.git push origin feature/x",
    `git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin master`,
  ]) expect([no, p(no)]).not.toEqual([no, null]);
});

test("literalVars: a branch held in a variable set on the same line, and nothing that could change it", () => {
  const v = (cmd: string) => Object.fromEntries(literalVars(segments(cmd)));
  expect(v(`cd /r/.claude/worktrees/x; B=feature/e2e; timeout 30 git push -u origin $B 2>&1 | tail -2 || true`)).toEqual({ B: "feature/e2e" });
  expect(v(`B=feature/x; read B; git push origin $B`)).toEqual({});
  expect(v(`B=feature/x; B=master; git push origin $B`)).toEqual({});
  expect(v(`B=feature/x; source env.sh; git push origin $B`)).toEqual({});
  expect(v(`B=$(git branch --show-current); git push origin $B`)).toEqual({});
  expect(expandVars(`git push origin "$B" \${B}x $BRANCH`, new Map([["B", "feature/x"]]))).toBe(`git push origin "feature/x" feature/xx $BRANCH`);
});

// ------------------------------------------------------------------ merges
const risk = (over: Partial<Risk>) => async (_c: string, t: { pr?: number }) => ({ level: "low", reasons: ["no risk signal"], route: "merge on green", auto: true, ci: "pending", pr: t.pr!, head: "6619c9e6d50b55b0d71626e460da1ad383402674", draft: false, incomplete: null, evidence: [], mergeState: "BLOCKED", ...over }) as Risk;
const reviewedUses = (n: number) => [{ name: "Skill", input: { skill: "engineering:code-review" } }, { name: "Bash", input: { command: `bun /p/pr_risk.ts --pr ${n} --review ok` } }];

test("merge by risk: auto-merge pinned to the checked head while the base's required checks run", async () => {
  const auto = { n: 5, repo: null, auto: true, head: "6619c9e" };
  expect([...(await policyMerges([auto], policy, "/x", reviewedUses(5), risk({}))).covered]).toEqual([5]);
  expect((await policyMerges([{ ...auto, head: null }], policy, "/x", reviewedUses(5), risk({}))).why).toContain("pinned to the head");
  expect((await policyMerges([{ ...auto, head: "deadbee" }], policy, "/x", reviewedUses(5), risk({}))).why).toContain("pinned to the head");
  expect((await policyMerges([auto], policy, "/x", reviewedUses(5), risk({ mergeState: "CLEAN" }))).why).toContain("wouldn't wait");
  expect((await policyMerges([auto], policy, "/x", reviewedUses(5), risk({ ci: "red" }))).why).toContain("CI red");
  expect((await policyMerges([{ ...auto, admin: true }], policy, "/x", reviewedUses(5), risk({}))).why).toContain("--admin");
  // A plain merge still needs green CI.
  expect((await policyMerges([5], policy, "/x", reviewedUses(5), risk({}))).why).toContain("not green (CI pending)");
  expect([...(await policyMerges([5], policy, "/x", reviewedUses(5), risk({ ci: "green" }))).covered]).toEqual([5]);
});

test("nextStep and renderMd: the decision under the review's tables", () => {
  const base: Risk = { level: "low", reasons: ["no risk signal"], route: "merge on green", auto: true, ci: "green", pr: 5, head: "6619c9e6d50b", draft: false, incomplete: null, evidence: ["Test results"], mergeState: "CLEAN", review: "ok" };
  expect(nextStep(base)).toBe("merge: `gh pr merge 5 --merge --match-head-commit 6619c9e6d50b`");
  expect(nextStep({ ...base, ci: "pending", mergeState: "BLOCKED" }, "squash")).toContain("`gh pr merge 5 --auto --squash --match-head-commit 6619c9e6d50b`");
  expect(nextStep({ ...base, ci: "pending" })).toContain("wait for it");
  expect(nextStep({ ...base, route: "Claude decides: merge on green, block, or ask" })).toMatch(/^if the evidence shows it working, merge: .*otherwise block it or ask/);
  expect(nextStep({ ...base, level: "breaking", route: "needs your approval", auto: false })).toContain("don't merge: ask the user for their review and approval");
  expect(nextStep({ ...base, route: "fix first", auto: false })).toContain("fix the Critical and High findings");
  expect(nextStep({ ...base, ci: "red" })).toContain("CI is red");
  expect(nextStep({ ...base, ci: "none" })).toContain("no CI checks");
  const md = renderMd({ ...base, next: nextStep(base) });
  expect(md).toContain("### Decision\n| PR | Risk | Review | CI | Route |");
  expect(md).toContain("| #5 (6619c9e) | low | ok | green | merge on green |");
  expect(md).toContain("**Next:** merge: `gh pr merge 5");
  expect(md).toContain("- Test results");
});

// ------------------------------------------------------------------ policy text and brief
test("policyContext with review sessions: no review before pushing, the tables, merge on green with auto-merge", () => {
  const ctx = policyContext(parseAutonomy(SESSION)!, "master", "/p/cleanup_merged.ts", "/p/pr_risk.ts");
  expect(ctx).toContain("Each PR gets its own review session");
  expect(ctx).not.toContain("review the change with the `engineering:code-review` skill against master");
  expect(ctx).toContain("the Critical Issues and Suggestions tables");
  expect(ctx).toContain("--review ok|fix|blocking --format md");
  expect(ctx).toContain("--auto");
  expect(ctx).toContain("never enable auto-merge unless the user asked");
  expect(ctx).toContain("tell its review session (SendMessage)");
  const self = policyContext(policy, "master");
  expect(self).toContain("review the change with the `engineering:code-review` skill against master");
  expect(self).toContain("the Critical Issues and Suggestions tables");
});

test("reviewBrief: review, show the tables, fix, rate, then merge or stop by risk; never 'do not merge'", () => {
  const b = reviewBrief({ n: 123, url: "https://github.com/o/r/pull/123", base: "master", policy: parseAutonomy(SESSION)!, riskScript: "/p/pr_risk.ts", cleanupScript: "/p/cleanup_merged.ts", mainCheckout: "/r" });
  for (const s of ["engineering:code-review", "Critical Issues and Suggestions tables", "git worktree add --detach .claude/worktrees/pr-123-review", "never force-push",
    `bun "/p/pr_risk.ts" -C /r --pr 123 --review <verdict> --format md`, "low: merge on green", "breaking: never merge it yourself", "--auto", `bun "/p/cleanup_merged.ts" -C /r`])
    expect([s, b.includes(s)]).toEqual([s, true]);
  expect(b).not.toMatch(/do not merge/i);
  const asking = reviewBrief({ n: 1, url: "u", base: "main", policy: parseAutonomy({ autonomy: { push: ["feature/*"], review: "session" } })!, riskScript: "r", cleanupScript: "c", mainCheckout: "/r" });
  expect(asking).toContain("Merging isn't in the policy");
});

test("createsPr and openedPrUrl: a real gh pr create, on this repository, that opened a new PR", () => {
  expect(createsPr("git push -u origin HEAD && gh pr create --fill --base master 2>&1 | tail -1")).toBe(true);
  expect(createsPr(`gh pr create --body-file - <<'EOF'\nbody\nEOF`)).toBe(true);
  expect(createsPr(`echo "gh pr create"; grep -n 'gh pr create' notes.md`)).toBe(false);
  expect(createsPr(`git commit -F - <<'EOF'\ngh pr create next\nEOF`)).toBe(false);
  expect(openedPrUrl("https://github.com/gdpais/Heartbeat/pull/127\n", "github.com/gdpais/heartbeat")).toEqual({ n: 127, url: "https://github.com/gdpais/Heartbeat/pull/127", existed: false });
  expect(openedPrUrl("https://github.com/other/repo/pull/3", "github.com/gdpais/heartbeat")).toBeNull();
  expect(openedPrUrl("a pull request for branch \"feature/x\" into branch \"master\" already exists:\nhttps://github.com/o/r/pull/9", "github.com/o/r")!.existed).toBe(true);
});

// ------------------------------------------------------------------ hooks in a repository
let dir: string;
const git = (cwd: string, ...a: string[]) => { const p = Bun.spawnSync(["git", ...a], { cwd, env: ENV }); if (p.exitCode) throw new Error(p.stderr.toString()); return p.stdout.toString().trim(); };
const put = (f: string, t: string, at = dir) => { mkdirSync(dirname(join(at, f)), { recursive: true }); writeFileSync(join(at, f), t); };
const hook = (script: string, input: object) => {
  const p = Bun.spawnSync([process.execPath, script], { stdin: Buffer.from(JSON.stringify(input)), env: { ...ENV, KUBECONFIG: "/nonexistent" } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const decision = (r: { out: string }) => (r.out.trim() ? JSON.parse(r.out).hookSpecificOutput.permissionDecision : "none");

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "del-review-")), "repo");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "master");
  put("package.json", JSON.stringify({ name: "x", scripts: { test: "bun test" } }));
  put("src/a.ts", "export const a = 1;\n");
  put("tests/a.test.ts", 'import { expect, test } from "bun:test"; import { a } from "../src/a"; test("a", () => expect(a).toBe(1));\n');
  git(dir, "add", "."); git(dir, "commit", "-qm", "init");
  git(dir, "remote", "add", "origin", "https://github.com/gdpais/example.git");
  git(dir, "switch", "-q", "-c", "feature/x");
});
afterEach(() => rmSync(dirname(dir), { recursive: true, force: true }));

test("bash guard: Heartbeat's HTTPS push, timeout and variable pushes, and workflows naming this repository", () => {
  put(".claude/delivery.json", JSON.stringify({ autonomy: { ...AUTONOMY, workflows: ["scenarios.yml"] } }));
  const d = (command: string) => decision(hook(GUARD, { tool_name: "Bash", tool_input: { command }, cwd: dir }));
  // 28 asks in Heartbeat, 3–4 Nov.
  expect(d(`git -c credential.helper= -c credential.helper='!gh auth git-credential' push -q https://github.com/gdpais/example.git feature/x 2>&1 | tail -1`)).toBe("allow");
  expect(d(`B=feature/x; timeout 30 git push -u origin $B 2>&1 | tail -2`)).not.toBe("ask");
  expect(d(`B=master; git push origin $B`)).toBe("ask");
  expect(d(`git -c credential.helper= -c credential.helper='!gh auth git-credential' push https://github.com/other/fork.git feature/x`)).toBe("ask");
  // 3 asks: the workflow named this repository with --repo.
  expect(d(`gh workflow run scenarios.yml --repo gdpais/example --ref feature/x -f scenarios=rotation`)).not.toBe("ask");
  expect(d(`gh workflow run scenarios.yml --repo other/repo`)).toBe("ask");
  expect(d(`gh workflow run ci.yml --repo gdpais/example`)).toBe("ask");
  expect(workflowRun(`gh workflow run --repo o/r -f a=b scenarios.yml`)).toEqual({ workflow: "scenarios.yml", repo: "o/r" });
  // Pushes inside `if …; then` and a subshell (Heartbeat, 3–4 Nov); deleting a remote branch still asks.
  expect(d(`B=feature/x; timeout 30 git push -u origin $B 2>&1 | tail -2 || true; if ! git ls-remote --exit-code origin refs/heads/$B >/dev/null 2>&1; then git -c credential.helper= -c credential.helper='!gh auth git-credential' push https://github.com/gdpais/example.git $B 2>&1 | tail -2; git branch --set-upstream-to=origin/$B; fi`)).not.toBe("ask");
  expect(d(`(git push origin HEAD:feature/x 2>&1 || git -c credential.helper= -c credential.helper='!gh auth git-credential' push https://github.com/gdpais/example.git HEAD:feature/x 2>&1) | tail -2`)).not.toBe("ask");
  expect(d(`git -c credential.helper= -c credential.helper='!gh auth git-credential' push https://github.com/gdpais/example.git --delete feature/old`)).toBe("ask");
  expect(d(`if true; then git push origin master; fi`)).toBe("ask");
});

test("routineOnly: safe -c pairs, this repository's --repo and a clean worktree removal; redirects and other repos aren't", () => {
  const r = (cmd: string) => routineOnly(cmd, policy, () => null, dir);
  for (const ok of [
    `git -c credential.helper= -c credential.helper='!gh auth git-credential' push -q https://github.com/gdpais/example.git feature/x 2>&1 | tail -1`,
    `timeout 30 git push -u origin feature/x`,
    `gh pr view 5 --repo gdpais/example --json state && gh pr checks 5 --repo gdpais/example`,
    `git worktree remove .claude/worktrees/pr-5-review && git worktree list`,
  ]) expect([ok, r(ok)]).toEqual([ok, true]);
  for (const no of [
    `git -c credential.helper= push origin feature/x > ~/.bashrc`,
    `git -c core.hooksPath=/tmp/h push origin feature/x`,
    `gh pr view 5 --repo other/repo`,
    `git worktree remove --force .claude/worktrees/pr-5-review`,
    `git worktree remove /tmp/elsewhere`,
  ]) expect([no, r(no)]).toEqual([no, false]);
  expect(outsidePolicy(`git -c credential.helper= -c credential.helper='!gh auth git-credential' push https://github.com/gdpais/example.git feature/x`, policy, dir)).toBeNull();
});

test("pr_opened: with review sessions, a new PR on this repository gets its review session's start and brief", () => {
  const transcript = join(dir, "..", "t.jsonl");
  writeFileSync(transcript, prompt("Start on 2.1"));
  const opened = { tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, tool_response: { stdout: "https://github.com/gdpais/example/pull/7\n", stderr: "" }, cwd: dir, transcript_path: transcript };
  expect(hook(OPENED, opened).out).toBe("");
  put(".claude/delivery.json", JSON.stringify(SESSION));
  const ctx = JSON.parse(hook(OPENED, opened).out).hookSpecificOutput.additionalContext as string;
  expect(ctx).toContain('title "Code review: PR #7", name "review-pr-7", preset "Heartbeat"');
  expect(ctx).toContain('initiation "user_asked"');
  expect(ctx).toContain("don't wait for it or ask the user about merging it");
  expect(ctx).toContain("--format md");
  expect(ctx).not.toMatch(/do not merge/i);
  expect(hook(OPENED, { ...opened, tool_response: { stdout: "https://github.com/other/repo/pull/7" } }).out).toBe("");
  expect(hook(OPENED, { ...opened, tool_response: { stderr: "a pull request for branch already exists: https://github.com/gdpais/example/pull/7" } }).out).toBe("");
  expect(hook(OPENED, { ...opened, tool_input: { command: "echo 'gh pr create'" } }).out).toBe("");
  writeFileSync(transcript, [prompt("Start on 2.1"), use("mcp__ccd_session__start_session", { title: "Code review: PR #7" })].join("\n"));
  expect(hook(OPENED, opened).out).toBe("");
  put(".claude/delivery.json", JSON.stringify({ autonomy: AUTONOMY }));
  expect(hook(OPENED, opened).out).toBe("");
});

test("app tools: review-session starts, binding this repository's PR and Auto-fix are approved by the policy", () => {
  const call = (tool: string, input: object) => decision(hook(APP, { tool_name: tool, tool_input: input, cwd: dir }));
  const start = { initiation: "user_asked", use_worktree: false, context: "fresh", title: "Code review: PR #7", name: "review-pr-7" };
  expect(call("mcp__ccd_session__start_session", start)).toBe("none");
  put(".claude/delivery.json", JSON.stringify({ autonomy: AUTONOMY }));
  expect(call("mcp__ccd_session__start_session", start)).toBe("none");
  expect(call("mcp__ccd_pr__bind_pr", { url: "https://github.com/gdpais/example/pull/7" })).toBe("allow");
  expect(call("mcp__ccd_pr__bind_pr", { url: "https://github.com/other/repo/pull/7" })).toBe("none");
  expect(call("mcp__ccd_pr__get_status", {})).toBe("allow");
  expect(call("mcp__ccd_pr__set_monitor", { auto_fix: true, url: "https://github.com/gdpais/example/pull/7" })).toBe("allow");
  expect(call("mcp__ccd_pr__set_auto_merge", { enabled: true, url: "https://github.com/gdpais/example/pull/7" })).toBe("none");
  put(".claude/delivery.json", JSON.stringify(SESSION));
  expect(call("mcp__ccd_session__start_session", start)).toBe("allow");
  expect(call("mcp__ccd_session__start_session", { ...start, title: "Refactor the API" })).toBe("none");
  expect(call("mcp__ccd_session__start_session", { ...start, cwd: "/elsewhere" })).toBe("none");
});

test("session context: review sessions replace the review before pushing", () => {
  put(".claude/delivery.json", JSON.stringify(SESSION));
  const ctx = JSON.parse(hook(CONTEXT, { cwd: dir, source: "startup" }).out).hookSpecificOutput.additionalContext;
  expect(ctx).toContain("Each PR gets its own review session");
  expect(ctx).toMatch(/run `bun "\/[^"]+\/scripts\/pr_risk\.ts" -C <repo> --pr <n> --review ok\|fix\|blocking --format md`/);
});

test("stop gate: a review whose tables no reply shows gets one block, edits or not", () => {
  const transcript = join(dir, "..", "t.jsonl");
  writeFileSync(transcript, [prompt("Review PR 5"), use("Skill", { skill: "engineering:code-review" }, "r1"), say("No Critical or High findings; two Low ones.")].join("\n"));
  const sid = `tables-${Date.now()}`;
  const r = hook(STOP, { session_id: sid, transcript_path: transcript, cwd: dir });
  expect(r.code).toBe(2);
  expect(r.err).toContain("Show the review");
  expect(r.err).toContain("the Critical Issues and Suggestions tables");
  expect(hook(STOP, { session_id: sid, transcript_path: transcript, cwd: dir }).code).toBe(0);
  writeFileSync(transcript, [prompt("Review PR 5"), use("Skill", { skill: "engineering:code-review" }, "r1"), say(TABLES)].join("\n"));
  expect(hook(STOP, { session_id: `tables2-${Date.now()}`, transcript_path: transcript, cwd: dir }).code).toBe(0);
  put(".claude/delivery.json", JSON.stringify({ stopGate: false }));
  writeFileSync(transcript, [prompt("Review PR 5"), use("Skill", { skill: "engineering:code-review" }, "r1")].join("\n"));
  expect(hook(STOP, { session_id: `tables3-${Date.now()}`, transcript_path: transcript, cwd: dir }).code).toBe(0);
});

// ------------------------------------------------------------------ with a remote
let remote: string;
const withRemote = () => {
  remote = join(dir, "..", "remote.git");
  git(dir, "switch", "-q", "master");
  git(dirname(dir), "clone", "-q", "--bare", dir, remote);
  git(dir, "switch", "-q", "feature/x");
  git(dir, "remote", "set-url", "origin", remote);
  git(dir, "fetch", "-q", "origin");
};

test("stop gate, review sessions: no review before pushing; a PR opened without its review session gets one nudge", () => {
  withRemote();
  put(".claude/delivery.json", JSON.stringify(SESSION));
  put("src/b.ts", "export const b = 2;\n");
  git(dir, "add", "src/b.ts"); git(dir, "commit", "-qm", "feat: b");
  const transcript = join(dir, "..", "t.jsonl");
  writeFileSync(transcript, [prompt("Start on 2.1"), use("Write", { file_path: join(dir, "src/b.ts") })].join("\n"));
  const ship = hook(STOP, { session_id: `s-ship-${Date.now()}`, transcript_path: transcript, cwd: dir });
  expect(ship.code).toBe(2);
  expect(ship.err).toContain("not pushed");
  expect(ship.err).not.toContain("first review");
  git(dir, "push", "-q", "-u", "origin", "HEAD");
  const shipped = [prompt("Start on 2.1"), use("Write", { file_path: join(dir, "src/b.ts") }), use("Bash", { command: "git push -u origin HEAD" }), use("Bash", { command: "gh pr create --fill" })];
  writeFileSync(transcript, shipped.join("\n"));
  const nudge = hook(STOP, { session_id: `s-rev-${Date.now()}`, transcript_path: transcript, cwd: dir });
  expect(nudge.code).toBe(2);
  expect(nudge.err).toContain("its review session wasn't started");
  writeFileSync(transcript, [...shipped, use("mcp__ccd_session__start_session", { title: "Code review: PR #7" })].join("\n"));
  expect(hook(STOP, { session_id: `s-rev2-${Date.now()}`, transcript_path: transcript, cwd: dir }).code).toBe(0);
});

test("stop gate: a review session in the shared checkout isn't told to ship the branch another session has there", () => {
  withRemote();
  put(".claude/delivery.json", JSON.stringify(SESSION));
  // The shared checkout has another session's unpushed commit on feature/x.
  put("src/b.ts", "export const b = 2;\n");
  git(dir, "add", "src/b.ts"); git(dir, "commit", "-qm", "feat: b");
  // This session fixed things in its own detached worktree and pushed them to the PR branch.
  git(dir, "worktree", "add", "-q", "--detach", ".claude/worktrees/pr-7-review", "origin/master");
  const wt = join(dir, ".claude/worktrees/pr-7-review");
  put("src/c.ts", "export const c = 3;\n", wt);
  const transcript = join(dir, "..", "t.jsonl");
  writeFileSync(transcript, [prompt("Review PR 7"), use("Skill", { skill: "engineering:code-review" }), say(TABLES), use("Write", { file_path: join(wt, "src/c.ts") }), use("Bash", { command: `cd ${wt} && git add -A && git commit -qm fix && git push origin HEAD:feature/y` })].join("\n"));
  expect(hook(STOP, { session_id: `shared-${Date.now()}`, transcript_path: transcript, cwd: dir }).code).toBe(0);
  // The session that owns feature/x is still told.
  writeFileSync(transcript, [prompt("Start on 2.1"), use("Write", { file_path: join(dir, "src/b.ts") })].join("\n"));
  expect(hook(STOP, { session_id: `owner-${Date.now()}`, transcript_path: transcript, cwd: dir }).code).toBe(2);
});

test("stop gate: a branch pushed to a URL (no tracking ref) isn't reported as unpushed", () => {
  withRemote();
  put(".claude/delivery.json", JSON.stringify({ autonomy: { ...AUTONOMY, review: false } }));
  put("src/b.ts", "export const b = 2;\n");
  git(dir, "add", "src/b.ts"); git(dir, "commit", "-qm", "feat: b");
  git(dir, "push", "-q", remote, "feature/x");
  const transcript = join(dir, "..", "t.jsonl");
  writeFileSync(transcript, [prompt("Start on 2.1"), use("Write", { file_path: join(dir, "src/b.ts") }), use("Bash", { command: `git push ${remote} feature/x` }), use("Bash", { command: "gh pr create --fill" })].join("\n"));
  const r = hook(STOP, { session_id: `url-${Date.now()}`, transcript_path: transcript, cwd: dir });
  expect([r.code, r.err]).toEqual([0, ""]);
});
