/**
 * Tests for scripts/quality_gate.ts. Run with `bun test` from the skill folder.
 * Each test builds a throwaway project directory.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detect } from "../scripts/quality_gate";

const SCRIPT = join(import.meta.dir, "..", "scripts", "quality_gate.ts");
let dir: string;
const put = (name: string, text: string) => {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), text);
};
const cli = (...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, SCRIPT, "-C", dir, ...args]);
  return [p.exitCode, JSON.parse(p.stdout.toString())] as const;
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "qgate-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("node project: package manager from lockfile and scripts mapped to kinds", () => {
  put("package.json", JSON.stringify({ scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "vitest run", build: "vite build" } }));
  put("pnpm-lock.yaml", "");
  const r = detect(dir);
  expect(r.stacks).toEqual(["node"]);
  expect(r.commands.map((c) => c.command)).toEqual(["pnpm run lint", "pnpm run typecheck", "pnpm run test", "pnpm run build"]);
  expect(r.missing).toEqual(["format"]);
});

test("packageManager field wins over lockfiles", () => {
  put("package.json", JSON.stringify({ packageManager: "bun@1.4.2", scripts: { test: "bun test" } }));
  put("package-lock.json", "{}");
  expect(detect(dir).commands[0].command).toBe("bun run test");
});

test("npm placeholder test script is ignored; tsconfig adds a typecheck", () => {
  put("package.json", JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  put("tsconfig.json", "{}");
  const r = detect(dir);
  expect(r.commands.find((c) => c.kind === "test")).toBeUndefined();
  expect(r.commands.find((c) => c.kind === "typecheck")!.command).toBe("npx tsc --noEmit");
});

test("Makefile targets win over manifest defaults", () => {
  put("Makefile", "test:\n\tgo test ./...\nlint:\n\tgolangci-lint run\n");
  put("go.mod", "module x\n");
  const r = detect(dir);
  expect(r.commands.find((c) => c.kind === "test")!.command).toBe("make test");
  expect(r.commands.find((c) => c.kind === "build")!.command).toBe("go build ./...");
});

test("python project with uv, ruff, mypy and pytest", () => {
  put("pyproject.toml", "[tool.ruff]\n[tool.mypy]\n[project.optional-dependencies]\ndev=['pytest']\n");
  put("uv.lock", "");
  const r = detect(dir);
  expect(r.commands.map((c) => c.command)).toEqual(["uv run ruff format --check .", "uv run ruff check .", "uv run mypy .", "uv run pytest -q"]);
});

test("rust project and instructions files are reported", () => {
  put("Cargo.toml", "[package]\nname='x'\n");
  put("CLAUDE.md", "# rules\n");
  const r = detect(dir);
  expect(r.stacks).toContain("rust");
  expect(r.instructions).toEqual(["CLAUDE.md"]);
  expect(r.note).toBeDefined();
});

test("--run executes in kind order and stops at the first failure", () => {
  put("Makefile", "lint:\n\t@echo linted\ntest:\n\t@echo boom && exit 3\nbuild:\n\t@echo built\n");
  const [code, out] = cli("--run", "all");
  expect(code).toBe(1);
  expect(out.passed).toBe(false);
  expect(out.results.map((r: any) => [r.kind, r.passed])).toEqual([["lint", true], ["test", false]]);
  expect(out.results[1].exit_code).toBe(2); // make reports a failed recipe as 2
  expect(out.results[1].output_tail).toContain("boom");
  expect(out.not_run).toContain("build");
});

test("--keep-going runs everything; passing gate exits 0", () => {
  put("Makefile", "lint:\n\t@true\ntest:\n\t@true\n");
  const [code, out] = cli("--run", "lint,test", "--keep-going");
  expect(code).toBe(0);
  expect(out.passed).toBe(true);
});

test("--timeout marks a hung command as failed and kills its children", () => {
  // `sleep` runs as a grandchild that inherits the output pipes; killing only `sh` would leave it running.
  put("Makefile", "test:\n\t@sleep 8; echo done\n");
  const started = performance.now();
  const [code, out] = cli("--run", "test", "--timeout", "1");
  expect(code).toBe(1);
  expect(out.results[0].timed_out).toBe(true);
  expect(performance.now() - started).toBeLessThan(4000);
}, 10_000);

test("unknown kind is a usage error", () => {
  const p = Bun.spawnSync([process.execPath, SCRIPT, "-C", dir, "--run", "deploy"]);
  expect(p.exitCode).toBe(2);
});

test("noTestFiles: runners' no-tests messages, not real failures", async () => {
  const { noTestFiles } = await import("../scripts/quality_gate");
  expect(noTestFiles('error: 0 test files matching **{.test,.spec}.{js,ts} in --cwd="/x"', 1)).toBe(true);
  expect(noTestFiles("No tests found, exiting with code 1", 1)).toBe(true);
  expect(noTestFiles("No test files found, exiting with code 1", 1)).toBe(true);
  expect(noTestFiles("collected 0 items\n=== no tests ran in 0.01s ===", 5)).toBe(true);
  expect(noTestFiles("1 failed, 3 passed", 1)).toBe(false);
  expect(noTestFiles("no tests ran", 1)).toBe(false);
});
