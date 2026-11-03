#!/usr/bin/env bun
/** Read-only source fingerprints and conservative incremental preparation plan. */
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync, writeSync, type BigIntStats } from "node:fs";
import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { dumps, loads, osErrorMessage, pyAbspath, PyNum, usageError, type PyValue } from "./_py.ts";

export const VERSION = 1;
/** Below this many bytes in total, worker start-up costs more than parallel hashing saves. */
const PARALLEL_THRESHOLD = 64 << 20;

class ValueError extends Error {}

type Dict = Map<string, PyValue> | { [key: string]: PyValue };
export type SourceRecord = Record<string, PyValue>;

const sha256 = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

const isDict = (v: unknown): v is Dict =>
  v instanceof Map || (typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof PyNum));
const get = (d: Dict, key: string): PyValue | undefined => (d instanceof Map ? d.get(key) : d[key]);

export function fingerprint(value: PyValue): string {
  return sha256(dumps(value, { sortKeys: true, separators: [",", ":"], ensureAscii: true }));
}

export function identity(path: string): string {
  return "src-" + sha256(path);
}

export type Snapshot = (info: BigIntStats) => string;
export const snapshot: Snapshot = (info) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");

export function inspectFile(path: string, snap: Snapshot = snapshot): SourceRecord {
  const result: SourceRecord = { source_id: identity(path), path, inspection: "fingerprint_only", content_sha256: null };
  let failedPath: string | undefined = path;
  try {
    const before = statSync(path, { bigint: true });
    if (!before.isFile()) throw new ValueError("Not a regular file");
    const hasher = new Bun.CryptoHasher("sha256");
    let count = 0;
    const fd = openSync(path, "r");
    let opened: BigIntStats, afterFd: BigIntStats;
    try {
      opened = fstatSync(fd, { bigint: true });
      failedPath = undefined; // read errors carry no filename in Python
      const buffer = new Uint8Array(4 << 20);
      for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
        hasher.update(buffer.subarray(0, n));
        count += n;
      }
      afterFd = fstatSync(fd, { bigint: true });
    } finally {
      closeSync(fd);
    }
    failedPath = path;
    const afterPath = statSync(path, { bigint: true });
    result.size_bytes = Number(before.size);
    result.bytes_read = count;
    // Evaluated lazily, like Python's chained before == opened == after_fd == after_path.
    const b = snap(before), o = snap(opened);
    let stable = b === o;
    if (stable) {
      const f = snap(afterFd);
      stable = o === f && f === snap(afterPath);
    }
    if (!stable || count !== Number(before.size)) {
      result.status = "unstable";
      result.error = "Source changed during read; retry on a stable copy";
    } else {
      result.status = "fingerprinted";
      result.content_sha256 = hasher.digest("hex");
    }
  } catch (e) {
    result.status = "unreadable";
    result.error = e instanceof ValueError ? e.message : osErrorMessage(e, failedPath);
  }
  return result;
}

/** Fingerprint files on worker threads when there is enough data to make it pay. */
export async function inspectAll(paths: string[], threshold = PARALLEL_THRESHOLD): Promise<SourceRecord[]> {
  let total = 0;
  for (const p of paths) {
    try { total += statSync(p).size; } catch { /* reported by inspectFile */ }
  }
  const poolSize = Math.min(paths.length, availableParallelism(), 8);
  if (poolSize < 2 || total < threshold) return paths.map((p) => inspectFile(p));
  const results: SourceRecord[] = new Array(paths.length);
  let next = 0;
  await Promise.all(Array.from({ length: poolSize }, () => new Promise<void>((resolve, reject) => {
    const worker = new Worker(import.meta.path);
    const feed = () => {
      if (next >= paths.length) { worker.terminate(); resolve(); return; }
      const index = next++;
      worker.postMessage({ index, path: paths[index] });
    };
    worker.onmessage = (event: MessageEvent<{ index: number; record: SourceRecord }>) => {
      results[event.data.index] = event.data.record;
      feed();
    };
    worker.onerror = (event) => { worker.terminate(); reject(event.error ?? new Error(event.message)); };
    feed();
  })));
  return results;
}

export function validatePrevious(previous: PyValue): asserts previous is Dict {
  const version = isDict(previous) ? get(previous, "schema_version") : undefined;
  // Python compares with ==, so 1, 1.0 and true all match VERSION.
  if (!isDict(previous) || !(version === true || (version instanceof PyNum && version.value === VERSION)))
    throw new ValueError("Previous inventory has an unsupported schema_version");
  const configuration = get(previous, "configuration");
  if (!isDict(configuration)) throw new ValueError("Previous inventory configuration must be an object");
  if (get(previous, "configuration_fingerprint") !== fingerprint(configuration))
    throw new ValueError("Previous inventory configuration fingerprint is inconsistent");
  const sources = get(previous, "sources");
  if (!Array.isArray(sources)) throw new ValueError("Previous inventory sources must be a list");
  const seen = new Set<string>();
  for (const item of sources) {
    const path = isDict(item) ? get(item, "path") : undefined;
    if (!isDict(item) || typeof path !== "string") throw new ValueError("Invalid previous source record");
    const sid = identity(path);
    if (get(item, "source_id") !== sid || seen.has(sid)) throw new ValueError("Invalid or duplicate previous source identity");
    seen.add(sid);
    const digest = get(item, "content_sha256");
    if (get(item, "status") === "fingerprinted" && (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)))
      throw new ValueError("Invalid previous content fingerprint");
  }
}

