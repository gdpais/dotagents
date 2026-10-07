/**
 * Tests for validate_skills.ts. Run with `bun test` from claude/tools.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validate } from "./validate_skills";

let root: string;
const put = (name: string, text: string) => {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), text);
};
const skill = (name: string, body = "", fm = `name: ${name}\ndescription: Does a thing.`) => put(`skills/${name}/SKILL.md`, `---\n${fm}\n---\n\n# ${name}\n${body}\n`);
const messages = () => validate(root).map((i) => `${i.level}: ${i.message}`);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "validate-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a clean skill passes", () => {
  skill("good-skill", "See [ref](references/a.md). Run `bun scripts/x.ts`. Example finding at scripts/fake.py:27. Hand off to `engineering:debug`.");
  put("skills/good-skill/references/a.md", "ok");
  put("skills/good-skill/scripts/x.ts", "");
  expect(messages()).toEqual([]);
});

test("name mismatch, extra keys and bad frontmatter are errors", () => {
  skill("a-skill", "", "name: other\ndescription: x\nversion: 2");
  skill("b-skill", "", "name: b-skill\ndescription: \"unterminated");
  const m = messages().join("\n");
  expect(m).toContain('name "other" does not match folder "a-skill"');
  expect(m).toContain("frontmatter keys must be name and description");
  expect(m).toContain("frontmatter does not parse");
});

test("missing script, broken link and unknown engineering skill are errors", () => {
  skill("c-skill", "Run `scripts/missing.ts`. See [x](references/none.md#top). Use `engineering:made-up`.");
  const m = messages();
  expect(m).toContain("error: mentions scripts/missing.ts, which does not exist in this skill");
  expect(m).toContain("error: broken link: references/none.md#top");
  expect(m).toContain("error: hands off to engineering:made-up, which is not in the kept list");
});

test("turned-off engineering skills are warnings; links inside code fences are ignored", () => {
  skill("d-skill", "Prefer this over engineering:code-review.\n```\n[not a link](nowhere.md)\n```");
  expect(messages()).toEqual(["warning: mentions engineering:code-review, which is turned off (G-14); fine only as a \"prefer this over\" note"]);
});

test("over-long description is an error", () => {
  skill("e-skill", "", `name: e-skill\ndescription: ${"x".repeat(1100)}`);
  expect(messages().join()).toContain("description is 1100 characters");
});

test("plugin skills are validated and broken hook paths are errors", () => {
  put("plugins/demo/.claude-plugin/plugin.json", JSON.stringify({ name: "demo" }));
  put("plugins/demo/hooks/hooks.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'bun "${CLAUDE_PLUGIN_ROOT}/hooks/missing.ts"' }] }] } }));
  put("plugins/demo/skills/p-skill/SKILL.md", "---\nname: wrong\ndescription: x\n---\n");
  const m = messages().join("\n");
  expect(m).toContain("hook command points to missing hooks/missing.ts");
  expect(m).toContain('name "wrong" does not match folder "p-skill"');
});
