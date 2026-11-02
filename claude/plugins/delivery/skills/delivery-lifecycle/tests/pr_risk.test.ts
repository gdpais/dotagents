/**
 * Tests for pr_risk.ts: risk floor, merge route, CI state, evidence, and a branch assessed end to end.
 * Run with `bun test` from the plugin folder.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseAutonomy } from "../../../hooks/autonomy";
import { classify, type FileChange } from "../scripts/classify_change";
import { assess, ciState, evidenceFor, prRisk, render, routeFor } from "../scripts/pr_risk";

const file = (path: string, added: number, deleted = 0, lines: string[] = []): FileChange =>
  ({ path, added, deleted, binary: false, addedLines: lines.map((text, i) => ({ line: i + 1, text })) });
const level = (files: FileChange[], messages: string[] = [], review?: "ok" | "fix" | "blocking") => assess(classify(files), files, messages, review);

test("assess: low for a small change with tests; medium on gates, size and missing tests; breaking on contracts and markers", () => {
  expect(level([file("src/slug.ts", 12, 3), file("tests/slug.test.ts", 20)]).level).toBe("low");
  expect(level([file("src/slug.ts", 12, 3)])).toMatchObject({ level: "medium", reasons: [expect.stringContaining("source changed without tests")] });
  expect(level([file("src/auth/session.ts", 5, 1, ["if (isAdmin(user)) return next();"]), file("tests/session.test.ts", 9)]).reasons.join()).toContain("security gate");
  expect(level([file("src/big.ts", 700), file("tests/big.test.ts", 40)]).reasons.join()).toContain("size L");
  expect(level([file("src/slug.ts", 12), file("tests/slug.test.ts", 20)], [], "fix").reasons).toEqual(["review found P2 issues"]);
  expect(level([file("src/a.ts", 2), file("tests/a.test.ts", 2)], ["feat(api)!: drop the v1 endpoints"])).toMatchObject({ level: "breaking", reasons: [expect.stringContaining("breaking-change commit")] });
  expect(level([file("src/a.ts", 2), file("tests/a.test.ts", 2)], ["fix: x\n\nBREAKING CHANGE: config key renamed"]).level).toBe("breaking");
  expect(level([file("db/migrations/0042.sql", 1, 0, ["ALTER TABLE users DROP COLUMN legacy_id;"])]).reasons.join()).toContain("destructive migration");
  expect(level([file("api/openapi.yaml", 2, 30), file("tests/a.test.ts", 1)]).level).toBe("breaking");
  expect(level([file("api/openapi.yaml", 10, 2), file("tests/a.test.ts", 1)])).toMatchObject({ level: "medium" });
  expect(level([file("README.md", 4, 1)]).level).toBe("low");
  // Heartbeat #105 ("update grafana/k6 docker tag to v2") came out low before this rule.
  expect(level([file("tools/load/run.sh", 1, 1)], ["chore(deps): update grafana/k6 docker tag to v2"]).reasons.join()).toContain("major version bump");
  expect(level([file("tools/load/run.sh", 1, 1)], ["chore(deps): update dependency x to v1.2.3"]).level).toBe("low");
});

test("routeFor: the policy decides low and medium; breaking and blocking reviews never merge alone", () => {
  const merge = parseAutonomy({ autonomy: { merge: { low: "green", medium: "decide" } } })!.merge;
  expect(routeFor("low", merge)).toEqual({ route: "merge on green", auto: true });
  expect(routeFor("medium", merge)).toEqual({ route: "Claude decides: merge on green, block, or ask", auto: true });
  expect(routeFor("breaking", merge)).toEqual({ route: "needs your approval", auto: false });
  expect(routeFor("low", merge, "blocking")).toEqual({ route: "fix first", auto: false });
  expect(routeFor("low", null)).toEqual({ route: "needs your approval", auto: false });
  expect(routeFor("medium", parseAutonomy({ autonomy: { merge: { low: "green", medium: "yolo" } } })!.merge).auto).toBe(false);
});

test("ciState reads check runs and commit statuses", () => {
  expect(ciState([])).toBe("none");
  expect(ciState([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }])).toBe("green");
  expect(ciState([{ status: "IN_PROGRESS", conclusion: "" }, { status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("pending");
  expect(ciState([{ status: "COMPLETED", conclusion: "FAILURE" }, { status: "IN_PROGRESS" }])).toBe("red");
  expect(ciState([{ state: "PENDING" }])).toBe("pending");
});

test("evidenceFor adapts to the project: UI, service, cluster, CLI; low needs only tests and CI", () => {
  expect(evidenceFor(["apps/web/src/Login.tsx"], "low")).toHaveLength(2);
  const ui = evidenceFor(["apps/web/src/Login.tsx", "tests/login.test.ts"], "medium").join("\n");
  expect(ui).toContain("Screenshots");
  expect(ui).toContain("screen recording");
  expect(evidenceFor(["services/api/handlers/orders.go"], "medium").join()).toContain("Live demo");
  expect(evidenceFor(["infra/helm/heartbeat/values.yaml"], "medium").join()).toContain("local cluster");
  expect(evidenceFor(["cmd/tool/main.go", "cli/run.ts"], "medium").join()).toContain("command transcript");
  const breaking = evidenceFor(["services/api/openapi.yaml"], "breaking", ["make kind-e2e output"]);
  expect(breaking.join()).toContain("Upgrade path");
  expect(breaking.at(-1)).toBe("make kind-e2e output");
});

// ------------------------------------------------------------------ a real branch
let dir: string;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (...a: string[]) => { const p = Bun.spawnSync(["git", ...a], { cwd: dir, env: ENV }); if (p.exitCode) throw new Error(p.stderr.toString()); };
const put = (f: string, t: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-risk-"));
  git("init", "-q", "-b", "main");
  put("src/a.ts", "export const a = 1;\n");
  git("add", "."); git("commit", "-qm", "init");
  git("switch", "-q", "-c", "feature/x");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("prRisk --base: reads the branch's commits and the project's merge policy and evidence", async () => {
  put(".claude/delivery.json", JSON.stringify({ evidence: ["`make demo` output"], autonomy: { push: ["feature/*"], merge: { low: "green", medium: "decide" } } }));
  put("src/b.ts", "export const b = 2;\n"); put("tests/b.test.ts", "test\n");
  git("add", "src", "tests"); git("commit", "-qm", "feat: b");
  const low = await prRisk(dir, { base: "main" });
  if (typeof low === "string") throw new Error(low);
  expect(low).toMatchObject({ level: "low", route: "merge on green", auto: true, ci: "none", pr: null });
  expect(render(low)).toContain("risk: low · route: merge on green");
  put("src/c.ts", "export const c = 3;\n");
  git("add", "src"); git("commit", "-qm", "feat!: rename the config keys");
  const br = await prRisk(dir, { base: "main" });
  if (typeof br === "string") throw new Error(br);
  expect(br).toMatchObject({ level: "breaking", route: "needs your approval", auto: false });
  expect(br.evidence.at(-1)).toBe("`make demo` output");
});
