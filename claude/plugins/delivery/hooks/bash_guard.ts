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
 *   - v3.2, `autonomy.merge`: `gh pr merge <n>` is approved when this session reviewed the PR with
 *     engineering:code-review and then ran pr_risk.ts on it with a verdict that isn't blocking, the risk
 *     (recomputed here from the PR, with that verdict) is a level the policy merges, and CI is green.
 *     Breaking changes always ask.
 * Everything else passes through untouched (no output, exit 0).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
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
// `-{1,2}\w` keeps the match linear: `--?[\w-]+` backtracked exponentially on long flag lists.
const FLAGS = String.raw`(?:\s+-{1,2}\w[\w-]*(?:=\S+|\s+(?!-)\S+)?)*`;
// A shell as a command word (`sh`, `/bin/bash`, `ssh host`, `bash<<EOF`), not a file extension (`kind-e2e.sh`).
const SHELL = String.raw`(?:^|[\s;&|(/])(?:ba|z|da|k|s)?sh(?=[\s<]|$)`;
// Commands that run their arguments as another command: never covered by the policy.
const WRAPPER = new RegExp(String.raw`^(?:\S*\/)?(?:(?:ba|z|da|k|s)?sh|eval|xargs|sudo|env|nohup|time|timeout|watch|nice|command|exec)(?:\s|$)`);

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
 * `s` with the contents of quoted strings removed (the quotes stay), honouring backslash escapes as the shell
 * does. `keepDouble` keeps double-quoted contents, which the shell still expands (`"$(…)"`).
 */
export function blankQuotes(s: string, keepDouble = false): string {
  let out = "", q: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") { q = null; out += ch; } continue; }
    if (ch === "\\" && i + 1 < s.length) { if (q !== '"' || keepDouble) out += ch + s[i + 1]; i++; continue; }
    if (q === '"') { if (ch === '"') q = null; if (ch === '"' || keepDouble) out += ch; continue; }
    if (ch === "'" || ch === '"') q = ch;
    out += ch;
  }
  return out;
}

export interface Heredoc { delim: string; quoted: boolean; dash: boolean; line: string; feedsShell: boolean; terminated: boolean }

/**
 * Heredocs found the way bash finds them: a `<<` outside quotes, its delimiter word with quotes removed
 * (`<<'EOF'X` ends at `EOFX`), the body ending at a line equal to the delimiter (tabs stripped for `<<-`).
 * `text` is the command with bodies removed, except where the heredoc feeds a shell (`sh <<EOF`), whose
 * body runs. `markerInQuotes` is true when a `<<` sits inside a quoted string.
 */
export function parseHeredocs(cmd: string): { text: string; docs: Heredoc[]; markerInQuotes: boolean } {
  const lines = cmd.split("\n"), out: string[] = [], docs: Heredoc[] = [];
  let q: string | null = null, markerInQuotes = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], pending: Heredoc[] = [];
    out.push(line);
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (q) {
        if (q === '"' && ch === "\\") { j++; continue; }
        if (ch === q) q = null; else if (line.startsWith("<<", j)) markerInQuotes = true;
        continue;
      }
      if (ch === "\\") { j++; continue; }
      if (ch === "'" || ch === '"') { q = ch; continue; }
      if (ch !== "<" || line[j + 1] !== "<" || line[j + 2] === "<") continue;
      const m = /^<<(-?)[ \t]*((?:'[^']*'|"[^"]*"|\\.|[^\s;&|<>()'"\\])+)/.exec(line.slice(j));
      if (!m) continue;
      pending.push({ delim: m[2].replace(/'([^']*)'|"([^"]*)"|\\(.)/g, "$1$2$3"), quoted: /['"\\]/.test(m[2]), dash: m[1] === "-", line,
        feedsShell: new RegExp(`${SHELL}|\\beval\\b`).test(line), terminated: false });
      j += m[0].length - 1;
    }
    if (q) continue; // a quoted string runs on to the next line: no body starts here
    let cursor = i;
    for (const d of pending) {
      docs.push(d);
      let end = -1;
      for (let k = cursor + 1; k < lines.length; k++) if ((d.dash ? lines[k].replace(/^\t+/, "") : lines[k]) === d.delim) { end = k; break; }
      if (d.feedsShell) out.push(...lines.slice(cursor + 1, end < 0 ? lines.length : end));
      d.terminated = end >= 0;
      cursor = end < 0 ? lines.length - 1 : end;
    }
    i = cursor;
  }
  return { text: out.join("\n"), docs, markerInQuotes };
}

/** Heredoc bodies removed: `git commit -F - <<'EOF' ... EOF` is a message, not commands. */
export function withoutHeredocs(cmd: string): string {
  return parseHeredocs(cmd).text;
}

