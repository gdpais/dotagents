// memoGit: each (cwd, args) runs once; callers share the result, failures (null) included.
import { expect, test } from "bun:test";
import { memoGit } from "../skills/delivery-lifecycle/scripts/classify_change";

test("memoGit runs each (cwd, args) once and shares the result", async () => {
  const calls: string[] = [];
  const g = memoGit(async (args, cwd) => { calls.push(`${cwd}:${args.join(" ")}`); return args[0] === "fail" ? null : `${cwd}/${args.join("-")}`; });
  const [a, b] = await Promise.all([g(["rev-parse", "--show-toplevel"], "/r"), g(["rev-parse", "--show-toplevel"], "/r")]);
  expect(a).toBe("/r/rev-parse---show-toplevel");
  expect(b).toBe(a);
  expect(await g(["rev-parse", "--show-toplevel"], "/other")).toBe("/other/rev-parse---show-toplevel");
  expect(await g(["fail"], "/r")).toBeNull();
  expect(await g(["fail"], "/r")).toBeNull();
  expect(calls).toEqual(["/r:rev-parse --show-toplevel", "/other:rev-parse --show-toplevel", "/r:fail"]);
});
