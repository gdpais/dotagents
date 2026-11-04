import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loads } from "../scripts/_py.ts";
import { fingerprint, identity, inspectAll, inspectFile, inventory } from "../scripts/evidence_inventory.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "inventory-"));
const config = (timezone: string) => new Map([["timezone", timezone]]);
/** Round-trip through JSON text, as a --previous file would be. */
const reload = (value: unknown) => loads(JSON.stringify(value, (_, v) => (v instanceof Map ? Object.fromEntries(v) : v)));

test("incremental and configuration", async () => {
  const directory = tempDir();
  const a = join(directory, "a"), b = join(directory, "b");
  writeFileSync(a, "one");
  writeFileSync(b, "two");
  const first = reload(await inventory([a, b], config("UTC")));
  const second = reload(await inventory([a, b], config("UTC"), first));
  expect((second as any).get("sources").map((x: any) => x.get("preparation_action"))).toEqual(["candidate_reuse", "candidate_reuse"]);
  const revised = await inventory([a, b], config("Europe/Lisbon"), second);
  expect(revised.sources.map((x) => x.preparation_action)).toEqual(["reprocess", "reprocess"]);
  writeFileSync(a, "changed");
  const third = await inventory([a], config("UTC"), first);
  expect(third.sources.map((x) => x.change)).toEqual(["changed", "missing"]);
  expect((first as any).get("sources")[0].get("source_id")).toBe(third.sources[0].source_id);
  expect(existsSync(b)).toBe(true);
});

test("duplicates, empty files and errors", async () => {
  const directory = tempDir();
  const a = join(directory, "a"), b = join(directory, "b");
  writeFileSync(a, "");
  writeFileSync(b, "");
  const result = await inventory([a, b, a, directory, join(directory, "absent")]);
  expect(result.sources).toHaveLength(4);
  expect(result.duplicate_content_groups).toHaveLength(1);
  expect(result.sources.map((s) => s.status)).toEqual(["fingerprinted", "fingerprinted", "unreadable", "unreadable"]);
  expect(result.sources[3].error).toBe(`[Errno 2] No such file or directory: '${join(directory, "absent")}'`);
});

test("change during read never offers reuse", async () => {
  const path = join(tempDir(), "a");
  writeFileSync(path, "evidence");
  const values = ["1", "1", "2"];
  const result = await inventory([path], null, null, (paths) => paths.map((p) => inspectFile(p, () => values.shift() ?? "3")));
  expect(result.sources[0].status).toBe("unstable");
  expect(result.sources[0].content_sha256).toBeNull();
  expect(result.sources[0].preparation_action).toBe("retry_inspection");
});

test("reject inconsistent previous configuration", async () => {
  const prior = reload(await inventory([], config("UTC"))) as Map<string, any>;
  prior.get("configuration").set("timezone", "changed");
  await expect(inventory([], null, prior)).rejects.toThrow("fingerprint is inconsistent");
});

test("fingerprints and identities match the Python implementation", () => {
  expect(fingerprint(config("UTC"))).toBe("d4f3f7933ceda2199d83134866bd8568d4faa16c4cb8c180eaf71ca87d454b96");
  const tricky = loads('{"z": [1.0, 1e16, 1e-05, -0.0, 12345678901234567890, true, null], "caf\\u00e9": {"\\ud83d\\ude00": 1, "\\uffff": 2}}');
  expect(fingerprint(tricky)).toBe("3b6bdd418b5497fa4cc1ce0be619e86eae1d2414e04e2f518b06f08314566e81");
  expect(identity("/case/a.log")).toBe("src-8f67e9ed10f9a67926714f0655cafd8155b7c8fdbe5de1c0bf45d3a0c0fa7cd4");
});

test("parallel hashing matches sequential hashing", async () => {
  const directory = tempDir();
  const paths = ["a", "b", "c", "d", "e"].map((name, i) => {
    const path = join(directory, name);
    writeFileSync(path, Buffer.alloc(1_000_000 + i, i));
    return path;
  });
  paths.push(directory, join(directory, "absent"));
  expect(await inspectAll(paths, 0)).toEqual(paths.map((p) => inspectFile(p)));
});