export async function inventory(
  paths: string[], configuration: PyValue = null, previous: PyValue = null,
  inspect: (paths: string[]) => SourceRecord[] | Promise<SourceRecord[]> = inspectAll,
) {
  configuration = configuration === null ? new Map() : configuration;
  if (!isDict(configuration)) throw new ValueError("Configuration must be a JSON object");
  const configHash = fingerprint(configuration);
  if (previous !== null) validatePrevious(previous);
  const old = new Map<string, Dict>();
  if (previous !== null) for (const s of get(previous, "sources") as Dict[]) old.set(get(s, "source_id") as string, s);
  const configChanged = previous !== null && get(previous, "configuration_fingerprint") !== configHash;
  const unique = [...new Set(paths.map(pyAbspath))];
  const sources: SourceRecord[] = [];
  for (const record of await inspect(unique)) {
    const prior = old.get(record.source_id as string);
    old.delete(record.source_id as string);
    let change: string, action: string;
    if (record.status !== "fingerprinted") [change, action] = ["unknown", "retry_inspection"];
    else if (prior === undefined) [change, action] = ["added", "prepare"];
    else if (get(prior, "status") !== "fingerprinted") [change, action] = ["unknown", "prepare"];
    else if (get(prior, "content_sha256") !== record.content_sha256) [change, action] = ["changed", "reprocess"];
    else [change, action] = ["unchanged", configChanged ? "reprocess" : "candidate_reuse"];
    record.change = change;
    record.preparation_action = action;
    sources.push(record);
  }
  for (const prior of old.values()) {
    sources.push({ source_id: get(prior, "source_id")!, path: get(prior, "path")!, status: "not_supplied", change: "missing",
      preparation_action: "review_scope", content_sha256: null });
  }
  const duplicates = new Map<string, string[]>();
  for (const source of sources) {
    const digest = source.content_sha256 as string | null;
    if (digest) duplicates.set(digest, [...(duplicates.get(digest) ?? []), source.source_id as string]);
  }
  return {
    schema_version: VERSION, configuration, configuration_fingerprint: configHash, configuration_changed: configChanged,
    sources, duplicate_content_groups: [...duplicates.values()].filter((ids) => ids.length > 1),
    limitations: [
      "Fingerprinting does not verify parsing, event coverage, authenticity or derivative validity.",
      "candidate_reuse requires checking prior derivatives and recorded methods before reuse.",
      "missing means absent from the supplied list, not proven deleted from disk.",
      "Duplicate bytes are not independent evidence; overlapping exports with different bytes are not detected.",
      "Configuration changes conservatively reprocess all supplied unchanged sources; record timezone, filters, incident window and parser version in configuration.",
    ],
  };
}

const USAGE = "[-h] [--previous PREVIOUS] [--config CONFIG] files [files ...]";
const HELP = `usage: evidence_inventory.ts ${USAGE}

Read-only source fingerprints and conservative incremental preparation plan.

positional arguments:
  files                Explicit source paths; directories are not traversed

options:
  -h, --help           show this help message and exit
  --previous PREVIOUS  Previous JSON inventory
  --config CONFIG      JSON object containing preparation assumptions and method versions
`;

function loadJson(path: string): PyValue {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch (e) {
    throw new ValueError(e instanceof TypeError ? `'utf-8' codec can't decode ${path}` : osErrorMessage(e, path));
  }
  return loads(text);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const error = (message: string): never => usageError("evidence_inventory.ts", USAGE, message);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      help: { type: "boolean", short: "h" }, previous: { type: "string" }, config: { type: "string" } } });
  } catch (e) {
    return error((e as Error).message);
  }
  if (parsed.values.help) { writeSync(1, HELP); return 0; }
  if (!parsed.positionals.length) return error("the following arguments are required: files");
  let result;
  try {
    const previous = parsed.values.previous ? loadJson(parsed.values.previous) : null;
    const config = parsed.values.config ? loadJson(parsed.values.config) : new Map();
    result = await inventory(parsed.positionals, config, previous);
  } catch (e) {
    return error((e as Error).message);
  }
  writeSync(1, dumps(result as unknown as PyValue, { indent: 2, ensureAscii: true }) + "\n");
  return result.sources.some((s) => s.status === "unreadable" || s.status === "unstable") ? 1 : 0;
}

if (!Bun.isMainThread) {
  // Worker: fingerprint one file per message.
  self.onmessage = (event: MessageEvent<{ index: number; path: string }>) => {
    postMessage({ index: event.data.index, record: inspectFile(event.data.path) });
  };
} else if (import.meta.main) {
  process.exit(await main());
}
