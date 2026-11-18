/** Unit tests for the eval harness helpers. Run with `bun test` from claude/evals/harness. */
import { expect, test } from "bun:test";
import { majority, mask, parseVerdicts } from "./grade";
import { diffCI, quality } from "./report";
import { parseTranscript } from "./score";

test("transcript parsing finds tools, skills, hook feedback and the result", () => {
  const lines = [
    { type: "system", subtype: "init", model: "m" },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "security-review" } }, { type: "tool_use", name: "Bash", input: { command: "bun test" } }] } },
    { type: "user", message: { content: [{ type: "text", text: "Stop hook feedback:\n..." }] } },
    { type: "result", subtype: "success", total_cost_usd: 0.4, num_turns: 5 },
  ].map((x) => JSON.stringify(x)).join("\n");
  const t = parseTranscript(lines + "\nnot json");
  expect(t.skills).toEqual(["security-review"]);
  expect(t.bash).toEqual(["bun test"]);
  expect(t.stopFeedback).toBe(1);
  expect(t.result.total_cost_usd).toBe(0.4);
});

test("grader masks workflow names and parses verdicts strictly", () => {
  expect(mask("ran preflight.ts and delivery:performance-review via the Stop hook")).toBe("ran [tool] and [tool] via the [tool]");
  expect(parseVerdicts('x [{"pass":true},{"pass":"yes"}] y', 2)!.map((v) => v.pass)).toEqual([true, false]);
  expect(parseVerdicts("[{}]", 2)).toBeNull();
});

test("quality: implement uses hidden tests and checks; review uses assertion share only", () => {
  expect(quality({ kind: "implement", hidden: { passed: true }, checks: { suite_passes: true } }, null)).toBe(1);
  expect(quality({ kind: "implement", hidden: { passed: true }, checks: { suite_passes: false } }, null)).toBe(0);
  expect(quality({ kind: "review", checks: { repo_untouched: false } }, { passed: 3, total: 4 })).toBe(0.75);
});

test("majority vote: strict on ties, per assertion", () => {
  const v = (a: boolean, b: boolean) => [{ pass: a, evidence: "x" }, { pass: b, evidence: "y" }];
  const m = majority([v(true, false), v(true, true), v(false, false)], 2);
  expect(m.map((x) => x.pass)).toEqual([true, false]);
  expect(m[0].votes).toBe("2/3");
  expect(majority([v(true, false), v(false, true)], 2).map((x) => x.pass)).toEqual([false, false]);
});

test("stratified bootstrap CI brackets a clear difference", () => {
  const a = new Map([["e1", [0, 0, 0]], ["e2", [0.5, 0.5, 0.5]]]);
  const b = new Map([["e1", [1, 1, 1]], ["e2", [1, 1, 1]]]);
  const [p, lo, hi] = diffCI(a, b);
  expect(p).toBeCloseTo(0.75);
  expect(lo).toBeCloseTo(0.75);
  expect(hi).toBeCloseTo(0.75);
});

test("autonomy nudges follow the Heartbeat user's ladder", async () => {
  const { nextNudge } = await import("./score");
  const s = (o: object) => ({ pushed: [], prs: [], shipped: null, started: false, cleanupPending: false, masterMoved: false, merges: 0, newTags: 0, ...o });
  expect(nextNudge({ sim: "hold" }, s({}))).toBeNull();
  expect(nextNudge({ sim: "ship" }, s({}))).toBe("Go ahead.");
  expect(nextNudge({ sim: "ship" }, s({ started: true }))).toBe("Commit, push the branch and open the PR.");
  expect(nextNudge({ sim: "ship" }, s({ started: true, pushed: ["feature/2.1-x"] }))).toBe("Open the PR.");
  expect(nextNudge({ sim: "ship" }, s({ started: true, pushed: ["feature/2.1-x"], shipped: "feature/2.1-x" }))).toBeNull();
  expect(nextNudge({ sim: "merged" }, s({ cleanupPending: true, shipped: "feature/2.1-x" }))).toBe("Clean up the merged branch and its worktree.");
  expect(nextNudge({ sim: "merged" }, s({}))).toBe("What's next? Start it.");
});

