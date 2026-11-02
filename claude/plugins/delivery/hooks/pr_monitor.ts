#!/usr/bin/env bun
/**
 * PreToolUse hook for the desktop app's PR monitor (`mcp__ccd_pr__set_monitor`, which turns on
 * Auto-fix): with `"autoFix": true` in the autonomy policy the user approved that step once, so
 * approve it. Auto mode's classifier otherwise blocked about half of these calls (7 of 14 in
 * Heartbeat, 22–28 Oct 2026), leaving the user to turn Auto-fix on by hand.
 * Silent (normal permission flow) without the policy or outside a repository.
 */
import { loadConfig, parseAutonomy } from "./autonomy";

export async function main(): Promise<number> {
  let input: { tool_name?: string; cwd?: string };
  try { input = JSON.parse(await Bun.stdin.text()); } catch { return 0; }
  if (!/^mcp__.+__set_monitor$/.test(input.tool_name ?? "")) return 0;
  if (!parseAutonomy(loadConfig(input.cwd ?? process.cwd()))?.autoFix) return 0;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "autonomy.autoFix in .claude/delivery.json: the user approved PR monitoring / Auto-fix." } }));
  return 0;
}

if (import.meta.main) process.exit(await main());
