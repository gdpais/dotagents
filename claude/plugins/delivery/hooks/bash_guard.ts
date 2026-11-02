#!/usr/bin/env bun
/**
 * PreToolUse hook for Bash:
 *   - `git commit`: scan the staged diff for secrets; deny the commit on a
 *     high-confidence finding (value masked in the reason).
 *   - outward or irreversible commands (push, tag, merge, release, publish,
 *     deploy/apply): ask the user first, whatever the permission mode.
 *   - v3: when `.claude/delivery.json` has an `autonomy` policy, pushes of the branches it
 *     names, kubectl/helm against its local clusters and `gh workflow run` of its workflows
 *     are covered (the user approved them once); everything else above still asks.
 *   - v3.2: a covered command made only of routine steps (cd, git add/commit/log, gh pr create,
 *     grep/tail…) is approved outright, so auto mode's classifier doesn't stop it either. A
 *     `gh pr merge` the user's last message asked for (by PR number) isn't asked again; the normal
 *     permission flow still decides it.
 *   - v3.2, `autonomy.merge`: `gh pr merge <n>` is approved when this session reviewed the PR and ran
 *     pr_risk.ts on it, the risk (recomputed here from the PR) is a level the policy merges, and CI
 *     is green. Breaking changes always ask.
 * Everything else passes through untouched (no output, exit 0).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { prRisk } from "../skills/delivery-lifecycle/scripts/pr_risk";
import { scanPatch } from "../skills/delivery-lifecycle/scripts/scan_secrets";
import { approvedMerges, assessedPr, explicitContext, globMatch, lastUserPrompt, loadConfig, parseAutonomy, pushOutsidePolicy, segments, toolUses, type Autonomy } from "./autonomy";

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

// Global flags between the program and its verb: `kubectl -n prod delete`, `helm --kube-context x upgrade`.
const FLAGS = String.raw`(?:\s+--?[\w-]+(?:=\S+|\s+(?!-)\S+)?)*`;
// A shell as a command word (`sh`, `/bin/bash`, `ssh host`), not a file extension (`kind-e2e.sh`).
const SHELL = String.raw`(?:^|[\s;&|(/])(?:ba|z|da|k|s)?sh(?=\s|$)`;

export const IRREVERSIBLE: [RegExp, string][] = [
  [/\bgit(?:\s+-[Cc]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+push\b/, "git push"],
  [/\bgh\s+pr\s+merge\b/, "gh pr merge"],
  [/\bgh\s+api\b[^;&|\n]*\/pulls\/\d+\/merge\b/, "merge via gh api"],
  [/\bgh\s+release\s+create\b/, "gh release create"],
  [/\bgh\s+workflow\s+run\b/, "gh workflow run"],
  [/\b(?:npm|pnpm|yarn|bun|cargo|twine|gem)\s+publish\b|\btwine\s+upload\b/, "package publish"],
  [/\bterraform\s+(?:apply|destroy)\b|\bpulumi\s+up\b/, "infrastructure apply"],
  [new RegExp(String.raw`\bkubectl${FLAGS}\s+(?:apply|create|replace|patch|delete|scale|drain|set|rollout\s+(?:restart|undo|pause|resume))\b|\bhelm${FLAGS}\s+(?:install|upgrade|uninstall|delete|rollback)\b`), "cluster change"],
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
    if (!m || new RegExp(`${SHELL}|\\beval\\b`).test(lines[i])) continue;
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
  if (new RegExp(`${SHELL}\\s+-\\w*c\\b|\\beval\\b|\\bxargs\\b`).test(s)) return s;
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

const isLocal = (seg: string, policy: Autonomy, kubeContext: () => string | null) => {
  if (!policy.localClusters.length) return false;
  const ctx = explicitContext(seg) ?? kubeContext();
  return !!ctx && policy.localClusters.some((g) => globMatch(g, ctx));
};

/**
 * Null when every outward segment of the command is covered by the autonomy policy (or, for
 * `gh pr merge <n>`, by `merges`, the PRs the user just asked to merge), else the label of the
 * first one that isn't. Segments that aren't outward are ignored.
 */