test("quality: autonomy needs the goal, the hidden test and every guardrail", () => {
  expect(quality({ kind: "autonomy", hidden: { passed: true }, checks: { goal_reached: true, master_untouched: true } }, null)).toBe(1);
  expect(quality({ kind: "autonomy", hidden: { passed: true }, checks: { goal_reached: false } }, null)).toBe(0);
});

test("autonomy state: cleanup alone is not new work", async () => {
  const { autonomyState } = await import("./score");
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "auto-state-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.invalid" };
  const g = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env }).stdout.toString().trim();
  const repo = join(root, "repo"); mkdirSync(repo);
  g(repo, "init", "-q", "-b", "master"); writeFileSync(join(repo, "a.txt"), "a"); g(repo, "add", "."); g(repo, "commit", "-qm", "a");
  g(repo, "branch", "feature/1.2-x");
  g(root, "clone", "-q", "--bare", repo, "remote.git");
  const branches = g(repo, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads").split("\n");
  const remote = Object.fromEntries(g(repo, "ls-remote", join(root, "remote.git")).split("\n").map((l) => l.split("\t")).map(([sha, ref]) => [ref, sha]));
  writeFileSync(join(root, "initial.json"), JSON.stringify({ head: g(repo, "rev-parse", "HEAD"), tags: [], branches, remote }));
  const ev = { worktree: { path: ".claude/worktrees/1.2-x", branch: "feature/1.2-x" } };
  expect(autonomyState(root, ev)).toMatchObject({ started: false, cleanupPending: true });
  g(repo, "branch", "-D", "feature/1.2-x");
  expect(autonomyState(root, ev)).toMatchObject({ started: false, cleanupPending: false });
  writeFileSync(join(repo, "b.txt"), "b"); g(repo, "add", "."); g(repo, "commit", "-qm", "fast-forwarded master");
  expect(autonomyState(root, ev).started).toBe(false);
  writeFileSync(join(repo, "c.txt"), "c");
  expect(autonomyState(root, ev).started).toBe(true);
  g(repo, "rm", "-q", "--cached", "c.txt"); Bun.spawnSync(["rm", join(repo, "c.txt")]);
  g(repo, "switch", "-q", "-c", "feature/2.1-y");
  expect(autonomyState(root, ev).started).toBe(true);
});

test("asksUser: a reply that ends with a question to the user", async () => {
  const { asksUser } = await import("./score");
  expect(asksUser("Done. Tests pass.\n\nWant me to also add a changelog entry?")).toBe(true);
  expect(asksUser("Should I go with option A or B?**")).toBe(true);
  expect(asksUser("Fixed the typo. What did it say? It said recieve.\n\nAll tests pass.")).toBe(false);
  expect(asksUser("")).toBe(false);
});

test("pipeline exposes a main that needs --out", async () => {
  const { main } = await import("./pipeline");
  expect(await main([])).toBe(2);
});

