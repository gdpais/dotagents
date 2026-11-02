/**
 * Tests for permission_audit.ts. Run with `bun test` from claude/tools.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { audit, render, scanTranscript } from "./permission_audit";

let tmp: string;
const put = (name: string, recs: object[]) => {
  mkdirSync(dirname(join(tmp, name)), { recursive: true });
  writeFileSync(join(tmp, name), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const call = (id: string, name: string, input: object) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, pd: object, timestamp = "2026-10-23T09:14:00.000Z") =>
  ({ type: "user", timestamp, permissionDecision: pd, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const hookSaid = (id: string, decision: string, reason: string) =>
  ({ type: "attachment", attachment: { type: "hook_success", toolUseID: id, hookName: "PreToolUse:Bash", stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }) } });

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "perm-audit-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const SESSION = [
  call("t1", "Bash", { command: "gh pr merge 60 --merge" }),
  hookSaid("t1", "ask", "gh pr merge is outward-facing or hard to undo; it needs the user's explicit go (delivery approval rules)."),
  result("t1", { decision: "accept", source: "user_temporary", grantScope: "once" }),
  call("t2", "mcp__ccd_pr__set_monitor", { auto_fix: true, url: "https://github.com/o/r/pull/66" }),
  result("t2", { decision: "reject", source: "config", reasonType: "classifier", reasonCode: "classifier:auto-mode" }),
  call("t3", "Bash", { command: "kubectl --context kind-x create namespace a" }),
  result("t3", { decision: "reject", source: "config", reasonType: "classifier", reasonCode: "classifier:auto-mode", classifierCategory: "shared_cluster_mutation" }),
  call("t4", "Bash", { command: "git push -u origin HEAD" }),
  hookSaid("t4", "allow", "Covered by the delivery autonomy policy."),
  result("t4", { decision: "accept", source: "hook", reasonType: "hook" }),
  call("t5", "Read", { file_path: "/x" }),
  result("t5", { decision: "accept", source: "config", reasonType: "classifier" }),
  call("t6", "Bash", { command: "rm -rf build" }),
  result("t6", { decision: "reject", source: "user_temporary" }, "2026-10-20T10:00:00.000Z"),
];

test("scanTranscript: who stopped each call, and what was approved without a prompt", () => {
  const a = scanTranscript(SESSION.map((r) => JSON.stringify(r)).join("\n"), { project: "p", session: "s1", subagent: false });
  expect(a.stops.map((s) => [s.tool, s.outcome, s.cause])).toEqual([
    ["Bash", "you approved", "hook ask: gh pr merge"],
    ["mcp__ccd_pr__set_monitor", "auto mode blocked", "classifier"],
    ["Bash", "auto mode blocked", "classifier [shared_cluster_mutation]"],
    ["Bash", "you declined", "permission rules"],
  ]);
  expect(a.stops[1].input).toBe("https://github.com/o/r/pull/66");
  expect(a.auto).toEqual({ "hook/hook": 1, "config/classifier": 1 });
});

test("audit: walks sessions and subagents, filters by project and date; render groups by cause", () => {
  put("-Users-me-Heartbeat/s1.jsonl", SESSION);
  put("-Users-me-Heartbeat/s1/subagents/agent-a1.jsonl", [call("u1", "Bash", { command: "gh workflow run scenarios.yml" }),
    hookSaid("u1", "ask", "gh workflow run is outward-facing or hard to undo; it needs the user's explicit go (delivery approval rules)."),
    result("u1", { decision: "accept", source: "user_temporary" })]);
  put("-Users-me-other/s2.jsonl", SESSION);
  const a = audit(tmp, { project: "Heartbeat", since: "2026-10-22" });
  expect(a.stops.length).toBe(4);
  expect(a.stops.find((s) => s.subagent)).toMatchObject({ session: "s1", cause: "hook ask: gh workflow run" });
  expect(audit(tmp).stops.length).toBe(9);
  const text = render(a);
  expect(text).toContain("4 call(s) stopped for permission; 2 approved without a prompt");
  expect(text).toContain("1× auto mode blocked · classifier [shared_cluster_mutation] · Bash");
  expect(text).toContain("(subagent)");
});
