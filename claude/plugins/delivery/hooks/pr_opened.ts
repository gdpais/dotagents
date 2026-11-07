#!/usr/bin/env bun
/**
 * PostToolUse hook for Bash (v3.3): with `"review": "session"` in the autonomy policy, when `gh pr create` opens a
 * pull request on this repository, tell Claude to start that PR's review session: a fresh session that runs
 * engineering:code-review, shows its tables, fixes what it confirms, rates the PR with pr_risk.ts and merges it or
 * stops by the policy's risk rules. The session that opened the PR moves on instead of reviewing it or asking
 * about the merge. Replaces the per-user hook Heartbeat used (~/.claude/hooks/heartbeat-pr-review.sh), whose
 * brief said "Do not merge", so every review session stopped and the merge came back to the user (4 Nov 2026).
 * Silent (no output) without that policy, for other repositories, for a PR that already existed, and when this
 * session already started the PR's review session. A session whose last engineering:code-review came after its last
 * file change (and after any earlier PR it opened) is told it owns the PR instead (no second review).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { executableText, repoKey, withoutHeredocs } from "./bash_guard";
import { isReview, loadConfig, parseAutonomy, reviewedHere, reviewSessionStart, segments, toolUses, type ToolUse } from "./autonomy";
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
  return { n: Number(m[4]), url: m[0], existed: /already exists/i.test(output) };
}

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_ONLY_AGENTS = new Set(["Explore", "Plan", "claude-code-guide"]);
/** A command word that rewrites files: `sed -i` (any flag order), `perl -i`, `patch`, `mv`, `cp`, `rm`, or a git command that writes the tree. */
const SHELL_EDIT = /^(?:[A-Za-z_]\w*=\S*\s+)*(?:timeout\s+\S+\s+)?(?:sed\s+(?:-\S+\s+|'[^']*'\s+)*(?:-i|--in-place)|perl\s+(?:-\S+\s+)*-\w*i|patch\b|mv\b|cp\b|rm\b|git\s+(?:-[cC]\s+\S+\s+)*(?:apply|am|cherry-pick|revert|restore|stash\s+(?:pop|apply)|checkout\b.*\s--(?:\s|$)))/;

/**
 * A tool call that changes files: an edit tool, a subagent that isn't a review or a read-only type (it may apply the
 * fixes), or a shell command above, `tee`, a formatter's `--write`/`--fix`, or a redirect into a file. Quoted arguments and heredoc bodies are blanked
 * first, so a commit message such as `-m "$(cat <<'EOF' … 3.3.1 -> 3.3.2 … EOF)"` isn't an edit.
 */
export function changesFiles(u: ToolUse): boolean {
  if (EDITS.has(u.name)) return true;
  if (u.name === "Agent" || u.name === "Task") return !isReview(u) && !READ_ONLY_AGENTS.has(String(u.input.subagent_type ?? ""));
  if (u.name !== "Bash") return false;
  const c = executableText(String(u.input.command ?? ""));
  if (createsPr(c)) return false;
  return /\btee\b|\s--(?:write|fix)\b|(^|[^0-9&])>\s*[\w./-]+\.\w+/.test(c) || segments(c).some((s) => SHELL_EDIT.test(s));
}

/**
 * True when the session's last engineering:code-review covers the PR just opened: no file changed after it and no
 * earlier `gh pr create` followed it (that review belonged to the earlier PR). Commits don't count as changes: the
 * ship order is review, commit, push, open the PR (3.3.1 counted commits, so that order still got a second review
 * session). The opening call itself may already be the last tool use; it is ignored.
 */
export function reviewedThisChange(uses: ToolUse[]): boolean {
  const bash = (u: ToolUse) => (u.name === "Bash" ? String(u.input.command ?? "") : "");
  const last = uses.length && createsPr(bash(uses[uses.length - 1])) ? uses.slice(0, -1) : uses;
  const review = last.findLastIndex(isReview);
  return review >= 0 && !last.slice(review + 1).some((u) => changesFiles(u) || createsPr(bash(u)));
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
  const uses = input.transcript_path && existsSync(input.transcript_path) ? toolUses(readFileSync(input.transcript_path, "utf8")) : [];
  if (uses.some((u) => /start_session$/.test(u.name) && String(u.input.title ?? "") === `Code review: PR #${pr.n}`)) return 0;
  const riskScript = join(SCRIPTS, "pr_risk.ts");
  const out = (context: string) => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }));
  const common = git(["rev-parse", "--git-common-dir"], cwd);
  const main = common ? dirname(isAbsolute(common) ? common : resolve(cwd, common)) : cwd;
  if (reviewedThisChange(uses)) { out(reviewedHere({ n: pr.n, url: pr.url, policy, riskScript, mainCheckout: main })); return 0; }
  const context = reviewSessionStart({
    n: pr.n, url: pr.url, base: baseBranch(cwd, policy.base), policy,
    riskScript, cleanupScript: join(SCRIPTS, "cleanup_merged.ts"), mainCheckout: main,
  });
  out(context);
  return 0;
}

if (import.meta.main) process.exit(await main());
