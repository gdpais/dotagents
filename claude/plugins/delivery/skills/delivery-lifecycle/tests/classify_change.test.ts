/**
 * Tests for scripts/classify_change.ts. Run with `bun test` from the skill folder.
 * Unit tests call classify() directly; CLI tests build a throwaway git repository.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { attachAddedLines, classify, globsToRegex, parseNumstat, type FileChange } from "../scripts/classify_change";

const SCRIPT = join(import.meta.dir, "..", "scripts", "classify_change.ts");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};

const change = (path: string, lines: string[] = [], deleted = 0): FileChange => ({
  path, added: lines.length, deleted, binary: false, addedLines: lines.map((text, i) => ({ line: i + 1, text })),
});

test("docs-only change needs review but no security, perf or tests gate", () => {
  const r = classify([change("README.md", ["hello"])]);
  expect(r.gates.review.level).toBe("required");
  expect(r.gates.security.level).toBe("skip");
  expect(r.gates.performance.level).toBe("skip");
  expect(r.gates.tests.level).toBe("skip");
  expect(r.size).toBe("S");
  expect(r.next).toEqual(["defect-first-review"]);
});

test("auth path and source without tests trigger security and tests gates", () => {
  const r = classify([change("src/auth/session.ts", ["export const x = 1;"])]);
  expect(r.gates.security.level).toBe("required");
  expect(r.gates.security.signals[0].signal).toBe("security-sensitive path");
  expect(r.gates.tests.level).toBe("required");
  expect(r.fan_out).toBe(true);
  expect(r.next).toContain("security-review + scan_secrets.ts");
});

test("test files are not treated as security-sensitive by path", () => {
  const r = classify([change("tests/auth/session.test.ts", ["expect(1).toBe(1)"])]);
  expect(r.gates.security.level).toBe("skip");
});

test("content signals: string-built SQL and query in loop", () => {
  const r = classify([
    change("src/orders.ts", ["const q = `SELECT * FROM orders WHERE id = ${id}`;", "for (const o of orders) { await db.find(o.id) }"]),
    change("src/orders.test.ts", ["test('x', () => {})"]),
  ]);
  const sec = r.gates.security.signals.map((s) => s.signal);
  expect(sec).toContain("string-built SQL");
  expect(r.gates.performance.level).toBe("suggested");
  expect(r.gates.performance.signals.map((s) => s.signal)).toContain("query inside loop candidate");
  expect(r.gates.tests.level).toBe("suggested");
});

test("dependency change requires dependency and supply-chain security gates; lockfile excluded from size", () => {
  const r = classify([change("package.json", ['"left-pad": "^1.0.0"']), change("package-lock.json", Array(500).fill("x"))]);
  expect(r.gates.dependencies.level).toBe("required");
  expect(r.gates.security.signals.map((s) => s.signal)).toContain("supply-chain: dependency change");
  expect(r.generated).toEqual(["package-lock.json"]);
  expect(r.totals.added).toBe(1);
});

test("migrations flag destructive and locking statements", () => {
  const r = classify([change("db/migrations/0042_drop.sql", ["ALTER TABLE users DROP COLUMN legacy;", "CREATE INDEX idx_a ON t(a);"])]);
  expect(r.gates.migrations.level).toBe("required");
  const sig = r.gates.migrations.signals.map((s) => s.signal);
  expect(sig).toContain("destructive schema change");
  expect(sig).toContain("locking schema change");
  expect(r.next).toContain("engineering:deploy-checklist (migration plan)");
});

test("CONCURRENTLY index is not flagged as locking", () => {
  const r = classify([change("migrations/1.sql", ["CREATE INDEX CONCURRENTLY idx ON t(a);"])]);
  expect(r.gates.migrations.signals.map((s) => s.signal)).not.toContain("locking schema change");
});

test("CI workflow change requires infra gate", () => {
  const r = classify([change(".github/workflows/ci.yml", ["on: push"])]);
  expect(r.gates.infra.level).toBe("required");
  expect(r.next).toContain("ci-cd-pipeline (audit)");
});

test("config hot paths and ignores apply", () => {
  const cfg = { hotPaths: ["src/checkout/**"], ignore: ["docs/**"] };
  const r = classify([change("src/checkout/price.ts", ["return a + b"]), change("docs/big.md", Array(2000).fill("x"))], cfg);
  expect(r.gates.performance.level).toBe("required");
  expect(r.totals.files).toBe(1);
  expect(r.next).toContain("performance-review");
});

test("size buckets and fan-out by volume", () => {
  expect(classify([change("a.ts", Array(60).fill("x"))]).size).toBe("M");
  const big = classify([change("a.ts", Array(450).fill("x"))]);
  expect(big.size).toBe("L");
  expect(big.fan_out).toBe(true);
});

test("globsToRegex handles ** and *", () => {
  const [re] = globsToRegex(["src/**/*.ts"]);
  expect(re.test("src/a/b/c.ts")).toBe(true);
  expect(re.test("src/c.ts")).toBe(true);
  expect(re.test("lib/c.ts")).toBe(false);
});

test("parseNumstat and attachAddedLines track renames and line numbers", () => {
  const files = parseNumstat("3\t1\tsrc/{old => new}.ts\n-\t-\timg.png\n");
  expect([...files.keys()]).toEqual(["src/new.ts", "img.png"]);
  attachAddedLines("+++ b/src/new.ts\n@@ -1 +10,2 @@\n+one\n+two\n", files);
  expect(files.get("src/new.ts")!.addedLines).toEqual([{ line: 10, text: "one" }, { line: 11, text: "two" }]);
  expect(files.get("img.png")!.binary).toBe(true);
});

// ------------------------------------------------------------------ CLI
let root: string;
const sh = (...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd: root, env: GIT_ENV });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};
const put = (name: string, text: string) => {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), text);
};
const cli = (...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, SCRIPT, "-C", root, ...args], { env: GIT_ENV });
  return [p.exitCode, JSON.parse(p.stdout.toString())] as const;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "classify-"));
  sh("init", "-q", "-b", "main");
  put("src/app.ts", "export const a = 1;\n");
  sh("add", ".");
  sh("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("CLI --uncommitted includes untracked files and leaves the repo unchanged", () => {
  put("src/login.ts", "const pw = eval(input);\n");
  const before = sh("status", "--porcelain");
  const [code, out] = cli();
  expect(code).toBe(0);
  expect(out.target.mode).toBe("uncommitted");
  expect(out.gates.security.level).toBe("required");
  expect(out.gates.security.signals.map((s: any) => s.signal)).toContain("dynamic code execution");
  expect(sh("status", "--porcelain")).toBe(before);
});

test("CLI --base diffs from the merge base and reads .claude/delivery.json", () => {
  sh("checkout", "-q", "-b", "feature");
  put(".claude/delivery.json", JSON.stringify({ hotPaths: ["src/**"] }));
  put("src/app.ts", "export const a = 2;\n");
  sh("add", ".");
  sh("commit", "-q", "-m", "change");
  const [code, out] = cli("--base", "main");
  expect(code).toBe(0);
  expect(out.target.mode).toBe("base");
  expect(out.gates.performance.level).toBe("required");
});

test("CLI reports an error outside a repository", () => {
  const p = Bun.spawnSync([process.execPath, SCRIPT, "-C", tmpdir()], { env: GIT_ENV });
  expect(p.exitCode).toBe(2);
});