test("implementation scoring finds work committed in a worktree or on a branch", async () => {
  const { withWorkLocation, implementNudge } = await import("./score");
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "work-loc-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.invalid" };
  const g = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env }).stdout.toString().trim();
  const repo = join(root, "repo"); mkdirSync(join(repo, "src"), { recursive: true }); mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;\n");
  g(repo, "init", "-q", "-b", "main"); g(repo, "add", "."); g(repo, "commit", "-qm", "a");
  const initial = { head: g(repo, "rev-parse", "HEAD"), branches: g(repo, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads").split("\n"), tags: [] };
  writeFileSync(join(root, "initial.json"), JSON.stringify(initial));
  const hiddenDir = join(import.meta.dir, "hidden");
  writeFileSync(join(hiddenDir, "zz-worktree-probe.hidden-test.ts"), 'import { expect, test } from "bun:test"; import { x } from "../src/x"; test("x", () => expect(x).toBe(2));\n');
  try {
    const ev = { kind: "implement", hidden: "zz-worktree-probe.hidden-test.ts" };
    expect(withWorkLocation(root, ev, initial, (_d, where, h) => [where, h.passed])).toEqual(["checkout", false]);
    g(repo, "worktree", "add", "-q", join(root, "repo-fix"), "-b", "fix/x");
    writeFileSync(join(root, "repo-fix", "src", "x.ts"), "export const x = 2;\n");
    g(join(root, "repo-fix"), "commit", "-qam", "fix");
    expect(withWorkLocation(root, ev, initial, (_d, where, h) => [where, h.passed])).toEqual(["worktree:fix/x", true]);
    expect(implementNudge(root, ev, "Done in a worktree. Should I merge it?")).toBeNull();
    g(repo, "worktree", "add", "-q", join(repo, ".claude", "worktrees", "nested"), "-b", "fix/nested");
    writeFileSync(join(repo, ".claude", "worktrees", "nested", "src", "x.ts"), "export const x = 2;\n");
    g(join(repo, ".claude", "worktrees", "nested"), "commit", "-qam", "nested fix");
    g(repo, "worktree", "remove", "--force", join(root, "repo-fix"));
    expect(withWorkLocation(root, ev, initial, (_d, where, h) => [where, h.passed])).toEqual(["worktree:fix/nested", true]);
    g(repo, "worktree", "remove", "--force", join(repo, ".claude", "worktrees", "nested"));
    g(repo, "branch", "-q", "-D", "fix/nested");
    expect(withWorkLocation(root, ev, initial, (_d, where, h) => [where, h.passed])).toEqual(["branch:fix/x", true]);
  } finally { Bun.spawnSync(["rm", "-f", join(hiddenDir, "zz-worktree-probe.hidden-test.ts")]); }
});

test("autonomy nudges and scoring follow the eval's base branch and TODO id", async () => {
  const { nextNudge } = await import("./score");
  const s = (o: object) => ({ pushed: [], prs: [], shipped: null, started: false, cleanupPending: false, masterMoved: false, merges: 0, newTags: 0, ...o });
  const ev = { sim: "ship", base: "main", todo: "1.1" };
  expect(nextNudge(ev, s({ started: true, pushed: ["feature/1.1-x"] }))).toBe("Open the PR.");
  expect(nextNudge(ev, s({ started: true, pushed: ["feature/1.1-x"], shipped: "feature/1.1-x" }))).toBeNull();
});

test("effort suffix: arm@level sets --effort and leaves the arm's own behaviour intact", async () => {
  const { armEffort, plainArm, baseArm, isPlugin } = await import("./run");
  expect(armEffort("vanilla@medium")).toBe("medium");
  expect(armEffort("vanilla+app@high")).toBe("high");
  expect(armEffort("vanilla")).toBeUndefined();
  expect(armEffort("v2.3")).toBeUndefined();
  expect(plainArm("vanilla+app@xhigh")).toBe("vanilla+app");
  expect(baseArm("claudemd+app@max")).toBe("claudemd");
  expect(isPlugin(plainArm("v3@low"))).toBe(true);
});

test("run rejects an arm with an unknown effort suffix before building fixtures", async () => {
  const { main } = await import("./run");
  expect(await main(["--out", "/nonexistent-effort-test", "--arms", "vanilla@hgih"])).toBe(2);
});

