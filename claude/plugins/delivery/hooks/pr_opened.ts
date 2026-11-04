#!/usr/bin/env bun
/**
 * PostToolUse hook for Bash (v3.3): with `"review": "session"` in the autonomy policy, when `gh pr create` opens a
 * pull request on this repository, tell Claude to start that PR's review session: a fresh session that runs
 * engineering:code-review, shows its tables, fixes what it confirms, rates the PR with pr_risk.ts and merges it or
 * stops by the policy's risk rules. The session that opened the PR moves on instead of reviewing it or asking
 * about the merge. Replaces the per-user hook Heartbeat used (~/.claude/hooks/heartbeat-pr-review.sh), whose
 * brief said "Do not merge", so every review session stopped and the merge came back to the user (4 Nov 2026).
 * Silent (no output) without that policy, for other repositories, for a PR that already existed, and when this
 * session already started the PR's review session.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { repoKey, withoutHeredocs } from "./bash_guard";
import { loadConfig, parseAutonomy, reviewSessionStart, segments, toolUses } from "./autonomy";
import { baseBranch } from "./session_context";

const SCRIPTS = join(import.meta.dir, "..", "skills", "delivery-lifecycle", "scripts");

const git = (args: string[], cwd: string) => {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  } catch { return null; }
};

/** True when a segment of the command runs `gh pr create` (not a mention in a string, a grep or a heredoc). */
export function createsPr(cmd: string): boolean {
  return segments(withoutHeredocs(cmd)).some((s) => /^(?:[A-Za-z_]\w*=\S*\s+)*(?:timeout\s+\S+\s+)?gh\s+pr\s+create\b/.test(s));
}

/** The PR a `gh pr create` output names for repository `key` (`host/owner/repo`), and whether it already existed. */
export function openedPrUrl(output: string, key: string | null): { n: number; url: string; existed: boolean } | null {
  const urls = [...output.matchAll(/https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g)];
  const m = urls.findLast((u) => !key || `${u[1]}/${u[2]}/${u[3]}`.toLowerCase() === key);
  if (!m) return null;
  return { n: Number(m[4]), url: m[0], existed: /a pull request for branch "[^"\n]*" into branch "[^"\n]*" already exists/i.test(output) };
}

export async function main(): Promise<number> {
  let input: { tool_name?: string; tool_input?: { command?: string }; tool_response?: unknown; cwd?: string; transcript_path?: string };
  try { input = JSON.parse(await Bun.stdin.text()); } catch { return 0; }
  if (input.tool_name !== "Bash" || !createsPr(input.tool_input?.command ?? "")) return 0;
  const cwd = input.cwd ?? process.cwd();
  const policy = parseAutonomy(loadConfig(cwd));
  if (policy?.review !== "session") return 0;
  const r = input.tool_response as { stdout?: string; stderr?: string } | string | undefined;
  const output = typeof r === "string" ? r : `${r?.stdout ?? ""}\n${r?.stderr ?? ""}`;
  const origin = git(["remote", "get-url", "origin"], cwd);
  const pr = openedPrUrl(output, origin ? repoKey(origin) : null);
  if (!pr || pr.existed) return 0;
  if (input.transcript_path && existsSync(input.transcript_path)
    && toolUses(readFileSync(input.transcript_path, "utf8")).some((u) => /start_session$/.test(u.name) && String(u.input.title ?? "") === `Code review: PR #${pr.n}`)) return 0;
  const common = git(["rev-parse", "--git-common-dir"], cwd);
  const main = common ? dirname(isAbsolute(common) ? common : resolve(cwd, common)) : cwd;
  const context = reviewSessionStart({
    n: pr.n, url: pr.url, base: baseBranch(cwd, policy.base), policy,
    riskScript: join(SCRIPTS, "pr_risk.ts"), cleanupScript: join(SCRIPTS, "cleanup_merged.ts"), mainCheckout: main,
  });
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }));
  return 0;
}

if (import.meta.main) process.exit(await main());
