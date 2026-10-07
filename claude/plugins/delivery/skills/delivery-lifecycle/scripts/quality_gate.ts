#!/usr/bin/env bun
/**
 * Detect a repository's quality commands and, on request, run them as a gate.
 *
 * Detection is read-only: it reads manifest files (package.json, Makefile,
 * justfile, pyproject.toml, go.mod, Cargo.toml, deno.json) and lists the
 * instructions files (CLAUDE.md, AGENTS.md) that take precedence over it.
 *
 * Usage:
 *   quality_gate.ts [-C PATH]                       detect and print JSON
 *   quality_gate.ts [-C PATH] --run test,lint       run those kinds in order
 *   quality_gate.ts [-C PATH] --run all             run every detected kind
 *
 * Kinds, in run order: format, lint, typecheck, test, build.
 * Options for --run:
 *   --timeout SECONDS   per command (default 600)
 *   --keep-going        run every kind even after a failure (default: stop at the first)
 *   --tail N            output lines kept per command (default 40)
 *
 * Running executes the repository's own commands; they may write build output,
 * caches or coverage files. Exit 0 when every executed command passed (or on
 * detection), 1 when any failed, 2 on usage errors.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const KINDS = ["format", "lint", "typecheck", "test", "build"] as const;
export type Kind = (typeof KINDS)[number];
export interface Command { kind: Kind; command: string; source: string }

const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

const SCRIPT_KINDS: [Kind, RegExp][] = [
  ["format", /^(format:check|fmt:check|prettier:check|check:format|format-check)$/],
  ["lint", /^(lint|eslint|lint:all|biome)$/],
  ["typecheck", /^(typecheck|type-check|types|tsc|check:types|check-types)$/],
  ["test", /^(test|test:unit|unit)$/],
  ["build", /^(build|compile)$/],
];

export function packageManager(dir: string): string {
  try {
    const declared = /^(bun|pnpm|yarn|npm)@/.exec(JSON.parse(read(join(dir, "package.json")) ?? "{}").packageManager ?? "");
    if (declared) return declared[1];
  } catch { /* malformed package.json: fall back to lockfiles */ }
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

