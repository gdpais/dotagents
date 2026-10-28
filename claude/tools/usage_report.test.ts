/**
 * Tests for usage_report.ts. Run with `bun test` from claude/tools.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { aggregate, canon, classify, loadCatalog } from "./usage_report";

let tmp: string, root: string, projects: string;
const put = (base: string, name: string, text: string) => {
  mkdirSync(dirname(join(base, name)), { recursive: true });
  writeFileSync(join(base, name), text);
};
const jsonl = (recs: object[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const T = "2026-10-05T12:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T) + min * 60000).toISOString();
const day = (() => { const d = new Date(T); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const pick = (rows: any[], where: Record<string, unknown>) => rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
const one = (rows: any[], where: Record<string, unknown>) => { const r = pick(rows, where); expect(r.length).toBe(1); return r[0]; };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "usage-"));
  root = join(tmp, "claude");
  projects = join(tmp, "projects");
  put(root, "README.md", "| Skill | Workflow | Use |\n|---|---|---|\n| tech-email | incident-response | Email |\n| defect-first-review | code-review | Review |\n");
  for (const s of ["tech-email", "defect-first-review"]) put(root, `skills/${s}/SKILL.md`, "x");
  for (const s of ["delivery-lifecycle", "performance-review"]) put(root, `plugins/delivery/skills/${s}/SKILL.md`, "x");
  for (const w of ["code-review", "delivery", "incident-response"]) put(root, `workflows/${w}/SUMMARY.md`, "x");

  const cwd = "/Users/me/code/app/.claude/worktrees/feature-x";
  const base = { sessionId: "s1", cwd };
  put(projects, "-Users-me-code-app/s1.jsonl", jsonl([
    { ...base, type: "user", timestamp: at(0), message: { role: "user", content: "add the export endpoint" } },
    { ...base, type: "assistant", timestamp: at(1), attributionSkill: "delivery:delivery-lifecycle",
      message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 3, output_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 7 },
        content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "delivery:delivery-lifecycle" } }] } },
    // the same reply split over two records: one turn, two tool calls
    { ...base, type: "assistant", timestamp: at(1), message: { id: "m1", model: "claude-opus-5-5", usage: { output_tokens: 10 },
      content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "bun test" } }, { type: "tool_use", id: "t3", name: "Agent", input: { description: "review" } }] } },
    { ...base, type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "1 fail" }] } },
    { ...base, type: "user", timestamp: at(3), message: { role: "user", content: "<command-name>/anthropic-skills:tech-email</command-name>" } },
    { ...base, type: "user", timestamp: at(4), message: { role: "user", content: "<task-notification>done</task-notification>" } },
    { type: "cost-state", sessionId: "s1", totalCostUSD: 0.5, totalLinesAdded: 4, modelUsage: { "claude-opus-5-5": { costUSD: 0.5 } } },
    { type: "cost-state", sessionId: "s1", totalCostUSD: 1.25, totalLinesAdded: 10, totalLinesRemoved: 2, modelUsage: { "claude-opus-5-5": { costUSD: 1.25 } } },
    { type: "pr-link", sessionId: "s1", prNumber: 7, prRepository: "me/app", timestamp: at(5) },
    { ...base, type: "attachment", timestamp: at(5), attachment: { type: "hook_system_message", hookName: "Stop",
      content: "Delivery notes (not blocking): infra: CI/CD or infrastructure file (ci.yml); security: security-sensitive path (auth.ts) → consider security-review" } },
    { ...base, type: "attachment", timestamp: at(5), attachment: { type: "hook_success", hookEvent: "Stop", command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" stop_gate.ts' } },
    { ...base, type: "system", subtype: "stop_hook_summary", timestamp: at(6),
      hookErrors: ['[bun "/x/hooks/stop_gate.ts"]: Delivery check before finishing (automatic, 1):\n- Review needed (security): dynamic code execution'] },
    { ...base, type: "user", timestamp: at(7), permissionDecision: { decision: "reject", source: "hook", reasonType: "hook" },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "asked" }] } },
  ]));
  // a subagent working in a subfolder; its folder sorts before s1.jsonl
  const sub = { ...base, cwd: "/Users/me/code/app/docs" };
  put(projects, "-Users-me-code-app/s1/subagents/agent-a1.jsonl", jsonl([
    { ...sub, type: "user", isSidechain: true, timestamp: at(2), message: { role: "user", content: "review the diff" } },
    { ...sub, type: "assistant", isSidechain: true, timestamp: at(2), attributionAgent: "general-purpose", message: { id: "m2", model: "claude-opus-5-5", usage: { output_tokens: 5 }, content: [] } },
  ]));
  const ev = { sessionId: "s2", cwd: "/private/tmp/x/scratchpad/it5/runs/task/r1/repo" };
  put(projects, "-private-tmp-claude-501--Users-me-dotagents-abc-scratchpad-it5-runs-task-r1-repo/s2.jsonl", jsonl([
    { ...ev, type: "user", timestamp: at(0), message: { role: "user", content: "is my branch slower?" } },
    { ...ev, type: "assistant", timestamp: at(1), message: { id: "m3", model: "claude-sonnet-5-5", usage: { output_tokens: 20 },
      content: [{ type: "tool_use", id: "t4", name: "Skill", input: { skill: "delivery:performance-review" } }] } },
    { ...ev, type: "system", subtype: "api_error", timestamp: at(2), error: { message: '429 {"type":"rate_limit_error"}' } },
  ]));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test("the catalog comes from the repo's skills, plugins, README table and workflows", () => {
  const cat = loadCatalog(root);
  expect(Object.fromEntries(cat.custom)).toEqual({
    "tech-email": ["incident-response", "Custom skill"], "defect-first-review": ["code-review", "Custom skill"],
    "delivery-lifecycle": ["delivery", "Delivery plugin"], "performance-review": ["delivery", "Delivery plugin"],
  });
  expect(cat.workflows).toEqual(["delivery", "code-review", "incident-response"]);
  expect(canon("delivery:delivery-lifecycle", cat)).toBe("delivery-lifecycle");
  expect(canon("/anthropic-skills:tech-email", cat)).toBe("tech-email");
  expect(canon("engineering:code-review", cat)).toBe("engineering:code-review");
});

test("sessions are split into your own and automated runs, worktrees counted toward their repo", () => {
  expect(classify("-Users-me-code-app", "/Users/me/code/app/.claude/worktrees/x", "/Users/me")).toEqual(["interactive", "app"]);
  expect(classify("-Users-me", "/Users/me", "/Users/me")).toEqual(["interactive", "Home folder"]);
  expect(classify("-private-var-folders-lp-T-grader-abc", undefined)).toEqual(["automated", "Eval graders"]);
  expect(classify("-private-tmp-x-scratchpad-evals-runs-a", undefined)).toEqual(["automated", "Delivery evals it1"]);
  expect(classify("-private-tmp-x-scratchpad-it6-v3-runs-a", undefined)).toEqual(["automated", "Delivery evals it6"]);
  expect(classify("-private-tmp-x-scratchpad-pilot-a", undefined)).toEqual(["automated", "Eval pilot and smoke runs"]);
});

test("skills, turns, tools, cost and PRs are counted once per scope", () => {
  const d = aggregate(projects, loadCatalog(root), "/Users/me");
  expect(one(d.kpis, { scope: "interactive" })).toMatchObject({ sessions: 1, prompts: 2, turns: 2, cost_usd: 1.25, skill_invocations: 2, custom_invocations: 2,
    custom_unused: 2, subagents: 1, prs: 1, lines_added: 10, lines_removed: 2, first_day: day });
  expect(one(d.kpis, { scope: "automated" })).toMatchObject({ sessions: 1, skill_invocations: 1 });
  expect(one(d.kpis, { scope: "all" })).toMatchObject({ sessions: 2, skill_invocations: 3, custom_unused: 1 });

  expect(one(d.skills, { scope: "interactive", skill: "delivery-lifecycle" })).toMatchObject({ origin: "Delivery plugin", workflow: "delivery", by_model: 1, by_you: 0, turns: 1, output_tokens: 10 });
  expect(one(d.skills, { scope: "interactive", skill: "tech-email" })).toMatchObject({ by_model: 0, by_you: 1, sessions: 1 });
  expect(one(d.skills, { scope: "interactive", skill: "defect-first-review" })).toMatchObject({ invocations: 0, last_used: "" });
  expect(one(d.skills, { scope: "all", skill: "performance-review" })).toMatchObject({ invocations: 1 });

  expect(one(d.tools, { scope: "interactive", tool: "Bash" })).toMatchObject({ calls: 1, errors: 1 });
  expect(one(d.models, { scope: "interactive", model: "claude-opus-5-5" })).toMatchObject({ turns: 2, output_tokens: 15, cache_read_tokens: 90, cost_usd: 1.25 });
  expect(one(d.daily, { scope: "interactive", day })).toMatchObject({ sessions: 1, prompts: 2, tool_calls: 3, cost_usd: 1.25 });
  expect(one(d.projects, { scope: "interactive", project: "app" })).toMatchObject({ sessions: 1, prs: 1, cost_usd: 1.25 });
  expect(one(d.projects, { scope: "automated" })).toMatchObject({ project: "Delivery evals it5" });
});

test("workflows roll up their own skills and the delivery gates are read from hook output", () => {
  const d = aggregate(projects, loadCatalog(root), "/Users/me");
  expect(one(d.workflows, { scope: "interactive", workflow: "delivery" })).toMatchObject({ custom_skills: 2, skills_used: 1, custom_invocations: 1, last_used: day });
  expect(one(d.workflows, { scope: "all", workflow: "delivery" })).toMatchObject({ skills_used: 2, custom_invocations: 2 });
  expect(one(d.workflows, { scope: "interactive", workflow: "code-review" })).toMatchObject({ custom_invocations: 0, sessions: 0 });

  const g = (event: string, detail: string) => one(d.gate, { scope: "interactive", event, detail }).count;
  expect(g("Stop gate: review note", "infra")).toBe(1);
  expect(g("Stop gate: review note", "security")).toBe(1);
  expect(g("Stop gate: blocked", "security")).toBe(1);
  expect(g("Bash guard", "Asked / blocked")).toBe(1);
  expect(g("Gate runs", "Stop")).toBe(1);
  expect(one(d.gate, { scope: "automated", event: "Gate runs", detail: "Stop" }).count).toBe(0);
  expect(one(d.guardrails, { scope: "automated", kind: "API error" })).toMatchObject({ reason: "Rate limit (429)", count: 1 });
  expect(one(d.guardrails, { scope: "interactive", kind: "Permission" })).toMatchObject({ outcome: "Blocked", reason: "Delivery hook" });
});

test("the CLI writes one JSON file per dataset", () => {
  const out = join(tmp, "out");
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "usage_report.ts"), "--projects", projects, "--out", out, "--root", root]);
  expect(p.exitCode).toBe(0);
  for (const name of ["kpis", "skills", "skill_daily", "workflows", "gate", "daily", "models", "projects", "tools", "hours", "guardrails"]) {
    expect(existsSync(join(out, name + ".json"))).toBe(true);
  }
  expect(JSON.parse(readFileSync(join(out, "hours.json"), "utf8")).length).toBeGreaterThan(0);
});