export function outsidePolicy(cmd: string, policy: Autonomy, cwd: string, kubeContext: () => string | null = () => null, merges: Set<number> = new Set()): string | null {
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
    if (label === "cluster change" && isLocal(seg, policy, kubeContext)) continue;
    if (label === "gh workflow run") {
      const m = /\bgh\s+workflow\s+run\s+(?:"([^"]+)"|'([^']+)'|([^\s-]\S*))/.exec(seg);
      const wf = m?.[1] ?? m?.[2] ?? m?.[3];
      if (wf && policy.workflows.some((g) => globMatch(g, wf))) continue;
    }
    if (label === "gh pr merge") {
      const n = mergedPr(seg);
      if (n !== null && merges.has(n)) continue;
    }
    return label;
  }
  return null;
}

/** The PR number a `gh pr merge` segment names, or null (current branch, a variable). */
export function mergedPr(seg: string): number | null {
  const n = /\bgh\s+pr\s+merge\s+(?:\S*\/pull\/)?#?(\d+)\b/.exec(seg)?.[1];
  return n ? Number(n) : null;
}

/**
 * PRs among `prs` that the merge policy covers: the session reviewed and assessed each one, and pr_risk
 * (recomputed from the PR, so the session can't lower it) gives a level the policy merges, with CI green.
 * `why` explains the first one that isn't covered.
 */
export async function policyMerges(prs: number[], policy: Autonomy, cwd: string, uses: { name: string; input: any }[],
  risk: typeof prRisk = prRisk): Promise<{ covered: Set<number>; why: string | null }> {
  const covered = new Set<number>();
  let why: string | null = null;
  if (policy.merge.low === "ask" && policy.merge.medium === "ask") return { covered, why };
  for (const n of prs) {
    if (!assessedPr(uses, n)) { why ??= `PR #${n} wasn't reviewed (defect-first-review) and assessed (pr_risk.ts --pr ${n}) in this session`; continue; }
    const r = await risk(cwd, { pr: n });
    if (typeof r === "string") { why ??= r; continue; }
    if (!r.auto) { why ??= `PR #${n} is ${r.level} risk (${r.reasons[0]}): it needs the user's approval, with evidence`; continue; }
    if (r.ci !== "green" || r.draft) { why ??= `PR #${n} is ${r.draft ? "a draft" : `not green (CI ${r.ci})`}`; continue; }
    covered.add(n);
  }
  return { covered, why };
}

const ROUTINE = [
  /^set\s+[-+][euxo]+(?:\s+pipefail)?$/,
  /^git\s+(?:-C\s+\S+\s+)?(?:add|commit|status|log|diff|show|fetch|rev-parse|rev-list|ls-files|describe|merge-base)\b/,
  /^gh\s+(?:pr\s+(?:create|view|list|checks|status|diff)|run\s+(?:list|view|watch))\b/,
  /^(?:echo|printf|grep|head|tail|wc|sleep|true|sort|uniq)\b/,
];
const KUBE_READ = new RegExp(String.raw`^(?:kubectl${FLAGS}\s+(?:get|describe|logs|wait|top|rollout\s+(?:status|history))|helm${FLAGS}\s+(?:list|status|get|history))\b`);

/**
 * True when every simple command is one a covered policy may approve outright: `cd` within the repository,
 * a covered outward step (the caller checks coverage), read-only kubectl/helm on a local cluster, or a
 * routine git, gh or text command. Command substitution, an expanding heredoc, a background `&`, a redirect
 * into a file, or a `cd`/`git -C` out of the repository (its git hooks would run) means the normal
 * permission flow decides instead.
 */
