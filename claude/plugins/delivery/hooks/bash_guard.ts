#!/usr/bin/env bun
/**
 * PreToolUse hook for Bash:
 *   - `git commit`: scan the staged diff for secrets; deny the commit on a
 *     high-confidence finding (value masked in the reason).
 *   - outward or irreversible commands (push, tag, merge, release, publish,
 *     deploy/apply): ask the user first, whatever the permission mode.
 * Everything else passes through untouched (no output, exit 0).
 */
import { scanPatch } from "../skills/delivery-lifecycle/scripts/scan_secrets";

export const IRREVERSIBLE: [RegExp, string][] = [
  [/\bgit\s+(?:-C\s+\S+\s+)?push\b/, "git push"],
  [/\bgit\s+(?:-C\s+\S+\s+)?tag\s+(?!-l\b|--list\b|-d\b)\S/, "git tag"],
  [/\bgh\s+pr\s+merge\b/, "gh pr merge"],
  [/\bgh\s+release\s+create\b/, "gh release create"],
  [/\bgh\s+workflow\s+run\b/, "gh workflow run"],
  [/\b(?:npm|pnpm|yarn|bun|cargo|twine|gem)\s+publish\b|\btwine\s+upload\b/, "package publish"],
  [/\bterraform\s+(?:apply|destroy)\b|\bpulumi\s+up\b/, "infrastructure apply"],
  [/\bkubectl\s+(?:apply|delete|rollout|scale)\b|\bhelm\s+(?:install|upgrade|uninstall)\b/, "cluster change"],
  [/\bdocker\s+push\b/, "image push"],
];

export function classifyCommand(cmd: string): { commit: boolean; irreversible: string | null } {
  return {
    commit: /\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd),
    irreversible: IRREVERSIBLE.find(([re]) => re.test(cmd))?.[1] ?? null,
  };
}

const decide = (decision: "ask" | "deny", reason: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });

export async function main(): Promise<number> {
  let input: { tool_name?: string; tool_input?: { command?: string }; cwd?: string };
  try { input = JSON.parse(await Bun.stdin.text()); } catch { return 0; }
  if (input.tool_name !== "Bash") return 0;
  const cmd = input.tool_input?.command ?? "";
  const c = classifyCommand(cmd);
  if (c.irreversible) {
    console.log(decide("ask", `${c.irreversible} is outward-facing or hard to undo; it needs the user's explicit go (delivery approval rules).`));
    return 0;
  }
  if (c.commit) {
    const p = Bun.spawnSync(["git", "diff", "--cached", "-U0", "--no-color", "--no-ext-diff"], { cwd: input.cwd ?? process.cwd() });
    const high = p.exitCode === 0 ? scanPatch(p.stdout.toString()).filter((f) => f.confidence === "high") : [];
    if (high.length) {
      console.log(decide("deny", `Staged changes contain ${high.length} likely secret(s): ${high.slice(0, 3).map((f) => `${f.rule} at ${f.file}:${f.line} (${f.masked})`).join("; ")}. Remove them (use env/config) before committing; rotate any real secret.`));
    }
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
