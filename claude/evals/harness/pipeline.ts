#!/usr/bin/env bun
/**
 * The whole eval pipeline in one command: run → score → grade → report. Every eval in evals-v2.json runs by
 * default, so the autonomy evals (nudges, i.e. repeated prompts) are measured next to quality and cost.
 *
 * Usage: bun pipeline.ts --out DIR --md FILE [any run.ts option: --arms, --reps, --evals, --concurrency,
 *        --budget, --model, --v1-skills, --prev-plugin, --timeout-min] [--grader-model sonnet] [--votes 3]
 * Resumable: finished runs, scores and grades are skipped, so re-running the command continues where it stopped.
 */
import { parseArgs } from "node:util";
import { main as run } from "./run";
import { main as score } from "./score";
import { main as grade } from "./grade";
import { main as report } from "./report";

const RUN_OPTS = ["arms", "reps", "evals", "concurrency", "budget", "model", "v1-skills", "prev-plugin", "timeout-min"];

export async function main(argv = process.argv.slice(2)) {
  const { values: o } = parseArgs({ args: argv, options: {
    out: { type: "string" }, md: { type: "string" }, "grader-model": { type: "string" }, votes: { type: "string" },
    ...Object.fromEntries(RUN_OPTS.map((k) => [k, { type: "string" as const }])) } });
  if (!o.out) { console.error("--out DIR is required"); return 2; }
  const pass = (keys: string[]) => keys.flatMap((k) => ((o as Record<string, string | undefined>)[k] ? [`--${k}`, (o as Record<string, string>)[k]] : []));
  for (const [name, step] of [
    ["run", () => run(["--out", o.out!, ...pass(RUN_OPTS)])],
    ["score", () => score(["--out", o.out!])],
    ["grade", () => grade(["--out", o.out!, ...(o["grader-model"] ? ["--model", o["grader-model"]] : []), ...pass(["votes"])])],
    ["report", () => report(["--out", o.out!, ...(o.md ? ["--md", o.md] : [])])],
  ] as const) {
    console.error(`== ${name}`);
    const code = await step();
    if (code) { console.error(`${name} failed (exit ${code})`); return code; }
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
