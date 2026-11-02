import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mask, parseReview } from "./grade";
import { armSetup, armSkill, forcedSkillRan } from "./run";
import { citations, figuresPresent, keyFigures } from "./score";
import { canonical, checkInit } from "../routing/route";
import { features, fitPrices } from "../routing/analyze";

const repo = () => {
  const d = mkdtempSync(join(tmpdir(), "h2h-"));
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src", "sso.ts"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"));
  return d;
};
const defects = [{ id: "D1", file: "src/sso.ts", line: 5 }, { id: "D3", file: "src/sso.ts", line: 11 }];

test("citations: valid lines, out-of-range lines and nearby planted defects", () => {
  const c = citations("See src/sso.ts:5, `src/sso.ts:40` and src/sso.ts lines 10-11; also b/src/sso.ts#L5.", repo(), defects);
  expect(c.map((x) => [x.from, x.valid])).toEqual([[5, true], [40, false], [10, true]]);
  expect(c[0].defects).toEqual(["D1"]);
  expect(c[2].defects).toEqual(["D3"]);
});

test("figuresPresent ignores thousands separators and partial numbers", () => {
  const f = figuresPresent("1,444 of 4,694 confirms failed (30.8%); 14440 is not it", { failed: 1444, denominator: 4694, rate: 30.8, other: 444 });
  expect(f).toEqual({ failed: true, denominator: true, rate: true, other: false });
  expect(keyFigures("inc-live", {})).toEqual({});
});

test("forcedSkillRan needs the command tag and the expanded skill body", () => {
  const tag = JSON.stringify({ type: "user", message: { content: "<command-name>/sre:rca-investigation</command-name>" } });
  const body = JSON.stringify({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "Base directory for this skill: x\n" + "y".repeat(300) }] } });
  expect(forcedSkillRan([tag, body].join("\n"), "sre:rca-investigation").ok).toBe(true);
  expect(forcedSkillRan(tag, "sre:rca-investigation").ok).toBe(false);
  expect(forcedSkillRan([tag, body].join("\n"), "engineering:incident-response").ok).toBe(false);
  const cr = JSON.stringify({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "`high effort → 8 inline angles`" + "z".repeat(300) }] } });
  expect(forcedSkillRan([JSON.stringify({ type: "user", message: { content: "<command-name>/code-review</command-name>" } }), cr].join("\n"), "code-review").level).toBe("high");
});

test("mask hides skill names, skill-used lines and local paths", () => {
  const m = mask("Used defect-first-review and sre:rca-investigation via ReportFindings\nSkill used: tech-email\nsee /private/tmp/x/scratchpad/h2h/runs/a");
  expect(m).not.toMatch(/defect-first|rca-investigation|ReportFindings|tech-email|scratchpad/);
});

test("parseReview reads defects, findings and house verdicts", () => {
  const key = { defects: [{ id: "D1" }, { id: "D2" }] };
  const p = parseReview('x {"defects":[{"id":"D1","found":true}],"findings":[{"finding":"a","class":"planted:D1"}],"house":[{"n":1,"pass":true,"evidence":""}]} y', key, 1);
  expect(p?.defects).toEqual({ D1: true, D2: false });
  expect(p?.findings[0].class).toBe("planted:D1");
  expect(parseReview("no json", key, 1)).toBeNull();
});

test("arms force the right skill and hide the competitors", () => {
  const ev = { family: "review", custom_skill: "delivery:defect-first-review" };
  expect([armSkill(ev, "none"), armSkill(ev, "builtin"), armSkill(ev, "custom")]).toEqual([null, "code-review", "delivery:defect-first-review"]);
  expect(armSkill({ family: "incident" }, "engineering")).toBe("engineering:incident-response");
  const out = mkdtempSync(join(tmpdir(), "h2h-arms-"));
  const eng = mkdtempSync(join(tmpdir(), "h2h-eng-"));
  for (const s of ["code-review", "incident-response", "debug"]) { mkdirSync(join(eng, "skills", s), { recursive: true }); writeFileSync(join(eng, "skills", s, "SKILL.md"), "x"); }
  const o = { sre: eng, reviewSkill: join(eng, "skills", "code-review"), engineering: eng };
  expect(armSetup(out, "review", "builtin", o).overrides["code-review"]).toBeUndefined();
  expect(armSetup(out, "review", "custom", o).overrides["code-review"]).toBe("off");
});

test("routing: init check and skill-name mapping", () => {
  const spec = { competing: { incident: ["sre:rca-investigation", "engineering:incident-response"], review: ["code-review", "engineering:code-review"] }, custom: ["sre:rca-investigation"] };
  expect(checkInit(["sre:rca-investigation", "engineering:incident-response", "code-review", "engineering:code-review"], "all", spec)).toEqual([]);
  expect(checkInit(["sre:rca-investigation", "rca-investigation", "engineering:incident-response", "code-review", "engineering:code-review"], "all", spec)).toHaveLength(1);
  expect(checkInit(["engineering:incident-response", "code-review", "engineering:code-review"], "engineering-only", spec)).toEqual([]);
  expect(canonical("rca-investigation", ["sre:rca-investigation", "code-review"])).toBe("sre:rca-investigation");
  expect(canonical("code-review", ["code-review", "engineering:code-review"])).toBe("code-review");
});

test("routing: price fit recovers known per-token prices", () => {
  const run = (cw: number, cr: number, out: number) => ({ usage: [{ input_tokens: 0, cache_creation_input_tokens: cw, cache_creation: { ephemeral_1h_input_tokens: cw }, cache_read_input_tokens: cr, output_tokens: 0 }],
    model_usage: { m: { outputTokens: out } }, cost_usd: cw * 8e-6 + cr * 0.2e-6 + out * 20e-6 });
  const fit = fitPrices([run(10000, 20000, 300), run(5000, 90000, 1200), run(15000, 40000, 50), run(2000, 10000, 900)]);
  expect(fit.per_mtok.cache_write_1h).toBeCloseTo(8, 6);
  expect(fit.per_mtok.output).toBeCloseTo(20, 6);
  expect(features(run(100, 200, 3)).out).toBe(3);
});
