import { describe, expect, test } from "bun:test";
import { isDefaultRefspec, parseConfig } from "../skills/delivery-lifecycle/scripts/cleanup_merged";

describe("parseConfig", () => {
  test("reads `git config -z --get-regexp` entries; the last value is what `--get` returns", () => {
    const z = "branch.a.remote\norigin\0branch.a.merge\nrefs/heads/a\0branch.m.merge\nrefs/heads/x\0branch.m.merge\nrefs/heads/y\0";
    const c = parseConfig(z);
    expect(c.get("branch.a.remote")).toEqual(["origin"]);
    expect(c.get("branch.m.merge")?.at(-1)).toBe("refs/heads/y");
  });
  test("keeps dots in branch and remote names, trims values, reads a value-less key as empty", () => {
    const c = parseConfig("branch.feat/v1.2.remote\n origin \0branch.flag.remote\0remote.my.fork.fetch\n+refs/heads/*:refs/remotes/my.fork/*\0");
    expect(c.get("branch.feat/v1.2.remote")).toEqual(["origin"]);
    expect(c.get("branch.flag.remote")).toEqual([""]);
    expect(c.get("remote.my.fork.fetch")).toEqual(["+refs/heads/*:refs/remotes/my.fork/*"]);
  });
  test("empty output", () => expect(parseConfig("").size).toBe(0));
});

describe("isDefaultRefspec", () => {
  test("the clone default, with or without +", () => {
    expect(isDefaultRefspec(["+refs/heads/*:refs/remotes/origin/*"], "origin")).toBe(true);
    expect(isDefaultRefspec(["refs/heads/*:refs/remotes/origin/*"], "origin")).toBe(true);
  });
  test("anything the fetch may not mirror falls back to ls-remote", () => {
    expect(isDefaultRefspec(undefined, "origin")).toBe(false);
    expect(isDefaultRefspec(["+refs/heads/main:refs/remotes/origin/main"], "origin")).toBe(false);
    expect(isDefaultRefspec(["+refs/heads/*:refs/remotes/origin/*", "^refs/heads/wip"], "origin")).toBe(false);
    expect(isDefaultRefspec(["+refs/heads/*:refs/remotes/upstream/*"], "origin")).toBe(false);
    expect(isDefaultRefspec(["+refs/*:refs/*"], "origin")).toBe(false);
  });
});
