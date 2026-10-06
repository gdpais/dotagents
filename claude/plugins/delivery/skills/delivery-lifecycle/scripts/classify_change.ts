#!/usr/bin/env bun
/**
 * Classify a code change and decide which verification gates it needs.
 *
 * Read-only: runs only `git rev-parse`, `git diff --numstat`, `git diff -U0`
 * and `git ls-files`. It never fetches, checks out, commits, or writes files.
 *
 * Target (one of; default --uncommitted):
 *   --base BRANCH     changes that would merge into BRANCH (diff from the merge base)
 *   --range RANGE     any `git diff` range, e.g. a1b2c3..HEAD or main...feature
 *   --uncommitted     staged + unstaged changes against HEAD, plus untracked files
 *
 * Options:
 *   -C PATH           repository to inspect (default: current directory)
 *   --config FILE     project overrides (default: <repo>/.claude/delivery.json if present):
 *                     {"hotPaths": [globs], "securityPaths": [globs], "ignore": [globs]}
 *
 * Output: one JSON object on stdout with totals, size, per-gate decisions
 * (required | suggested | skip, each with the signals that triggered it) and the
 * ordered list of skills to run next. Exit 0 on success, 2 on error.
 *
 * The signals are heuristics that decide where to spend review effort; they never
 * prove that a change is safe. A gate set to `skip` only means no signal fired.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

type Level = "required" | "suggested" | "skip";
interface Signal { signal: string; file: string; line?: number }
interface Gate { level: Level; signals: Signal[] }
interface Config { hotPaths?: string[]; securityPaths?: string[]; ignore?: string[] }
export interface FileChange { path: string; added: number; deleted: number; binary: boolean; addedLines: { line: number; text: string }[] }

/** Run git; return stdout or null on failure. */
async function git(args: string[], cwd?: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- path rules
const GENERATED = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|uv\.lock)$/,
  /(^|\/)(dist|build|vendor|node_modules|\.next|coverage|__snapshots__)\//, /\.min\.(js|css)$/, /\.snap$/, /\.(pb|generated)\.\w+$/,
];
const DEPENDENCY = /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|uv\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|composer\.(json|lock))$/;
const MIGRATION = /(^|\/)(migrations?|migrate|alembic|flyway|liquibase|db\/schema)\/|\.sql$|(^|\/)schema\.(prisma|rb)$/i;
const INFRA = /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.yml$|Jenkinsfile$|\.circleci\/|azure-pipelines\.yml$|Dockerfile[^/]*$|docker-compose[^/]*\.ya?ml$|compose\.ya?ml$|helm\/|charts\/|k8s\/|kubernetes\/|manifests\/|terraform\/|Procfile$|fly\.toml$|vercel\.json$|netlify\.toml$|serverless\.ya?ml$)|\.tf$|\.tfvars$/;
const SECURITY_PATH = /(^|[\/_.-])(auth\w*|login|logout|session|sessions|token|tokens|oauth|oidc|saml|jwt|password|passwd|crypto|secret|secrets|permission|permissions|rbac|acl|iam|policy|policies|security|csrf|cors|sanitiz\w*|middleware)([\/_.-]|$)|(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx)$/i;
const TEST = /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|\.(test|spec)\.\w+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|scala|c|cc|cpp|h|hpp|ex|exs|vue|svelte)$/i;
const DOCS = /\.(md|mdx|rst|txt|adoc)$/i;