/**
 * The text that runs as commands: heredoc bodies and quoted arguments blanked, so
 * `grep 'helm upgrade'` or a commit message mentioning `git push` isn't the command itself.
 * Quotes stay when a shell or eval would run them (`sh -c "git push"`).
 */
export function executableText(cmd: string): string {
  const s = withoutHeredocs(cmd);
  if (new RegExp(`${SHELL}\\s+-\\w*c\\b|\\beval\\b|\\bxargs\\b`).test(s)) return s;
  return blankQuotes(s);
}

export function classifyCommand(raw: string): { commit: boolean; irreversible: string | null } {
  const cmd = executableText(raw);
  let irreversible: string | null = null;
  for (const seg of segments(cmd)) {
    const hit = IRREVERSIBLE.find(([re]) => re.test(seg))?.[1] ?? null;
    // `kubectl create … --dry-run=client -o yaml` writes a manifest locally; nothing changes in the cluster.
    if (hit === "cluster change" && /\s--dry-run(?:=(?:client|server))?(?:\s|$)/.test(seg)) continue;
    if (hit) { irreversible = hit; break; }
  }
  return { commit: /\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(cmd), irreversible: irreversible ?? (createsTag(cmd) ? "git tag" : null) };
}

const run = (cmd: string[], cwd: string, timeout = 10_000) => {
  try {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "ignore", timeout });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  } catch { return null; } // missing cwd or binary (e.g. no kubectl): treat as unknown
};

