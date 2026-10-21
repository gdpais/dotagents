#!/usr/bin/env bun
/**
 * SessionStart hook (v3): when `.claude/delivery.json` has an `autonomy` policy, add it to the
 * session as standing authorization, so Claude ships approved steps instead of stopping to offer them.
 * Silent (no output, no tokens) without a policy, outside a git repository, and on resume
 * (the context from the session's start is already in the conversation).
 */
import { loadConfig, parseAutonomy, policyContext } from "./autonomy";

const git = (args: string[], cwd: string) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
};

/** The branch pull requests target: the policy's `base`, else origin/HEAD, else main or master. */
export function baseBranch(cwd: string, configured: string | null): string {
  if (configured) return configured;
  const remoteHead = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd)?.replace(/^origin\//, "");
  if (remoteHead) return remoteHead;
  for (const b of ["main", "master"]) if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], cwd) !== null || git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`], cwd) !== null) return b;
  return "main";
}

export async function main(): Promise<number> {
  let input: { cwd?: string; source?: string };
  try { input = JSON.parse(await Bun.stdin.text()); } catch { return 0; }
  if (input.source === "resume") return 0;
  const cwd = input.cwd ?? process.cwd();
  if (git(["rev-parse", "--is-inside-work-tree"], cwd) !== "true") return 0;
  const policy = parseAutonomy(loadConfig(cwd));
  if (!policy || !policy.push.length) return 0;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: policyContext(policy, baseBranch(cwd, policy.base)) } }));
  return 0;
}

if (import.meta.main) process.exit(await main());
