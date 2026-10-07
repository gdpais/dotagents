#!/usr/bin/env bun
/**
 * Validate the skills in this repository before they are installed.
 *
 * Checks, per skills/<name>/SKILL.md and plugins/<plugin>/skills/<name>/SKILL.md:
 *   - YAML frontmatter parses and has exactly `name` and `description`
 *   - `name` equals the folder name, is kebab-case and at most 64 characters
 *   - `description` is non-empty and at most 1024 characters
 *   - every `scripts/<file>` the SKILL.md mentions exists in that skill folder
 *     (`scripts/x.py:27`-style citations in worked examples are ignored)
 *   - every `engineering:<skill>` it hands off to is one that stays installed
 * Per plugins/<plugin>: plugin.json parses and matches the folder; hook scripts exist.
 * And, for every Markdown file under the root:
 *   - relative links resolve to an existing file
 *
 * Usage: validate_skills.ts [--root DIR]   (default: the folder above tools/)
 * Exit 0 when clean, 1 when any error is found. Warnings never fail the run.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

// Anthropic engineering skills the custom skills may hand off to (G-14 keeps these on).
export const ENGINEERING_KEPT = new Set(["architecture", "debug", "deploy-checklist", "documentation", "system-design", "tech-debt", "testing-strategy", "standup"]);
// Turned off in the user's setup (G-14); naming them is fine only to say "prefer X over it".
const ENGINEERING_OFF = new Set(["code-review", "incident-response"]);

export interface Issue { level: "error" | "warning"; file: string; message: string }

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

export function checkSkill(skillDir: string, root: string): Issue[] {
  const issues: Issue[] = [];
  const file = join(skillDir, "SKILL.md");
  const rel = relative(root, file);
  const err = (message: string) => issues.push({ level: "error", file: rel, message });
  if (!existsSync(file)) return [{ level: "error", file: relative(root, skillDir), message: "missing SKILL.md" }];
  const text = readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) { err("no YAML frontmatter"); return issues; }
  let fm: Record<string, unknown>;
  try { fm = Bun.YAML.parse(m[1]) as Record<string, unknown>; } catch (e) { err(`frontmatter does not parse: ${(e as Error).message}`); return issues; }
  const keys = Object.keys(fm ?? {}).sort();
  if (keys.join(",") !== "description,name") err(`frontmatter keys must be name and description, found: ${keys.join(", ")}`);
  const folder = skillDir.split("/").pop()!;
  const name = String(fm?.name ?? "");
  if (name !== folder) err(`name "${name}" does not match folder "${folder}"`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) err(`name "${name}" must be kebab-case, at most 64 characters`);
  const desc = String(fm?.description ?? "");
  if (!desc.trim()) err("empty description");
  if (desc.length > 1024) err(`description is ${desc.length} characters (max 1024)`);

  for (const s of new Set([...text.matchAll(/\bscripts\/([\w.-]+\.(?:ts|py|sh|js))(?!:\d)/g)].map((x) => x[1]))) {
    if (!existsSync(join(skillDir, "scripts", s))) err(`mentions scripts/${s}, which does not exist in this skill`);
  }
  for (const e of new Set([...text.matchAll(/engineering:([a-z-]+)/g)].map((x) => x[1]))) {
    if (ENGINEERING_OFF.has(e)) issues.push({ level: "warning", file: rel, message: `mentions engineering:${e}, which is turned off (G-14); fine only as a "prefer this over" note` });
    else if (!ENGINEERING_KEPT.has(e)) err(`hands off to engineering:${e}, which is not in the kept list`);
  }
  return issues;
}

export function checkLinks(file: string, root: string): Issue[] {
  const issues: Issue[] = [];
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = target.split("#")[0];
    if (path && !existsSync(resolve(dirname(file), path))) issues.push({ level: "error", file: relative(root, file), message: `broken link: ${target}` });
  }
  return issues;
}

// Skill folders: skills/<name> and plugins/<plugin>/skills/<name>.
export function skillDirs(root: string): string[] {
  const parents = [join(root, "skills")];
  const plugins = join(root, "plugins");
  if (existsSync(plugins)) for (const p of readdirSync(plugins).sort()) parents.push(join(plugins, p, "skills"));
  const out: string[] = [];
  for (const parent of parents) {
    if (!existsSync(parent)) continue;
    for (const name of readdirSync(parent).sort()) if (statSync(join(parent, name)).isDirectory()) out.push(join(parent, name));
  }
  return out;
}

/** plugin.json parses and names the folder; every hook command's script exists. */
export function checkPlugin(dir: string, root: string): Issue[] {
  const issues: Issue[] = [];
  const err = (file: string, message: string) => issues.push({ level: "error", file: relative(root, file), message });
  const manifest = join(dir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifest)) return [{ level: "error", file: relative(root, dir), message: "missing .claude-plugin/plugin.json" }];
  try {
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    if (m.name !== dir.split("/").pop()) err(manifest, `plugin name "${m.name}" does not match folder`);
  } catch (e) { err(manifest, `does not parse: ${(e as Error).message}`); }
  const hooks = join(dir, "hooks", "hooks.json");
  if (existsSync(hooks)) {
    try {
      const h = JSON.parse(readFileSync(hooks, "utf8"));
      for (const groups of Object.values(h.hooks ?? {}) as { hooks?: { command?: string }[] }[][]) {
        for (const g of groups) for (const x of g.hooks ?? []) {
          for (const [, rel] of (x.command ?? "").matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"' ]+)/g)) {
            if (!existsSync(join(dir, rel))) err(hooks, `hook command points to missing ${rel}`);
          }
        }
      }
    } catch (e) { err(hooks, `does not parse: ${(e as Error).message}`); }
  }
  return issues;
}

export function validate(root: string): Issue[] {
  const issues: Issue[] = [];
  for (const dir of skillDirs(root)) issues.push(...checkSkill(dir, root));
  const plugins = join(root, "plugins");
  if (existsSync(plugins)) for (const p of readdirSync(plugins).sort()) if (statSync(join(plugins, p)).isDirectory()) issues.push(...checkPlugin(join(plugins, p), root));
  for (const f of walk(root)) issues.push(...checkLinks(f, root));
  return issues;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { root: { type: "string" } } });
  const root = resolve(values.root ?? join(import.meta.dir, ".."));
  const issues = validate(root);
  const skills = skillDirs(root).length;
  for (const i of issues) console.log(`${i.level.toUpperCase()}  ${i.file}: ${i.message}`);
  const errors = issues.filter((i) => i.level === "error").length;
  console.log(`${skills} skill(s) checked: ${errors} error(s), ${issues.length - errors} warning(s)`);
  process.exit(errors ? 1 : 0);
}