const makeTargets = (text: string) => new Set([...text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((m) => m[1]));
const justRecipes = (text: string) => new Set([...text.matchAll(/^@?([A-Za-z0-9_-]+)(?:\s+[^:=\n]*)?:(?!=)/gm)].map((m) => m[1]));

export function detect(dir: string) {
  const stacks: string[] = [];
  const commands: Command[] = [];
  const add = (kind: Kind, command: string, source: string) => {
    if (!commands.some((c) => c.kind === kind)) commands.push({ kind, command, source });
  };

  // Task runners first: when a repo defines `make test`, that is its documented entry point.
  const makefile = read(join(dir, "Makefile"));
  if (makefile) {
    const t = makeTargets(makefile);
    for (const [kind, names] of [["format", ["fmt-check", "format-check"]], ["lint", ["lint"]], ["typecheck", ["typecheck", "type-check"]], ["test", ["test"]], ["build", ["build"]]] as [Kind, string[]][]) {
      const hit = names.find((n) => t.has(n));
      if (hit) add(kind, `make ${hit}`, `Makefile target ${hit}`);
    }
  }
  const justfile = read(join(dir, "justfile")) ?? read(join(dir, "Justfile"));
  if (justfile) {
    const r = justRecipes(justfile);
    for (const kind of KINDS) if (r.has(kind)) add(kind, `just ${kind}`, `justfile recipe ${kind}`);
  }

  const pkgText = read(join(dir, "package.json"));
  if (pkgText) {
    stacks.push("node");
    const pm = packageManager(dir);
    let scripts: Record<string, string> = {};
    try { scripts = JSON.parse(pkgText).scripts ?? {}; } catch { /* malformed package.json: no scripts */ }
    for (const [kind, re] of SCRIPT_KINDS) {
      const name = Object.keys(scripts).find((s) => re.test(s));
      if (name && !(kind === "test" && /no test specified/.test(scripts[name]))) {
        add(kind, pm === "npm" && name === "test" ? "npm test" : `${pm} run ${name}`, `package.json scripts.${name}`);
      }
    }
    if (!commands.some((c) => c.kind === "typecheck") && existsSync(join(dir, "tsconfig.json"))) {
      add("typecheck", pm === "bun" ? "bunx tsc --noEmit" : "npx tsc --noEmit", "tsconfig.json present");
    }
    if (!commands.some((c) => c.kind === "test") && pm === "bun") add("test", "bun test", "bun project default");
  }

  const deno = read(join(dir, "deno.json")) ?? read(join(dir, "deno.jsonc"));
  if (deno !== null) {
    stacks.push("deno");
    add("format", "deno fmt --check", "deno.json");
    add("lint", "deno lint", "deno.json");
    add("typecheck", "deno check .", "deno.json");
    add("test", "deno test", "deno.json");
  }

  const pyproject = read(join(dir, "pyproject.toml"));
  const reqs = read(join(dir, "requirements-dev.txt")) ?? read(join(dir, "requirements.txt")) ?? "";
  if (pyproject !== null || existsSync(join(dir, "setup.py")) || reqs) {
    stacks.push("python");
    const all = (pyproject ?? "") + "\n" + reqs + "\n" + (read(join(dir, "setup.cfg")) ?? "");
    const runner = existsSync(join(dir, "uv.lock")) ? "uv run " : existsSync(join(dir, "poetry.lock")) ? "poetry run " : "";
    if (/\bruff\b/.test(all)) { add("format", `${runner}ruff format --check .`, "ruff configured"); add("lint", `${runner}ruff check .`, "ruff configured"); }
    else if (/\bblack\b/.test(all)) add("format", `${runner}black --check .`, "black configured");
    if (!commands.some((c) => c.kind === "lint") && /\bflake8\b/.test(all)) add("lint", `${runner}flake8`, "flake8 configured");
    if (/\bmypy\b/.test(all)) add("typecheck", `${runner}mypy .`, "mypy configured");
    else if (/\bpyright\b/.test(all)) add("typecheck", `${runner}pyright`, "pyright configured");
    if (/\bpytest\b/.test(all) || existsSync(join(dir, "pytest.ini")) || existsSync(join(dir, "conftest.py"))) add("test", `${runner}pytest -q`, "pytest configured");
    else add("test", `${runner}python -m unittest`, "python default");
  }

  if (existsSync(join(dir, "go.mod"))) {
    stacks.push("go");
    add("format", "test -z \"$(gofmt -l .)\"", "go.mod");
    add("lint", existsSync(join(dir, ".golangci.yml")) || existsSync(join(dir, ".golangci.yaml")) ? "golangci-lint run" : "go vet ./...", "go.mod");
    add("test", "go test ./...", "go.mod");
    add("build", "go build ./...", "go.mod");
  }

  if (existsSync(join(dir, "Cargo.toml"))) {
    stacks.push("rust");
    add("format", "cargo fmt --check", "Cargo.toml");
    add("lint", "cargo clippy --all-targets -- -D warnings", "Cargo.toml");
    add("test", "cargo test", "Cargo.toml");
    add("build", "cargo build", "Cargo.toml");
  }

  const instructions = ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"].filter((f) => existsSync(join(dir, f)));
  let ci: string[] = [];
  try { ci = readdirSync(join(dir, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`); } catch { /* none */ }

  commands.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  return {
    dir, stacks, commands,
    missing: KINDS.filter((k) => !commands.some((c) => c.kind === k)),
    instructions, ci_workflows: ci,
    note: instructions.length ? "Instructions files may define the authoritative commands; read them before trusting this detection." : undefined,
  };
}

/** bun, jest, vitest, mocha and pytest (exit 5) messages for "no test files found". */
export function noTestFiles(output: string, code: number | null): boolean {
  return /\b0 test files matching\b|No tests found, exiting with code|No test files found|Error: No test files found/.test(output)
    || (code === 5 && /\bno tests ran\b/i.test(output));
}

export async function runCommand(cmd: Command, dir: string, timeoutS: number, tail: number) {
  const started = performance.now();
  // Own process group, so a timeout kills the whole tree: a surviving child (make → sleep)
  // would hold the output pipes open and the wait below would outlast the timeout.
  const proc = Bun.spawn(["sh", "-c", cmd.command], { cwd: dir, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
  }, timeoutS * 1000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const lines = (out + (err ? "\n" + err : "")).trimEnd().split("\n");
  // A test runner that found no test files is a missing-tests note, not a failing test.
  const noTests = cmd.kind === "test" && code !== 0 && !timedOut && noTestFiles(out + "\n" + err, code);
  return {
    ...cmd, exit_code: code, passed: (code === 0 || noTests) && !timedOut, timed_out: timedOut, no_tests: noTests,
    duration_s: Math.round((performance.now() - started) / 100) / 10,
    output_tail: lines.slice(-tail).join("\n"),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: {
      help: { type: "boolean", short: "h" }, C: { type: "string", short: "C" }, run: { type: "string" },
      timeout: { type: "string" }, "keep-going": { type: "boolean" }, tail: { type: "string" } } }));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (values.help) { console.log("usage: quality_gate.ts [-C PATH] [--run all|KIND[,KIND...]] [--timeout S] [--keep-going] [--tail N]"); return 0; }
  const dir = values.C ?? process.cwd();
  const found = detect(dir);
  if (!values.run) { console.log(JSON.stringify(found, null, 2)); return 0; }

  const wanted = values.run === "all" ? [...KINDS] : values.run.split(",").map((s) => s.trim());
  const bad = wanted.filter((k) => !(KINDS as readonly string[]).includes(k));
  if (bad.length) { console.error(`unknown kind(s): ${bad.join(", ")}; expected ${KINDS.join(", ")} or all`); return 2; }
  const results = [];
  for (const cmd of found.commands.filter((c) => wanted.includes(c.kind))) {
    const r = await runCommand(cmd, dir, Number(values.timeout ?? 600), Number(values.tail ?? 40));
    results.push(r);
    if (!r.passed && !values["keep-going"]) break;
  }
  const notRun = wanted.filter((k) => !results.some((r) => r.kind === k));
  const passed = results.length > 0 && results.every((r) => r.passed);
  console.log(JSON.stringify({ dir, passed, results, not_run: notRun, not_detected: notRun.filter((k) => !found.commands.some((c) => c.kind === k)) }, null, 2));
  return passed ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
