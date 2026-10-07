/** Unit tests for the eval harness helpers. Run with `bun test` from claude/evals/harness. */
import { expect, test } from "bun:test";
import { majority, mask, parseVerdicts } from "./grade";
import { diffCI, quality } from "./report";
import { parseTranscript } from "./score";

test("transcript parsing finds tools, skills, hook feedback and the result", () => {
  const lines = [
    { type: "system", subtype: "init", model: "m" },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "security-review" } }, { type: "tool_use", name: "Bash", input: { command: "bun test" } }] } },
    { type: "user", message: { content: [{ type: "text", text: "Stop hook feedback:\n..." }] } },
    { type: "result", subtype: "success", total_cost_usd: 0.4, num_turns: 5 },
  ].map((x) => JSON.stringify(x)).join("\n");
  const t = parseTranscript(lines + "\nnot json");
  expect(t.skills).toEqual(["security-review"]);
  expect(t.bash).toEqual(["bun test"]);
  expect(t.stopFeedback).toBe(1);
  expect(t.result.total_cost_usd).toBe(0.4);
});

test("grader masks workflow names and parses verdicts strictly", () => {
  expect(mask("ran preflight.ts and delivery:performance-review via the Stop hook")).toBe("ran [tool] and [tool] via the [tool]");
  expect(parseVerdicts('x [{"pass":true},{"pass":"yes"}] y', 2)!.map((v) => v.pass)).toEqual([true, false]);
  expect(parseVerdicts("[{}]", 2)).toBeNull();
});

test("quality: implement uses hidden tests and checks; review uses assertion share only", () => {
  expect(quality({ kind: "implement", hidden: { passed: true }, checks: { suite_passes: true } }, null)).toBe(1);
  expect(quality({ kind: "implement", hidden: { passed: true }, checks: { suite_passes: false } }, null)).toBe(0);
  expect(quality({ kind: "review", checks: { repo_untouched: false } }, { passed: 3, total: 4 })).toBe(0.75);
});

test("majority vote: strict on ties, per assertion", () => {
  const v = (a: boolean, b: boolean) => [{ pass: a, evidence: "x" }, { pass: b, evidence: "y" }];
  const m = majority([v(true, false), v(true, true), v(false, false)], 2);
  expect(m.map((x) => x.pass)).toEqual([true, false]);
  expect(m[0].votes).toBe("2/3");
  expect(majority([v(true, false), v(false, true)], 2).map((x) => x.pass)).toEqual([false, false]);
});

test("stratified bootstrap CI brackets a clear difference", () => {
  const a = new Map([["e1", [0, 0, 0]], ["e2", [0.5, 0.5, 0.5]]]);
  const b = new Map([["e1", [1, 1, 1]], ["e2", [1, 1, 1]]]);
  const [p, lo, hi] = diffCI(a, b);
  expect(p).toBeCloseTo(0.75);
  expect(lo).toBeCloseTo(0.75);
  expect(hi).toBeCloseTo(0.75);
});