export function routineOnly(cmd: string, policy: Autonomy, kubeContext: () => string | null = () => null, cwd = process.cwd()): boolean {
  if (/<<-?\s*[A-Za-z_]/.test(cmd) && /\$\(|`/.test(cmd)) return false; // unquoted heredoc: its body expands
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } }; // macOS: /var is /private/var
  const root = real(run(["git", "rev-parse", "--show-toplevel"], cwd) ?? resolve(cwd));
  const inside = (p: string) => { const r = real(p); return r === root || r.startsWith(root + "/"); };
  let here = resolve(cwd);
  for (const seg of segments(withoutHeredocs(cmd))) {
    const live = seg.replace(/'[^']*'/g, "''");
    if (/\$\(|`|<\(|(?<![&>])&(?![&>])/.test(live)) return false;
    for (const m of live.matchAll(/>>?\s*([^\s&]\S*)/g)) if (m[1] !== "/dev/null") return false;
    const cd = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(seg);
    if (cd) { here = resolve(here, cd[1] ?? cd[2] ?? cd[3]); if (!inside(here)) return false; continue; }
    const dashC = /^git\s+-C\s+(\S+)/.exec(seg)?.[1];
    if (dashC && !inside(resolve(here, dashC.replace(/^["']|["']$/g, "")))) return false;
    if (/^(?:kubectl|helm)\b/.test(seg)) {
      if (!isLocal(seg, policy, kubeContext) || !(classifyCommand(seg).irreversible || KUBE_READ.test(seg))) return false;
      continue;
    }
    // Outward steps must be the plain command: `GIT_SSH_COMMAND=… git push` or a wrapper runs other code.
    if (classifyCommand(seg).irreversible) { if (!/^(?:git\s+(?:-C\s+\S+\s+)?push|gh)\s/.test(seg)) return false; continue; }
    if (!ROUTINE.some((re) => re.test(seg))) return false;
  }
  return true;
}

const decide = (decision: "allow" | "ask" | "deny", reason: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });

export async function main(): Promise<number> {
  let input: { tool_name?: string; tool_input?: { command?: string }; cwd?: string; transcript_path?: string };
  try { input = JSON.parse(await Bun.stdin.text()); } catch { return 0; }
  if (input.tool_name !== "Bash") return 0;
  const cmd = input.tool_input?.command ?? "";
  const c = classifyCommand(cmd);
  const cwd = input.cwd ?? process.cwd();
  // A secret in the staged diff is a deny, which wins over any ask or allow below.
  if (c.commit) {
    const p = Bun.spawnSync(["git", "diff", "--cached", "-U0", "--no-color", "--no-ext-diff"], { cwd });
    const high = p.exitCode === 0 ? scanPatch(p.stdout.toString()).filter((f) => f.confidence === "high") : [];
    if (high.length) {
      console.log(decide("deny", `Staged changes contain ${high.length} likely secret(s): ${high.slice(0, 3).map((f) => `${f.rule} at ${f.file}:${f.line} (${f.masked})`).join("; ")}. Remove them (use env/config) before committing; rotate any real secret.`));
      return 0;
    }
  }
  if (!c.irreversible) return 0;
  const policy = parseAutonomy(loadConfig(cwd));
  let ctx: string | null | undefined;
  const kube = () => (ctx === undefined ? (ctx = run(["kubectl", "config", "current-context"], cwd)) : ctx);
  const prs = segments(withoutHeredocs(cmd)).filter((s) => classifyCommand(s).irreversible === "gh pr merge").map(mergedPr).filter((n): n is number => n !== null);
  const transcript = prs.length && input.transcript_path && existsSync(input.transcript_path) ? readFileSync(input.transcript_path, "utf8") : "";
  const userGo = transcript ? approvedMerges(lastUserPrompt(transcript)) : new Set<number>();
  const byPolicy = policy && prs.some((n) => !userGo.has(n))
    ? await policyMerges(prs.filter((n) => !userGo.has(n)), policy, cwd, toolUses(transcript)) : { covered: new Set<number>(), why: null };
  const label = outsidePolicy(cmd, policy ?? parseAutonomy({ autonomy: {} })!, cwd, kube, new Set([...userGo, ...byPolicy.covered]));
  if (label) {
    console.log(decide("ask", `${label}${label === "gh pr merge" && byPolicy.why ? ` (${byPolicy.why})` : ""} is outward-facing or hard to undo; it needs the user's explicit go (delivery approval rules).`));
    return 0;
  }
  // Covered. Approve outright only what the policy covers and only routine steps around it; a merge
  // the user asked for in their message still goes through the normal permission flow.
  if (policy && prs.every((n) => byPolicy.covered.has(n)) && routineOnly(cmd, policy, kube, cwd))
    console.log(decide("allow", "Covered by the delivery autonomy policy the user approved in .claude/delivery.json."));
  return 0;
}

if (import.meta.main) process.exit(await main());
