#!/usr/bin/env bun
/**
 * Audit GitHub Actions workflows for security and reliability problems, and map
 * which delivery gates the pipeline actually enforces.
 *
 * Read-only: parses .github/workflows/*.yml|yaml with Bun's YAML parser.
 *
 * Usage: audit_ci.ts [-C REPO] [FILE...]
 *
 * Checks (id, level):
 *   CI01 high    third-party action not pinned to a full commit SHA
 *   CI02 low     first-party actions/* pinned to a tag rather than a SHA
 *   CI03 medium  no `permissions` at workflow or job level (token defaults may be broad)
 *   CI04 high    `permissions: write-all`
 *   CI05 high    pull_request_target / workflow_run job checks out untrusted PR code
 *   CI06 high    untrusted event data interpolated into a `run:` script (script injection)
 *   CI07 high    a secret is echoed or printed in a `run:` script
 *   CI08 low     job without `timeout-minutes`
 *   CI09 medium  deploy/release job without `environment` (no protection rules or approvals)
 *   CI10 medium  deploy/release workflow without `concurrency`
 *   CI11 medium  self-hosted runner reachable from pull_request events
 *   CI12 low     actions/checkout keeps credentials (`persist-credentials` not false)
 *
 * Output: JSON {workflows, findings, gates}. `gates` says whether lint, typecheck,
 * test, build, security scans and deploy appear anywhere in the pipeline.
 * Exit 1 when any high finding exists, 0 otherwise, 2 on errors.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

export interface Finding { id: string; level: "high" | "medium" | "low"; file: string; job?: string; step?: string; message: string }
type Any = any;

const SHA = /@[0-9a-f]{40}$/;
const UNTRUSTED = /\$\{\{\s*(github\.event\.(issue\.(title|body)|pull_request\.(title|body|head\.ref|head\.label)|comment\.body|review\.body|review_comment\.body|pages\.[^}]*page_name|commits[^}]*\.(message|author\.(email|name))|head_commit\.(message|author\.(email|name))|workflow_run\.(head_branch|head_commit\.message))|github\.head_ref)\s*\}\}/;
const SECRET_PRINT = /\b(echo|printf|cat|print)\b[^\n]*\$\{\{\s*secrets\./;
const DEPLOY = /deploy|release|publish|promote|rollout/i;

export const GATE_PATTERNS: Record<string, RegExp> = {
  lint: /\b(lint|eslint|ruff check|flake8|golangci-lint|clippy|biome|rubocop)\b/i,
  typecheck: /\b(tsc|typecheck|type-check|mypy|pyright|go vet)\b/i,
  test: /\b(test|pytest|jest|vitest|rspec|go test|cargo test|bun test)\b/i,
  build: /\b(build|compile|docker build|cargo build|go build)\b/i,
  secret_scan: /gitleaks|trufflehog|detect-secrets|scan_secrets|secret-scan/i,
  dependency_scan: /dependency-review|npm audit|pnpm audit|yarn audit|pip-audit|osv-scanner|govulncheck|cargo audit|snyk|trivy|grype|dependabot/i,
  sast: /codeql|semgrep|bandit|gosec|sonar/i,
  deploy: DEPLOY,
};

const triggers = (wf: Any): string[] => {
  const on = wf?.on ?? wf?.[true as Any]; // YAML 1.1 parsers may read `on` as boolean true
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on;
  return on && typeof on === "object" ? Object.keys(on) : [];
};

export function auditWorkflow(wf: Any, file: string): { findings: Finding[]; text: string } {
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, "file">) => findings.push({ file, ...f });
  const on = triggers(wf);
  const jobs: Record<string, Any> = wf?.jobs ?? {};
  const wfPerms = wf?.permissions;
  const isDeployWf = DEPLOY.test(String(wf?.name ?? "")) || DEPLOY.test(file) || Object.entries(jobs).some(([id, j]) => DEPLOY.test(id) || j?.environment);
  const textParts: string[] = [String(wf?.name ?? ""), file];

  if (wfPerms === "write-all") add({ id: "CI04", level: "high", message: "workflow grants `permissions: write-all`; grant only the scopes each job needs" });
  if (isDeployWf && !wf?.concurrency && !Object.values(jobs).some((j: Any) => j?.concurrency)) {
    add({ id: "CI10", level: "medium", message: "deploy/release workflow has no `concurrency` group; two runs can deploy at once" });
  }

  for (const [jobId, job] of Object.entries(jobs)) {
    textParts.push(jobId, String(job?.name ?? ""));
    if (job?.uses) {
      textParts.push(String(job.uses));
      if (!String(job.uses).startsWith("./") && !SHA.test(job.uses)) add({ id: "CI01", level: "high", job: jobId, message: `reusable workflow \`${job.uses}\` is not pinned to a commit SHA` });
      continue;
    }
    if (job?.permissions === "write-all") add({ id: "CI04", level: "high", job: jobId, message: "job grants `permissions: write-all`" });
    if (wfPerms === undefined && job?.permissions === undefined) add({ id: "CI03", level: "medium", job: jobId, message: "no `permissions` set; the GITHUB_TOKEN gets the repository default, which may be write" });
    if (job?.["timeout-minutes"] === undefined) add({ id: "CI08", level: "low", job: jobId, message: "no `timeout-minutes`; a hung job runs for the 6-hour default" });
    const deployJob = DEPLOY.test(jobId) || DEPLOY.test(String(job?.name ?? ""));
    if (deployJob && !job?.environment) add({ id: "CI09", level: "medium", job: jobId, message: "deploy/release job has no `environment`, so no required reviewers or protection rules apply" });
    const runsOn = JSON.stringify(job?.["runs-on"] ?? "");
    if (/self-hosted/.test(runsOn) && on.includes("pull_request")) add({ id: "CI11", level: "medium", job: jobId, message: "self-hosted runner runs on pull_request; fork PRs can execute code on it" });

    for (const [i, step] of (job?.steps ?? []).entries()) {
      const stepName = String(step?.name ?? step?.uses ?? `step ${i + 1}`);
      const uses = step?.uses ? String(step.uses) : "";
      const run = step?.run ? String(step.run) : "";
      textParts.push(stepName, uses, run);
      if (uses && !uses.startsWith("./") && !uses.startsWith("docker://")) {
        const firstParty = /^(actions|github)\//.test(uses);
        if (!SHA.test(uses)) {
          add(firstParty
            ? { id: "CI02", level: "low", job: jobId, step: stepName, message: `\`${uses}\` is pinned to a tag; a SHA pin is immutable` }
            : { id: "CI01", level: "high", job: jobId, step: stepName, message: `third-party action \`${uses}\` is not pinned to a commit SHA` });
        }
      }
      if (/^actions\/checkout@/.test(uses)) {
        const ref = String(step?.with?.ref ?? "");
        if ((on.includes("pull_request_target") || on.includes("workflow_run")) && /head\.(sha|ref)|head_sha|head_branch|github\.head_ref|refs\/pull/.test(ref)) {
          add({ id: "CI05", level: "high", job: jobId, step: stepName, message: "privileged trigger checks out untrusted PR code; secrets and a write token are exposed to it" });
        }
        if (step?.with?.["persist-credentials"] !== false) add({ id: "CI12", level: "low", job: jobId, step: stepName, message: "checkout leaves the token in .git/config; set `persist-credentials: false` unless a later step pushes" });
      }
      if (run && UNTRUSTED.test(run)) add({ id: "CI06", level: "high", job: jobId, step: stepName, message: "untrusted event data is interpolated into a shell script; pass it through `env:` and quote it" });
      if (run && SECRET_PRINT.test(run)) add({ id: "CI07", level: "high", job: jobId, step: stepName, message: "a secret is printed by a run step" });
    }
  }
  return { findings, text: textParts.join("\n") };
}

export function gatesFrom(text: string) {
  return Object.fromEntries(Object.entries(GATE_PATTERNS).map(([k, re]) => [k, re.test(text)]));
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: "boolean", short: "h" }, C: { type: "string", short: "C" } } });
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (parsed.values.help) { console.log("usage: audit_ci.ts [-C REPO] [FILE...]"); return 0; }
  const repo = parsed.values.C ?? process.cwd();
  let files = parsed.positionals.map((f) => join(repo, f));
  if (!files.length) {
    const dir = join(repo, ".github", "workflows");
    files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => join(dir, f)) : [];
  }
  if (!files.length) {
    console.log(JSON.stringify({ workflows: [], findings: [], gates: gatesFrom(""), note: "No GitHub Actions workflows found; the pipeline enforces no gates." }, null, 2));
    return 0;
  }
  const findings: Finding[] = [];
  const workflows: { file: string; name: string | null; triggers: string[]; jobs: number; error?: string }[] = [];
  let text = "";
  for (const f of files) {
    const rel = relative(repo, f);
    let wf: Any;
    try { wf = Bun.YAML.parse(readFileSync(f, "utf8")); } catch (e) {
      workflows.push({ file: rel, name: null, triggers: [], jobs: 0, error: `YAML parse error: ${(e as Error).message}` });
      continue;
    }
    const r = auditWorkflow(wf, rel);
    findings.push(...r.findings);
    text += r.text + "\n";
    workflows.push({ file: rel, name: wf?.name ?? null, triggers: triggers(wf), jobs: Object.keys(wf?.jobs ?? {}).length });
  }
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level] || a.file.localeCompare(b.file));
  const gates = gatesFrom(text);
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.level]++;
  console.log(JSON.stringify({ workflows, counts, findings, gates, missing_gates: Object.entries(gates).filter(([, v]) => !v).map(([k]) => k) }, null, 2));
  return workflows.some((w) => w.error) ? 2 : counts.high ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