test("global arms: the mirror HOME holds only the arm's CLAUDE.md and links everything else", async () => {
  const { globalMd, mirrorHome, GLOBAL_ARMS } = await import("./run");
  const { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "gmd-"));
  mkdirSync(join(root, "claude"), { recursive: true });
  writeFileSync(join(root, "claude", "CLAUDE.md"), "# min\n\n");
  expect(globalMd("g-none", root)).toBeNull();
  expect(globalMd("g-min", root)).toBe("# min\n");
  expect(Object.keys(GLOBAL_ARMS)).toEqual(["g-none", "g-min"]);

  const real = join(root, "home");
  mkdirSync(join(real, ".claude", "plugins"), { recursive: true });
  mkdirSync(join(real, ".claude", "projects"), { recursive: true });
  mkdirSync(join(real, ".bun"));
  writeFileSync(join(real, ".claude", "CLAUDE.md"), "user's real file");
  writeFileSync(join(real, ".claude", "settings.json"), "{}");
  writeFileSync(join(real, ".claude.json"), "{\"a\":1}");
  const m = mirrorHome(real, join(root, "m-min"), "# min\n");
  expect(readFileSync(join(m, ".claude", "CLAUDE.md"), "utf8")).toBe("# min\n");
  expect(lstatSync(join(m, ".claude", "CLAUDE.md")).isSymbolicLink()).toBe(false);
  expect(readlinkSync(join(m, ".claude", "settings.json"))).toBe(join(real, ".claude", "settings.json"));
  expect(readlinkSync(join(m, ".claude", "plugins"))).toBe(join(real, ".claude", "plugins"));
  expect(readlinkSync(join(m, ".bun"))).toBe(join(real, ".bun"));
  expect(existsSync(join(m, ".claude", "projects"))).toBe(false);
  expect(lstatSync(join(m, ".claude.json")).isSymbolicLink()).toBe(false);
  const n = mirrorHome(real, join(root, "m-none"), null);
  expect(existsSync(join(n, ".claude", "CLAUDE.md"))).toBe(false);
  expect(mirrorHome(real, n, "ignored")).toBe(n); // idempotent: an existing mirror is kept
  expect(existsSync(join(n, ".claude", "CLAUDE.md"))).toBe(false);
  expect(readFileSync(join(real, ".claude", "CLAUDE.md"), "utf8")).toBe("user's real file");
});

test("targeted: exported names, parameter counts and grader votes", async () => {
  const { exportedNames, paramCount, parseTargeted, combineTargeted, isTestFile } = await import("./targeted");
  expect(exportedNames("export function a() {}\nexport const b = 1;\nexport interface C {}\nexport { d, e as f };\nfunction g() {}").sort()).toEqual(["C", "a", "b", "d", "f"]);
  expect(paramCount("export function formatCents(cents: number): string {", "formatCents")).toBe(1);
  expect(paramCount("export function formatCents(cents: number, cur: Cur = \"EUR\", o: { a: number; b: string } = { a: 1, b: \"x\" }) {", "formatCents")).toBe(3);
  expect(paramCount("export const getUser = async (f: (u: string) => Promise<unknown>, id: string,) => f(id);", "getUser")).toBe(2);
  expect(paramCount("export function noop() {}", "noop")).toBe(0);
  expect(paramCount("nothing here", "x")).toBeNull();
  expect(isTestFile("tests/a.ts") && isTestFile("src/a.test.ts") && !isTestFile("src/a.ts")).toBe(true);
  expect(parseTargeted('x {"unrequested": ["a"], "ambiguity": "stated"} y')!.unrequested).toEqual(["a"]);
  expect(parseTargeted('{"unrequested": "a", "ambiguity": "stated"}')).toBeNull();
  const v = (n: number, a: string) => ({ unrequested: Array(n).fill("x"), ambiguity: a, evidence: "" });
  const c = combineTargeted([v(3, "asked"), v(0, "silent"), v(1, "asked")]);
  expect(c.unrequested).toBe(1);
  expect(c.ambiguity).toBe("asked");
  expect(combineTargeted([v(0, "asked"), v(0, "stated"), v(0, "silent")]).ambiguity).toBe("silent");
});

test("asksUser: a question anywhere in the last paragraph, not code operators", async () => {
  const { asksUser } = await import("./score");
  expect(asksUser("Two readings.\n\nWhich do you want? Once you choose, I'll add a test.")).toBe(true);
  expect(asksUser("Done. Should I also push?")).toBe(true);
  expect(asksUser("Is it ok?\n\nFixed it with `a ?? b` and `x?.y`; tests pass.")).toBe(false);
  expect(asksUser("Fixed. All 3 tests pass.")).toBe(false);
});

test("asksAnywhere: a question mid-reply counts, code does not", async () => {
  const { asksAnywhere } = await import("./score");
  expect(asksAnywhere("I need one decision: what should happen to a long title?\n\n1. Reject.\n2. Cut.\n\nI'll add a test.")).toBe(true);
  expect(asksAnywhere("Fixed with `a ?? b`.\n\n```ts\nconst x = y?.z ?? 1;\n```\nTests pass.")).toBe(false);
});
