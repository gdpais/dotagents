#!/usr/bin/env bun
/**
 * PreToolUse hook for the desktop app's PR and session tools, approving the calls the autonomy policy covers:
 *   - `mcp__ccd_pr__set_monitor` (PR monitoring / Auto-fix) with `"autoFix": true`. Auto mode's classifier
 *     otherwise blocked about half of these calls (7 of 14 in Heartbeat, 22–28 Oct 2026).
 *   - `mcp__ccd_pr__bind_pr` and `get_status` for a PR on this repository when the policy opens PRs (v3.3): the app
 *     asks to bind the PR a session just opened, and the classifier declined one (Heartbeat, 4 Nov).
 *   - `mcp__ccd_session__start_session` for a PR's review session with `"review": "session"` (v3.3): title
 *     "Code review: PR #<n>". Those starts asked 36 times in Heartbeat (2–3 Nov).
 * Silent (normal permission flow) without the policy, for anything else, or outside a repository.
 */
import { repoKey } from "./bash_guard";
import { loadConfig, parseAutonomy } from "./autonomy";

const allow = (reason: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason } });

/** True when `url` is a pull request on the repository whose origin is `origin`. */
function ourPr(url: unknown, cwd: string): boolean {
  const m = typeof url === "string" ? /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/.exec(url) : null;
  if (!m) return false;
  try {
    const p = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd, stdout: "pipe", stderr: "ignore" });
    const key = p.exitCode === 0 ? repoKey(p.stdout.toString().trim()) : null;
    return !!key && key === `${m[1]}/${m[2]}/${m[3]}`.toLowerCase();
  } catch { return false; }
}

export async function main(): Promise<number> {
  let input: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };
  try { input = JSON.parse(await Bun.stdin.text()); } catch { return 0; }
  const tool = input.tool_name ?? "", args = input.tool_input ?? {}, cwd = input.cwd ?? process.cwd();
  if (!/^mcp__.+__(?:set_monitor|bind_pr|get_status|start_session)$/.test(tool)) return 0;
  const policy = parseAutonomy(loadConfig(cwd));
  if (!policy) return 0;
  if (/__set_monitor$/.test(tool) && policy.autoFix)
    console.log(allow("autonomy.autoFix in .claude/delivery.json: the user approved PR monitoring / Auto-fix."));
  else if (/__get_status$/.test(tool) && policy.openPr)
    console.log(allow("autonomy.openPr in .claude/delivery.json: reading the PR's status is part of opening it."));
  else if (/__bind_pr$/.test(tool) && policy.openPr && ourPr(args.url, cwd))
    console.log(allow("autonomy.openPr in .claude/delivery.json: binding this repository's PR to the session that opened it."));
  else if (/__start_session$/.test(tool) && policy.review === "session" && /^Code review: PR #\d+$/.test(String(args.title ?? "")) && !args.cwd && !args.host && !args.repository && args.target !== "cloud")
    console.log(allow("autonomy.review \"session\" in .claude/delivery.json: the user asked for a review session per pull request."));
  return 0;
}

if (import.meta.main) process.exit(await main());
