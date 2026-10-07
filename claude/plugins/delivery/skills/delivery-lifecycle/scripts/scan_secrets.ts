#!/usr/bin/env bun
/**
 * Scan files or a git diff for committed secrets. Values are always masked.
 *
 * Read-only. Targets (one of; default: the paths given, or "."):
 *   PATH...            files or directories (skips .git, node_modules, dist, build,
 *                      vendor, binary files and files over 1 MB)
 *   --diff RANGE       only lines added in `git diff RANGE` (e.g. main...HEAD)
 *   --staged           only lines added in the index (pre-commit use)
 *   -C PATH            repository / base directory (default: current directory)
 *
 * Suppress a reviewed false positive with `secret-scan: allow` on the same line.
 * Placeholders (example, changeme, xxx, <...>, ${...}, dummy, fake, redacted) are ignored.
 *
 * Output: JSON {scanned, findings:[{rule, confidence, file, line, masked}]}.
 * Exit 1 when any high-confidence finding exists, 0 otherwise, 2 on errors,
 * so the script can gate CI or a pre-commit hook.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

export interface Finding { rule: string; confidence: "high" | "medium"; file: string; line: number; masked: string }
interface Rule { id: string; re: RegExp; confidence: "high" | "medium"; group?: number; minEntropy?: number }

export const RULES: Rule[] = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/, confidence: "high" },
  { id: "aws-access-key-id", re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/, confidence: "high", group: 1 },
  { id: "aws-secret-access-key", re: /aws.{0,20}?(?:secret|key).{0,20}?['"]([0-9a-zA-Z/+]{40})['"]/i, confidence: "high", group: 1 },
  { id: "github-token", re: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/, confidence: "high", group: 1 },
  { id: "gitlab-token", re: /\b(glpat-[A-Za-z0-9_-]{20,})\b/, confidence: "high", group: 1 },
  { id: "slack-token", re: /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/, confidence: "high", group: 1 },
  { id: "slack-webhook", re: /(https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+)/, confidence: "high", group: 1 },
  { id: "stripe-live-key", re: /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})\b/, confidence: "high", group: 1 },
  { id: "google-api-key", re: /\b(AIza[0-9A-Za-z_-]{35})\b/, confidence: "high", group: 1 },
  { id: "anthropic-api-key", re: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/, confidence: "high", group: 1 },
  { id: "openai-api-key", re: /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,})\b/, confidence: "high", group: 1 },
  { id: "npm-token", re: /\b(npm_[A-Za-z0-9]{36})\b/, confidence: "high", group: 1 },
  { id: "jwt", re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/, confidence: "medium", group: 1 },
  { id: "credentials-in-url", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s@/'"]{6,})@[^\s'"]+/i, confidence: "high", group: 1 },
  { id: "generic-secret-assignment", re: /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i, confidence: "medium", group: 1, minEntropy: 3.5 },
];

const PLACEHOLDER = /example|sample|changeme|change_me|placeholder|dummy|fake|redacted|your[_-]|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|^x+$|^\*+$|(.)\1{7,}|^(test|password|secret)/i;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "vendor", ".next", "coverage", "__pycache__", ".venv", "venv", "target"]);
const SKIP_FILES = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|woff2?|ttf|eot|mp4|mov|lock|lockb)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|poetry\.lock)$/i;

export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

export const mask = (v: string) => (v.length <= 8 ? "*".repeat(v.length) : `${v.slice(0, 4)}…(${v.length} chars)`);

export function scanLine(text: string, file: string, line: number): Finding[] {
  if (/secret-scan:\s*allow/.test(text)) return [];
  const out: Finding[] = [];
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const value = rule.group ? m[rule.group] : m[0];
    if (rule.id !== "private-key" && PLACEHOLDER.test(value)) continue;
    if (rule.minEntropy && entropy(value) < rule.minEntropy) continue;
    if (out.some((f) => f.masked === mask(value))) continue; // same value matched by a broader rule
    out.push({ rule: rule.id, confidence: rule.confidence, file, line, masked: rule.id === "private-key" ? "-----BEGIN … PRIVATE KEY-----" : mask(value) });
  }
  return out;
}

export function scanText(text: string, file: string): Finding[] {
  return text.split("\n").flatMap((t, i) => scanLine(t, file, i + 1));
}

/** Parse `git diff -U0` output into added lines per file and scan them. */
export function scanPatch(patch: string): Finding[] {
  const out: Finding[] = [];
  let file = "";
  let lineNo = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("+++ ")) file = l.slice(4).replace(/^b\//, "");
    else if (l.startsWith("@@")) lineNo = +(/\+(\d+)/.exec(l)?.[1] ?? 0);
    else if (l.startsWith("+") && file && file !== "/dev/null") {
      if (!SKIP_FILES.test(file)) out.push(...scanLine(l.slice(1), file, lineNo));
      lineNo++;
    }
  }
  return out;
}

function walk(path: string, files: string[]) {
  let st;
  try { st = statSync(path); } catch { return; }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) if (!SKIP_DIRS.has(name)) walk(join(path, name), files);
  } else if (st.isFile() && st.size <= 1_000_000 && !SKIP_FILES.test(path)) {
    files.push(path);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      help: { type: "boolean", short: "h" }, diff: { type: "string" }, staged: { type: "boolean" }, C: { type: "string", short: "C" } } });
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) { console.log("usage: scan_secrets.ts [-C PATH] [--diff RANGE | --staged | PATH...]"); return 0; }
  const base = values.C ?? process.cwd();
  let findings: Finding[] = [];
  let scanned: string;

  if (values.diff !== undefined || values.staged) {
    const args = ["diff", "-U0", "--no-color", "--no-ext-diff", ...(values.staged ? ["--cached"] : [values.diff!])];
    const proc = Bun.spawnSync(["git", ...args], { cwd: base, stderr: "pipe" });
    if (proc.exitCode !== 0) { console.log(JSON.stringify({ error: `git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}` })); return 2; }
    scanned = values.staged ? "staged changes" : `git diff ${values.diff}`;
    findings = scanPatch(proc.stdout.toString());
  } else {
    const files: string[] = [];
    for (const p of positionals.length ? positionals : ["."]) walk(join(base, p), files);
    scanned = `${files.length} file(s)`;
    for (const f of files) {
      const text = await Bun.file(f).text();
      if (text.includes("\u0000")) continue;
      findings.push(...scanText(text, relative(base, f) || f));
    }
  }
  console.log(JSON.stringify({ scanned, findings, note: "Values are masked. Rotate any real secret even after removing it; history keeps it." }, null, 2));
  return findings.some((f) => f.confidence === "high") ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
