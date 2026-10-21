#!/usr/bin/env bun
/**
 * PreToolUse hook for Bash:
 *   - `git commit`: scan the staged diff for secrets; deny the commit on a
 *     high-confidence finding (value masked in the reason).
 *   - outward or irreversible commands (push, tag, merge, release, publish,
 *     deploy/apply): ask the user first, whatever the permission mode.
 *   - v3: when `.claude/delivery.json` has an `autonomy` policy, pushes of the branches it
 *     names and kubectl/helm against its local clusters pass through (the user approved
 *     them once); everything else above still asks.
 * Everything else passes through untouched (no output, exit 0).
 */
import { resolve } from "node:path";
import { scanPatch } from "../skills/delivery-lifecycle/scripts/scan_secrets";
import { explicitContext, globMatch, loadConfig, parseAutonomy, pushOutsidePolicy, segments, type Autonomy } from "./autonomy";

/**
 * `git tag` creates a tag only with a creation flag or a tag name; listing (no name,
 * -l/-n/--contains/--merged/--points-at, or --sort/--format with a value) and -d don't.
 */
export function createsTag(cmd: string): boolean {
  for (const m of cmd.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?tag\b([^;&|\n]*)/g)) {
    const toks = m[1].trim().split(/\s+/).filter(Boolean);
    if (toks.some((t) => /^(-l|--list|-n\d*|--contains|--no-contains|--merged|--no-merged|--points-at|-d|--delete|-v|--verify)(=.*)?$/.test(t))) continue;
    if (toks.some((t) => /^(-[asuFfm]+|--annotate|--sign|--local-user|--file|--force|--message)(=.*)?$/.test(t))) return true;
    for (let i = 0; i < toks.length; i++) {
      if (/^(--sort|--format|--column)$/.test(toks[i])) { i++; continue; }
      if (!toks[i].startsWith("-")) return true;
    }
  }
  return false;
}

export const IRREVERSIBLE: [RegExp, string][] = [
  [/\bgit\s+(?:-C\s+\S+\s+)?push\b/, "git push"],
  [/\bgh\s+pr\s+merge\b/, "gh pr merge"],
  [/\bgh\s+release\s+create\b/, "gh release create"],
  [/\bgh\s+workflow\s+run\b/, "gh workflow run"],
  [/\b(?:npm|pnpm|yarn|bun|cargo|twine|gem)\s+publish\b|\btwine\s+upload\b/, "package publish"],
  [/\bterraform\s+(?:apply|destroy)\b|\bpulumi\s+up\b/, "infrastructure apply"],
  [/\bkubectl\s+(?:apply|delete|rollout|scale)\b|\bhelm\s+(?:install|upgrade|uninstall)\b/, "cluster change"],
  [/\bdocker\s+push\b/, "image push"],
];

/**
 * Heredoc bodies removed: `git commit -F - <<'EOF' ... EOF` is a message, not commands. Kept when
 * the heredoc feeds a shell (`sh <<EOF`), whose body does run.
 */
export function withoutHeredocs(cmd: string): string {
  const lines = cmd.split("\n"), out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(lines[i]);
    if (!m || /\b(?:ba|z|da)?sh\b|\beval\b/.test(lines[i])) continue;
    const end = lines.findIndex((l, j) => j > i && (m[1] ? l.trim() : l) === m[3]);
    if (end < 0) break; // unterminated: the rest is body
    i = end;
  }
  return out.join("\n");
}

/**
 * The text that runs as commands: heredoc bodies and quoted arguments blanked, so
 * `grep 'helm upgrade'` or a commit message mentioning `git push` isn't the command itself.
 * Quotes stay when a shell or eval would run them (`sh -c "git push"`).
 */
export function executableText(cmd: string): string {
  const s = withoutHeredocs(cmd);
  if (/\b(?:ba|z|da)?sh\s+-\w*c\b|\beval\b|\bxargs\b/.test(s)) return s;
  return s.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

export function classifyCommand(raw: string): { commit: boolean; irreversible: string | null } {
  const cmd = executableText(raw);
  return {
    commit: /\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd),
    irreversible: IRREVERSIBLE.find(([re]) => re.test(cmd))?.[1] ?? (createsTag(cmd) ? "git tag" : null),
  };
}

const run = (cmd: string[], cwd: string) => {
  try {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  } catch { return null; } // missing cwd or binary (e.g. no kubectl): treat as unknown
};

/**
 * Null when every outward segment of the command is covered by the autonomy policy, else the label
 * of the first one that isn't. Segments that aren't outward are ignored.
 */
export function outsidePolicy(cmd: string, policy: Autonomy, cwd: string, kubeContext: () => string | null = () => null): string | null {
  let here = cwd;
  for (const seg of segments(withoutHeredocs(cmd))) {
    // `cd .claude/worktrees/x && git push`: later segments run in that directory.
    const cd = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(seg);
    if (cd) { here = resolve(here, cd[1] ?? cd[2] ?? cd[3]); continue; }
    const label = classifyCommand(seg).irreversible;
    if (!label) continue;
    if (label === "git push") {
      const dir = /\bgit\s+-C\s+(\S+)/.exec(seg)?.[1];
      const current = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], dir ? resolve(here, dir) : here);
      const why = pushOutsidePolicy(seg, policy, current);
      if (why) return `git push (${why})`;
      continue;
    }
    if (label === "cluster change" && policy.localClusters.length) {
      const ctx = explicitContext(seg) ?? kubeContext();
      if (ctx && policy.localClusters.some((g) => globMatch(g, ctx))) continue;
    }
    return label;
  }
  return null;
}

const decide = (decision: "ask" | "deny", reason: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });

export async function main(): Promise<number> {
  let input: { tool_name?: string; tool_input?: { command?: string }; cwd?: string };
  try { input = JSON.parse(await Bun.stdin.text()); } catch { return 0; }
  if (input.tool_name !== "Bash") return 0;
  const cmd = input.tool_input?.command ?? "";
  const c = classifyCommand(cmd);
  const cwd = input.cwd ?? process.cwd();
  if (c.irreversible) {
    const policy = parseAutonomy(loadConfig(cwd));
    const label = policy ? outsidePolicy(cmd, policy, cwd, () => run(["kubectl", "config", "current-context"], cwd)) : c.irreversible;
    if (label) {
      console.log(decide("ask", `${label} is outward-facing or hard to undo; it needs the user's explicit go (delivery approval rules).`));
      return 0;
    }
  }
  if (c.commit) {
    const p = Bun.spawnSync(["git", "diff", "--cached", "-U0", "--no-color", "--no-ext-diff"], { cwd });
    const high = p.exitCode === 0 ? scanPatch(p.stdout.toString()).filter((f) => f.confidence === "high") : [];
    if (high.length) {
      console.log(decide("deny", `Staged changes contain ${high.length} likely secret(s): ${high.slice(0, 3).map((f) => `${f.rule} at ${f.file}:${f.line} (${f.masked})`).join("; ")}. Remove them (use env/config) before committing; rotate any real secret.`));
    }
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