/** `host/owner/repo` for a remote URL (ssh or https), lower-cased, without `.git`; null for a local path. */
export function repoKey(url: string): string | null {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)[:/]+([^\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m && !url.trim().startsWith("/") && !url.trim().startsWith(".") ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** The repository's remotes, to tell whether a push or merge targets this repository or another one. */
function remotesOf(dir: string): { names: Set<string>; keys: Set<string>; urls: Set<string>; origin: string | null } {
  const names = new Set<string>(), keys = new Set<string>(), urls = new Set<string>();
  for (const l of (run(["git", "remote", "-v"], dir) ?? "").split("\n")) {
    const [name, url] = l.split(/\s+/);
    if (!name || !url) continue;
    names.add(name); urls.add(url);
    const k = repoKey(url);
    if (k) keys.add(k);
  }
  const o = run(["git", "remote", "get-url", "origin"], dir);
  return { names, keys, urls, origin: o ? repoKey(o) : null };
}

/** A `cd` or `-C` target: `~` expanded, relative paths resolved; null when it holds a variable or substitution. */
function pathFrom(here: string, p: string): string | null {
  p = p.replace(/^["']|["']$/g, "");
  if (/[$`]/.test(p)) return null;
  if (p === "~" || p.startsWith("~/")) return homedir() + p.slice(1);
  return resolve(here, p);
}

// Flags that point kubectl or helm somewhere other than the current context.
const ELSEWHERE = /(?:^|\s)(?:--(?:kubeconfig|server|cluster|token|as|as-group|user|kube-apiserver|kube-token|kube-as-user|kube-as-group)\b|-s\s)|\bKUBECONFIG=/;

const isLocal = (seg: string, policy: Autonomy, kubeContext: () => string | null) => {
  if (!policy.localClusters.length || ELSEWHERE.test(seg)) return false;
  const ctx = explicitContext(seg) ?? kubeContext();
  return !!ctx && policy.localClusters.some((g) => globMatch(g, ctx));
};

const tokens = (s: string) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ""));

/**
 * The PR a `gh pr merge` segment names and the repository it names, if any (`-R owner/repo`, or the
 * owner/repo of a PR URL). Null when it names no number (the current branch's PR, a variable).
 */
export function mergedPr(seg: string): { n: number; repo: string | null } | null {
  const t = tokens(seg);
  const at = t.findIndex((x, i) => x === "merge" && t[i - 1] === "pr" && t[i - 2] === "gh");
  if (at < 0) return null;
  let n: number | null = null, repo: string | null = null;
  for (let i = at + 1; i < t.length; i++) {
    const x = t[i];
    if (/^(?:-R|--repo)$/.test(x)) { repo = t[++i] ?? ""; continue; }
    if (/^--repo=/.test(x)) { repo = x.slice(7); continue; }
    if (/^(?:-b|--body|-F|--body-file|-t|--subject|-A|--author-email|--match-head-commit)$/.test(x)) { i++; continue; }
    if (x.startsWith("-")) continue;
    const url = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(x);
    if (url) { n ??= Number(url[4]); repo ??= `${url[1]}/${url[2]}/${url[3]}`; continue; }
    if (/^#?\d+$/.test(x)) n ??= Number(x.replace("#", ""));
  }
  return n === null ? null : { n, repo };
}

/** True when `repo` (`owner/repo`, `host/owner/repo` or empty) is this repository, by its origin remote. */
const sameRepo = (repo: string | null, origin: string | null) =>
  repo === null || (!!origin && origin.split("/").slice(-2).join("/") === repo.toLowerCase().split("/").slice(-2).join("/"));

/**
 * Null when every outward segment of the command is covered by the autonomy policy (or, for
 * `gh pr merge <n>` on this repository, by `merges`: the PRs the user asked to merge or the policy
 * covers), else the label of the first one that isn't. Segments that aren't outward are ignored.
 */
export function outsidePolicy(cmd: string, policy: Autonomy, cwd: string, kubeContext: () => string | null = () => null, merges: Set<number> = new Set()): string | null {
  let here: string | null = cwd;
  let remotes: ReturnType<typeof remotesOf> | undefined;
  const repo = () => (remotes ??= remotesOf(here ?? cwd));
  for (const seg of segments(withoutHeredocs(cmd))) {
    // `cd .claude/worktrees/x && git push`: later segments run in that directory.
    const cd = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(seg);
    if (cd) { here = here && pathFrom(here, cd[1] ?? cd[2] ?? cd[3]); remotes = undefined; continue; }
    const label = classifyCommand(seg).irreversible;
    if (!label) continue;
    if (WRAPPER.test(seg)) return label;
    if (label === "git push") {
      const dir = /\bgit\s+-C\s+(\S+)/.exec(seg)?.[1];
      const where = here && (dir ? pathFrom(here, dir) : here);
      const current = where ? run(["git", "rev-parse", "--abbrev-ref", "HEAD"], where) : null;
      const r = where ? remotesOf(where) : null;
      // Without a readable remote list, only a plain remote name (`origin`) passes; never a URL or path.
      const own = (x: string) => !!r && (r.names.has(x) || r.urls.has(x) || (!!repoKey(x) && r.keys.has(repoKey(x)!)) || (!r.names.size && /^[\w.-]+$/.test(x)));
      const why = pushOutsidePolicy(seg, policy, current, own);
      if (why) return `git push (${why})`;
      continue;
    }
    if (label === "cluster change" && isLocal(seg, policy, kubeContext)) continue;
    if (label === "gh workflow run" && !/(?:^|\s)(?:-R|--repo)\b/.test(seg)) {
      const m = /\bgh\s+workflow\s+run\s+(?:"([^"]+)"|'([^']+)'|([^\s-]\S*))/.exec(seg);
      const wf = m?.[1] ?? m?.[2] ?? m?.[3];
      if (wf && policy.workflows.some((g) => globMatch(g, wf))) continue;
    }
    if (label === "gh pr merge") {
      const m = mergedPr(seg);
      if (m && merges.has(m.n) && sameRepo(m.repo, repo().origin)) continue;
    }
    return label;
  }
  return null;
}

/**
 * PRs among `prs` that the merge policy covers: the session reviewed each one with engineering:code-review and
 * then assessed it with pr_risk.ts and a verdict that isn't blocking, and pr_risk (recomputed from the PR with
 * that verdict, so the session can't lower it) gives a level the policy merges, with CI green. All the GitHub
 * calls share one deadline, inside the hook's timeout; running out means asking. `why` explains the first PR
 * that isn't covered.
 */
export async function policyMerges(prs: number[], policy: Autonomy, cwd: string, uses: { name: string; input: any }[],
  risk: typeof prRisk = prRisk, budgetMs = 25_000): Promise<{ covered: Set<number>; why: string | null }> {
  const covered = new Set<number>();
  let why: string | null = null;
  if (policy.merge.low === "ask" && policy.merge.medium === "ask") return { covered, why };
  const deadline = Date.now() + budgetMs;
  for (const n of prs) {
    const verdict = assessedPr(uses, n);
    if (!verdict) { why ??= `PR #${n} wasn't reviewed with engineering:code-review and then assessed with \`pr_risk.ts --pr ${n} --review <verdict>\` in this session`; continue; }
    if (verdict === "blocking") { why ??= `PR #${n}'s review is blocking (Critical or High findings): fix them first`; continue; }
    const left = deadline - Date.now();
    if (left < 2_000) { why ??= `PR #${n} couldn't be checked in time`; continue; }
    const r = await risk(cwd, { pr: n }, verdict as "ok" | "fix", left);
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
  /^gh\s+(?:pr\s+(?:view|list|checks|status|diff)|run\s+(?:list|view|watch))\b/,
  /^(?:echo|printf|grep|head|tail|wc|sleep|true)\b/,
];
// Options that make a routine command run another program or write a file.
const DANGER = /(?:^|\s)--(?:upload-pack|receive-pack|exec|output|ext-diff|post-renderer|enable-alpha-plugins|enable-exec)\b|^git\s+(?:-C\s+\S+\s+)?-c\s|^gh\b.*\s(?:-R|--repo)\b/;
const KUBE_READ = new RegExp(String.raw`^(?:kubectl${FLAGS}\s+(?:get|describe|logs|wait|top|rollout\s+(?:status|history))|helm${FLAGS}\s+(?:list|status|get|history))\b`);

/**
 * The command text with heredoc bodies removed, when every heredoc is a quoted message fed to `git commit -F -`
 * or `gh pr create --body-file -` and nothing else could be parsed two ways (a backslash, a `<<` inside
 * quotes); else null.
 */
export function routineText(cmd: string): string | null {
  const h = parseHeredocs(cmd);
  if (h.markerInQuotes || h.text.includes("\\")) return null;
  for (const d of h.docs) {
    if (!d.quoted || d.dash || !d.terminated || d.feedsShell) return null;
    if (!/\bgit\s+(?:-C\s+\S+\s+)?commit\b[^;&|]*\s-F\s+-(?:\s|$)|\bgh\s+pr\s+create\b[^;&|]*\s--body-file\s+-(?:\s|$)/.test(d.line)) return null;
  }
  return h.text;
}

/**
 * True when every simple command is one a covered policy may approve outright: `cd` within the repository,
 * a covered outward step (the caller checks coverage), read-only kubectl/helm on a local cluster, `gh pr create`
 * when the policy opens PRs, or a routine git, gh or text command without options that run programs or write
 * files. Anything the parser could read two ways, command substitution, a background `&`, a redirect into a
 * file, or a `cd`/`git -C` out of the repository (its git hooks would run) means the normal permission flow
 * decides instead.
 */
export function routineOnly(cmd: string, policy: Autonomy, kubeContext: () => string | null = () => null, cwd = process.cwd()): boolean {
  const text = routineText(cmd);
  if (text === null) return false;
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } }; // macOS: /var is /private/var
  const root = real(run(["git", "rev-parse", "--show-toplevel"], cwd) ?? resolve(cwd));
  const inside = (p: string | null) => { if (!p) return false; const r = real(p); return r === root || r.startsWith(root + "/"); };
  let here = resolve(cwd);
  for (const seg of segments(text)) {
    if (/\$\(|`|[<>]\(/.test(blankQuotes(seg, true))) return false;
    const bare = blankQuotes(seg);
    if (/(?<![&>|])&(?![&>])/.test(bare) || DANGER.test(bare)) return false;
    for (const m of bare.matchAll(/>>?\s*([^\s&]\S*)/g)) if (m[1] !== "/dev/null") return false;
    const cd = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(seg);
    if (cd) { const to = pathFrom(here, cd[1] ?? cd[2] ?? cd[3]); if (!to || !inside(to)) return false; here = to; continue; }
    const dashC = /^git\s+-C\s+(\S+)/.exec(seg)?.[1];
    if (dashC && !inside(pathFrom(here, dashC))) return false;
    if (/^(?:kubectl|helm)\b/.test(seg)) {
      if (!isLocal(seg, policy, kubeContext) || !(classifyCommand(seg).irreversible || KUBE_READ.test(seg))) return false;
      continue;
    }
    // Outward steps must be the plain command: `GIT_SSH_COMMAND=… git push` or a wrapper runs other code.
    if (classifyCommand(seg).irreversible) { if (!/^(?:git\s+(?:-C\s+\S+\s+)?push|gh\s+(?:pr\s+merge|workflow\s+run))\s/.test(seg)) return false; continue; }
    if (/^gh\s+pr\s+create\b/.test(seg)) { if (!policy.openPr) return false; continue; }
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
    let staged: string | null = null;
    try {
      const p = Bun.spawnSync(["git", "diff", "--cached", "-U0", "--no-color", "--no-ext-diff"], { cwd });
      staged = p.exitCode === 0 ? p.stdout.toString() : null;
    } catch { /* cwd removed: nothing to scan, and the checks below still run */ }
    const high = staged ? scanPatch(staged).filter((f) => f.confidence === "high") : [];
    if (high.length) {
      console.log(decide("deny", `Staged changes contain ${high.length} likely secret(s): ${high.slice(0, 3).map((f) => `${f.rule} at ${f.file}:${f.line} (${f.masked})`).join("; ")}. Remove them (use env/config) before committing; rotate any real secret.`));
      return 0;
    }
  }
  if (!c.irreversible) return 0;
  const policy = parseAutonomy(loadConfig(cwd));
  let ctx: string | null | undefined;
  const kube = () => (ctx === undefined ? (ctx = run(["kubectl", "config", "current-context"], cwd)) : ctx);
  const merging = segments(withoutHeredocs(cmd)).filter((s) => classifyCommand(s).irreversible === "gh pr merge").map(mergedPr);
  const prs = merging.filter((m): m is { n: number; repo: string | null } => m !== null).map((m) => m.n);
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
