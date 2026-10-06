#!/usr/bin/env bun
/**
 * Propose the next semantic version and a changelog from Conventional Commits.
 *
 * Read-only: runs only `git rev-parse`, `git tag --list`, `git rev-list` and
 * `git log`. It never creates tags, commits, or files.
 *
 * Options:
 *   -C PATH            repository (default: current directory)
 *   --from REF         start after this ref (default: the latest semver tag reachable from --to)
 *   --to REF           end ref (default: HEAD)
 *   --tag-prefix P     tag prefix (default: "v")
 *   --format json|md   output (default: json; md prints the changelog section only)
 *
 * Bump rules: a breaking change (`type!:` or a `BREAKING CHANGE:` footer) is major
 * (minor while the version is 0.x); `feat` is minor; `fix`, `perf`, `revert` are
 * patch; anything else alone is no release. Commits that do not follow the
 * convention are listed under `unconventional` so a human can classify them.
 */
import { parseArgs } from "node:util";

export interface Commit { sha: string; subject: string; body: string }
export interface Parsed { sha: string; type: string; scope: string | null; breaking: boolean; description: string; breakingNote?: string; conventional: boolean; subject: string }
type Bump = "major" | "minor" | "patch" | "none";

const CC = /^(\w+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseCommit(c: Commit): Parsed {
  const m = CC.exec(c.subject.trim());
  const footer = /^BREAKING[ -]CHANGE:\s*([\s\S]+?)(?:\n\n|$)/m.exec(c.body);
  if (!m) return { sha: c.sha, type: "other", scope: null, breaking: !!footer, description: c.subject.trim(), breakingNote: footer?.[1].trim(), conventional: false, subject: c.subject };
  return {
    sha: c.sha, type: m[1].toLowerCase(), scope: m[2] ?? null, breaking: !!m[3] || !!footer, description: m[4].trim(),
    breakingNote: footer?.[1].trim(), conventional: true, subject: c.subject,
  };
}

export function bumpFor(commits: Parsed[], current: string | null): Bump {
  const isZero = current !== null && SEMVER.exec(current)?.[1] === "0";
  if (commits.some((c) => c.breaking)) return isZero ? "minor" : "major";
  if (commits.some((c) => c.type === "feat")) return "minor";
  if (commits.some((c) => ["fix", "perf", "revert"].includes(c.type))) return "patch";
  return "none";
}

export function nextVersion(current: string | null, bump: Bump): string | null {
  if (bump === "none") return current;
  if (current === null) return bump === "major" ? "1.0.0" : "0.1.0";
  const m = SEMVER.exec(current);
  if (!m) return null;
  let [maj, min, pat] = [+m[1], +m[2], +m[3]];
  if (m[4]) return `${maj}.${min}.${pat}`; // a prerelease graduates to its release
  if (bump === "major") return `${maj + 1}.0.0`;
  if (bump === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

const SECTIONS: [string, (c: Parsed) => boolean][] = [
  ["Breaking changes", (c) => c.breaking],
  ["Features", (c) => c.type === "feat"],
  ["Fixes", (c) => c.type === "fix"],
  ["Performance", (c) => c.type === "perf"],
  ["Reverts", (c) => c.type === "revert"],
  ["Security", (c) => c.type === "security" || (c.type === "fix" && c.scope === "security")],
  ["Other changes", (c) => c.conventional && !["feat", "fix", "perf", "revert", "security"].includes(c.type) && !["docs", "test", "chore", "ci", "style", "build", "refactor"].includes(c.type)],
  ["Unclassified (review before release)", (c) => !c.conventional],
];

export function changelog(version: string | null, date: string, commits: Parsed[]): string {
  const lines = [`## ${version ?? "Unreleased"} (${date})`, ""];
  for (const [title, pick] of SECTIONS) {
    const items = commits.filter(pick);
    if (!items.length) continue;
    lines.push(`### ${title}`, "");
    for (const c of items) {
      const text = title === "Breaking changes" && c.breakingNote ? c.breakingNote : c.description;
      lines.push(`- ${c.scope ? `**${c.scope}:** ` : ""}${text} (${c.sha.slice(0, 7)})`);
    }
    lines.push("");
  }
  const hidden = commits.filter((c) => c.conventional && ["docs", "test", "chore", "ci", "style", "build", "refactor"].includes(c.type) && !c.breaking).length;
  if (hidden) lines.push(`_${hidden} maintenance commit(s) (docs, tests, chores, CI, refactors) not listed._`, "");
  return lines.join("\n").trimEnd() + "\n";
}

async function git(args: string[], cwd?: string): Promise<string | null> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? out.trim() : null;
}

export async function latestTag(to: string, prefix: string, cwd?: string): Promise<string | null> {
  const tags = (await git(["tag", "--list", `${prefix}*`, "--merged", to, "--sort=-v:refname"], cwd)) ?? "";
  return tags.split("\n").find((t) => SEMVER.test(t.slice(prefix.length))) ?? null;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: {
      help: { type: "boolean", short: "h" }, C: { type: "string", short: "C" }, from: { type: "string" }, to: { type: "string" },
      "tag-prefix": { type: "string" }, format: { type: "string" } } }));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (values.help) { console.log("usage: release_plan.ts [-C PATH] [--from REF] [--to REF] [--tag-prefix v] [--format json|md]"); return 0; }
  const cwd = values.C, to = values.to ?? "HEAD", prefix = values["tag-prefix"] ?? "v";
  if (!(await git(["rev-parse", "--verify", "--quiet", `${to}^{commit}`], cwd))) {
    console.log(JSON.stringify({ error: `cannot resolve ${to}` }));
    return 2;
  }
  const from = values.from ?? (await latestTag(to, prefix, cwd));
  const current = from && from.startsWith(prefix) && SEMVER.test(from.slice(prefix.length)) ? from.slice(prefix.length) : null;
  const range = from ? `${from}..${to}` : to;
  const raw = await git(["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", range], cwd);
  if (raw === null) { console.log(JSON.stringify({ error: `git log ${range} failed` })); return 2; }
  const commits = raw.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, subject, body] = r.split("\x1f");
    return parseCommit({ sha, subject, body: body ?? "" });
  });
  const bump = bumpFor(commits, current);
  const next = nextVersion(current, bump);
  const date = new Date().toISOString().slice(0, 10);
  const notes = changelog(next ? `${prefix}${next}` : null, date, commits);
  if (values.format === "md") { process.stdout.write(notes); return 0; }
  console.log(JSON.stringify({
    from: from ?? null, to, current_version: current, bump, next_version: next, next_tag: next && bump !== "none" ? `${prefix}${next}` : null,
    commits: commits.length, breaking: commits.filter((c) => c.breaking).map((c) => ({ sha: c.sha.slice(0, 7), note: c.breakingNote ?? c.description })),
    unconventional: commits.filter((c) => !c.conventional).map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject })),
    changelog: notes,
    note: from ? undefined : "No previous semver tag found; the whole history was used.",
  }, null, 2));
  return 0;
}

if (import.meta.main) process.exit(await main());