// ------------------------------------------------------------- content rules
// Patterns are checked against added lines only. Each has a short, stable signal name.
const SECURITY_CONTENT: [string, RegExp][] = [
  ["dynamic code execution", /\beval\s*\(|new\s+Function\s*\(|(?<![.\w$])exec(?:Sync|File|FileSync)?\s*\(|\b(?:child_process|childProcess|cp)\.(?:exec|spawn)\w*\s*\(|child_process|subprocess\.|os\.system\(|Runtime\.getRuntime\(\)\.exec/],
  ["raw HTML injection sink", /innerHTML\s*=|dangerouslySetInnerHTML|v-html=|\|\s*safe\b|mark_safe\(/],
  ["unsafe deserialization", /pickle\.loads?\(|yaml\.load\((?![^)]*SafeLoader)|ObjectInputStream|unserialize\(|Marshal\.load/],
  ["weak hash or randomness", /\b(md5|sha1)\b|Math\.random\(\)/i],
  ["TLS verification disabled", /verify\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED/],
  ["string-built SQL", /(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*(\$\{|"\s*\+|'\s*\+|%s|\{\w*\}|\.format\()/i],
  ["CORS or security header change", /Access-Control-Allow-Origin|\bcors\s*\(|Content-Security-Policy|X-Frame-Options/i],
  ["credential-like literal", /(password|passwd|secret|api[_-]?key|token|private[_-]?key)\s*[:=]\s*["'][^"'\s]{8,}["']/i],
  ["auth decision", /\b(isAdmin|is_admin|hasRole|has_role|authorize|authorise|permission_required|@PreAuthorize|checkPermission|can\?)\b/],
];
const PERF_CONTENT: [string, RegExp][] = [
  ["query inside loop candidate", /\b(for|forEach|map|while)\b.*\b(await|query|find\w*|select|fetch)\b/i],
  ["ORM or SQL query", /\.(findMany|findAll|findOne|filter|select_related|prefetch_related|objects\.|where|join|include)\s*\(|\b(SELECT|JOIN|GROUP BY|ORDER BY)\b/],
  ["unbounded read", /\.all\(\)|SELECT \*|readFileSync|\.read\(\)|fetchAll|LIMIT\s+\d{5,}/i],
  ["blocking or sleep call", /\b(sleep|usleep|Thread\.sleep|time\.sleep|setTimeout\s*\([^,]+,\s*\d{4,})\b/],
  ["concurrency primitive", /\b(Promise\.all|goroutine|go func|sync\.Mutex|threading|asyncio\.gather|Lock\(\)|ThreadPool|worker_threads)\b/],
  ["cache behaviour", /\b(cache|memoize|lru_cache|ttl|invalidate)\b/i],
  ["index or schema change", /CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+INDEX|ALTER\s+TABLE|add_index|createIndex/i],
];
const MIGRATION_CONTENT: [string, RegExp][] = [
  ["destructive schema change", /DROP\s+(TABLE|COLUMN)|ALTER\s+TABLE\s+\S+\s+DROP|remove_column|drop_table|dropColumn|RENAME\s+(COLUMN|TO)/i],
  ["locking schema change", /ALTER\s+TABLE[^;]*(ADD\s+COLUMN[^;]*NOT\s+NULL(?![^;]*DEFAULT)|ALTER\s+COLUMN[^;]*TYPE)|CREATE\s+(UNIQUE\s+)?INDEX(?!\s+CONCURRENTLY)/i],
];

export function globsToRegex(globs: string[] = []): RegExp[] {
  return globs.map((g) => {
    let re = "";
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === "*" && g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; }
      else if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`);
  });
}

const matchAny = (res: RegExp[], path: string) => res.some((r) => r.test(path));

export function classify(changes: FileChange[], config: Config = {}) {
  const ignore = globsToRegex(config.ignore);
  const hot = globsToRegex(config.hotPaths);
  const secPaths = globsToRegex(config.securityPaths);
  const files = changes.filter((f) => !matchAny(ignore, f.path));
  const generated = files.filter((f) => GENERATED.some((r) => r.test(f.path)));
  const reviewed = files.filter((f) => !generated.includes(f));

  const gate = (): Gate => ({ level: "skip", signals: [] });
  const gates = { review: gate(), security: gate(), performance: gate(), migrations: gate(), dependencies: gate(), infra: gate(), tests: gate(), docs: gate() };
  const raise = (g: Gate, level: Level, s: Signal) => {
    if (level === "required" || g.level === "skip") g.level = level;
    if (!g.signals.some((x) => x.signal === s.signal && x.file === s.file)) g.signals.push(s);
  };
  const scan = (g: Gate, level: Level, rules: [string, RegExp][], f: FileChange, max = 3) => {
    let hits = 0;
    for (const { line, text } of f.addedLines) {
      for (const [name, re] of rules) {
        if (re.test(text) && !g.signals.some((x) => x.signal === name && x.file === f.path)) {
          raise(g, level, { signal: name, file: f.path, line });
          if (++hits >= max) return;
        }
      }
    }
  };

  for (const f of files) {
    if (DEPENDENCY.test(f.path)) {
      raise(gates.dependencies, "required", { signal: "dependency manifest or lockfile changed", file: f.path });
      raise(gates.security, "required", { signal: "supply-chain: dependency change", file: f.path });
    }
  }
  for (const f of reviewed) {
    const isTest = TEST.test(f.path);
    if (MIGRATION.test(f.path)) {
      raise(gates.migrations, "required", { signal: "migration or schema file", file: f.path });
      raise(gates.performance, "suggested", { signal: "schema change can alter query plans", file: f.path });
      scan(gates.migrations, "required", MIGRATION_CONTENT, f);
    }
    if (INFRA.test(f.path)) {
      raise(gates.infra, "required", { signal: "CI/CD or infrastructure file", file: f.path });
      raise(gates.security, "suggested", { signal: "pipeline or infra permissions surface", file: f.path });
    }
    if (!isTest && matchAny(secPaths, f.path)) raise(gates.security, "required", { signal: "configured security path", file: f.path });
    else if (!isTest && SECURITY_PATH.test(f.path)) raise(gates.security, "required", { signal: "security-sensitive path", file: f.path });
    if (!isTest && matchAny(hot, f.path)) raise(gates.performance, "required", { signal: "configured hot path", file: f.path });
    if (!isTest && SOURCE.test(f.path)) {
      scan(gates.security, "required", SECURITY_CONTENT, f);
      scan(gates.performance, "suggested", PERF_CONTENT, f);
    }
  }

  const sourceChanged = reviewed.filter((f) => SOURCE.test(f.path) && !TEST.test(f.path) && !MIGRATION.test(f.path) && f.added + f.deleted > 0);
  const testsChanged = reviewed.filter((f) => TEST.test(f.path));
  if (sourceChanged.length && !testsChanged.length) {
    for (const f of sourceChanged.slice(0, 10)) raise(gates.tests, "required", { signal: "source changed with no test change", file: f.path });
  } else if (sourceChanged.length) {
    gates.tests.level = "suggested";
    gates.tests.signals.push({ signal: `${testsChanged.length} test file(s) changed alongside ${sourceChanged.length} source file(s)`, file: "" });
  }
  const docsChanged = reviewed.some((f) => DOCS.test(f.path));
  const publicSurface = reviewed.filter((f) => /(^|\/)(api|public|routes?|openapi|proto|graphql|sdk|cli)(\/|\.|$)/i.test(f.path) && !TEST.test(f.path));
  if (publicSurface.length && !docsChanged) for (const f of publicSurface.slice(0, 5)) raise(gates.docs, "suggested", { signal: "public surface changed with no docs change", file: f.path });

  const added = reviewed.reduce((n, f) => n + f.added, 0);
  const deleted = reviewed.reduce((n, f) => n + f.deleted, 0);
  const lines = added + deleted;
  const size = lines === 0 ? "none" : lines < 50 ? "S" : lines < 400 ? "M" : lines < 1000 ? "L" : "XL";
  if (reviewed.length) {
    gates.review.level = "required";
    gates.review.signals.push({ signal: `${reviewed.length} file(s), +${added}/-${deleted}`, file: "" });
  }
  const fanOut = lines >= 400 || reviewed.length >= 10 || gates.security.level === "required";

  const next: string[] = [];
  if (gates.tests.level === "required" || reviewed.some((f) => SOURCE.test(f.path))) next.push("quality_gate.ts --run all");
  if (gates.review.level !== "skip") next.push(fanOut ? "defect-first-review (fan out lenses)" : "defect-first-review");
  if (gates.security.level === "required") next.push("security-review + scan_secrets.ts");
  if (gates.performance.level === "required") next.push("performance-review");
  if (gates.infra.level === "required") next.push("ci-cd-pipeline (audit)");
  if (gates.migrations.level === "required") next.push("engineering:deploy-checklist (migration plan)");

  return {
    totals: { files: files.length, reviewed_files: reviewed.length, added, deleted },
    size,
    fan_out: fanOut,
    changed: reviewed.map((f) => f.path),
    generated: generated.map((f) => f.path),
    gates,
    next,
    note: "Heuristic signals decide where to spend effort; a skipped gate means no signal fired, not that the change is safe.",
  };
}

// ------------------------------------------------------------- git plumbing
export function parseNumstat(raw: string): Map<string, FileChange> {
  const out = new Map<string, FileChange>();
  for (const line of raw.split("\n")) {
    const parts = line.split("\t");
    if (parts.length !== 3) continue;
    const [a, d, p] = parts;
    const path = p.includes(" => ") ? p.replace(/\{([^}]*) => ([^}]*)\}/, "$2").replace(/^.* => /, "") : p;
    out.set(path, { path, added: a === "-" ? 0 : +a, deleted: d === "-" ? 0 : +d, binary: a === "-", addedLines: [] });
  }
  return out;
}

export function attachAddedLines(raw: string, files: Map<string, FileChange>) {
  let current: FileChange | undefined;
  let lineNo = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "");
      current = p === "/dev/null" ? undefined : files.get(p);
    } else if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      lineNo = m ? +m[1] : 0;
    } else if (current && line.startsWith("+")) {
      current.addedLines.push({ line: lineNo++, text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      lineNo++;
    }
  }
}

export async function collect(cwd: string | undefined, diffArgs: string[], includeUntracked: boolean): Promise<FileChange[] | string> {
  const [numstat, patch] = await Promise.all([git(["diff", "--numstat", "-M", ...diffArgs], cwd), git(["diff", "-U0", "-M", "--no-color", ...diffArgs], cwd)]);
  if (numstat === null || patch === null) return `git diff ${diffArgs.join(" ")} failed`;
  const files = parseNumstat(numstat);
  attachAddedLines(patch, files);
  if (includeUntracked) {
    const untracked = (await git(["ls-files", "--others", "--exclude-standard"], cwd)) ?? "";
    for (const path of untracked.split("\n").filter(Boolean)) {
      const full = join(cwd ?? ".", path);
      let text = "";
      try { text = (await Bun.file(full).size) < 1_000_000 ? await Bun.file(full).text() : ""; } catch { /* unreadable */ }
      const binary = text.includes("\u0000");
      const lines = binary || !text ? [] : text.split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      files.set(path, { path, added: lines.length, deleted: 0, binary, addedLines: lines.map((t, i) => ({ line: i + 1, text: t })) });
    }
  }
  return [...files.values()];
}

export interface Target { base?: string; range?: string }
export type Classified = ReturnType<typeof classify> & { target: Record<string, string>; diffArgs: string[]; config: string | null };

/** Resolve the target, read .claude/delivery.json, collect the diff and classify it. Returns an error string on failure. */
export async function classifyRepo(cwd: string | undefined, target: Target = {}, configPath?: string): Promise<Classified | string> {
  const top = (await git(["rev-parse", "--show-toplevel"], cwd))?.trim();
  if (!top) return "not inside a git work tree";
  let config: Config = {};
  const path = configPath ?? join(top, ".claude", "delivery.json");
  if (existsSync(path)) {
    try { config = JSON.parse(readFileSync(path, "utf8")); } catch (e) { return `cannot parse ${path}: ${(e as Error).message}`; }
  }
  let t: Record<string, string>, diffArgs: string[], untracked: boolean;
  if (target.base !== undefined) {
    const mb = (await git(["merge-base", "HEAD", target.base], cwd))?.trim();
    if (!mb) return `no merge base between HEAD and ${target.base}`;
    t = { mode: "base", base: target.base, merge_base: mb }; diffArgs = [mb]; untracked = true;
  } else if (target.range !== undefined) {
    t = { mode: "range", range: target.range }; diffArgs = [target.range]; untracked = false;
  } else {
    const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], cwd))?.trim();
    t = { mode: "uncommitted", head: head ?? "" }; diffArgs = head ? ["HEAD"] : ["--cached"]; untracked = true;
  }
  const changes = await collect(cwd, diffArgs, untracked);
  if (typeof changes === "string") return changes;
  return { target: t, diffArgs, config: existsSync(path) ? path : null, ...classify(changes, config) };
}

const USAGE = "usage: classify_change.ts [--base BRANCH | --range RANGE | --uncommitted] [-C PATH] [--config FILE]";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: {
      help: { type: "boolean", short: "h" }, base: { type: "string" }, range: { type: "string" },
      uncommitted: { type: "boolean" }, C: { type: "string", short: "C" }, config: { type: "string" } } }));
  } catch (e) {
    console.error(`${USAGE}\n${(e as Error).message}`);
    return 2;
  }
  if (values.help) { console.log(USAGE); return 0; }
  if ([values.base, values.range, values.uncommitted].filter((v) => v !== undefined).length > 1) {
    console.error(`${USAGE}\nchoose one of --base, --range, --uncommitted`);
    return 2;
  }
  const r = await classifyRepo(values.C, { base: values.base, range: values.range }, values.config);
  if (typeof r === "string") { console.log(JSON.stringify({ error: r })); return 2; }
  const { diffArgs: _d, ...out } = r;
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

if (import.meta.main) process.exit(await main());
