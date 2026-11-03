#!/usr/bin/env bun
/** Read-only capture metadata inspection. No conversion or live capture. */
import { statSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import { digitsValue, dumps, osErrorMessage, pyRepr, pyResolve, pySplitlines, pyStrip, usageError, type PyValue } from "./_py.ts";

export interface Completed { exitCode: number; stdout: string; stderr: string }
export type Runner = (args: string[], timeoutSeconds: number) => Completed;

export class TimeoutExpired extends Error {
  constructor(args: string[], timeout: number) {
    super(`Command '[${args.map(pyRepr).join(", ")}]' timed out after ${timeout} seconds`);
  }
}

/** subprocess.run(capture_output=True, text=True, errors="replace", timeout=..., env=LC_ALL=C); never a shell. */
export const run: Runner = (args, timeoutSeconds) => {
  let proc;
  try {
    proc = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: timeoutSeconds * 1000, env: { ...process.env, LC_ALL: "C" } });
  } catch (e) {
    throw new Error(osErrorMessage(e, args[0]));
  }
  if (proc.exitedDueToTimeout) throw new TimeoutExpired(args, timeoutSeconds);
  const text = (b?: Uint8Array) => new TextDecoder().decode(b ?? new Uint8Array());
  const signal = proc.signalCode ? constants.signals[proc.signalCode as keyof typeof constants.signals] : 1;
  return { exitCode: proc.exitCode ?? -signal, stdout: text(proc.stdout), stderr: text(proc.stderr) };
};

const truncate = (text: string, n: number) => (text.length > n ? [...text].slice(0, n).join("") : text);

/** float(raw) for plain decimal/exponent literals; anything else is not a usable epoch. */
function pyFloat(raw: string): number {
  const text = pyStrip(raw);
  if (!/^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/.test(text)) return NaN;
  return Number(text.replaceAll("_", ""));
}

/** int(raw) as Python reads a decimal string; null when it would raise ValueError. */
function pyInt(raw: string): number | null {
  const m = /^([+-]?)(\p{Nd}(?:_?\p{Nd})*)$/u.exec(pyStrip(raw));
  return m ? (m[1] === "-" ? -1 : 1) * digitsValue(m[2].replaceAll("_", "")) : null;
}

export function inspectCapture(input: string, timeout = 60, deps: { which?: (cmd: string) => string | null; run?: Runner } = {}) {
  const which = deps.which ?? ((cmd: string) => Bun.which(cmd));
  const runner = deps.run ?? run;
  const path = pyResolve(input);
  const result: Record<string, PyValue> = {
    source: path, status: "not inspected", packet_count: null, first_epoch: null, last_epoch: null, tool: null,
    limitations: ["Observed endpoints do not establish continuous coverage.",
      "Metadata does not establish HTTP visibility, request identity, or cause."],
  };
  let isFile = false;
  try { isFile = statSync(path).isFile(); } catch { /* not readable */ }
  if (!isFile) {
    result.reason = "Input is not a readable regular file.";
    return result;
  }
  if (extname(path).toLowerCase() === ".etl") {
    result.reason = "ETL is unsupported; obtain a packet-bearing PCAP/PCAPNG export and inspect it. ETL metadata alone does not prove packets exist.";
    return result;
  }
  const tool = which("capinfos");
  if (!tool) {
    result.reason = "capinfos is unavailable; capture has not been validated.";
    return result;
  }
  const args = [tool, "-c", "-a", "-e", "-S", "-M", "-K", "-P", path];
  result.tool = "capinfos";
  result.command = args;
  let completed: Completed;
  try {
    completed = runner(args, timeout);
  } catch (e) {
    result.reason = "Inspection failed: " + (e as Error).message;
    return result;
  }
  result.exit_code = completed.exitCode;
  const stderr = pyStrip(completed.stderr);
  if (completed.exitCode) {
    result.status = "unusable";
    result.reason = "Reader failed; no successful full-file validation. " + truncate(stderr, 2000);
    return result;
  }
  const fields = new Map<string, string>();
  for (const line of pySplitlines(completed.stdout)) {
    const at = line.indexOf(":");
    if (at >= 0) fields.set(pyStrip(line.slice(0, at)), pyStrip(line.slice(at + 1)));
  }
  const count = fields.has("Number of packets") ? pyInt(fields.get("Number of packets")!) : null;
  if (count === null || count < 0) {
    result.reason = "Unrecognized capinfos packet count; validation is incomplete.";
    return result;
  }
  result.packet_count = count;
  if (count === 0) {
    result.status = "unusable";
    result.reason = "Zero packets; cannot support packet analysis.";
    return result;
  }
  for (const [source, legacy, target] of [["Earliest packet time", "First packet time", "first_epoch"], ["Latest packet time", "Last packet time", "last_epoch"]]) {
    const raw = fields.get(source) ?? fields.get(legacy) ?? "";
    if (Number.isFinite(pyFloat(raw))) result[target] = raw;
  }
  result.status = "usable";
  result.reason = "Reader successfully scanned packet records; usable for further packet inspection.";
  const first = result.first_epoch as string | null, last = result.last_epoch as string | null;
  if (first === null || last === null || pyFloat(first) > pyFloat(last)) {
    result.status = "partial";
    result.reason = "Packets exist, but a valid observed timestamp range could not be established.";
  }
  if (stderr) {
    result.reader_warning = truncate(stderr, 2000);
    result.status = "partial";
    result.reason = "Reader completed with warnings; inspect warnings before relying on coverage.";
  }
  return result;
}

const USAGE = "[-h] [--timeout TIMEOUT] input";
const HELP = `usage: inspect_capture.ts ${USAGE}

Read-only capture metadata inspection. No conversion or live capture.

positional arguments:
  input              One supplied capture file

options:
  -h, --help         show this help message and exit
  --timeout TIMEOUT  Reader timeout in seconds (1–600)
`;

export function main(argv = process.argv.slice(2)): number {
  const error = (message: string): never => usageError("inspect_capture.ts", USAGE, message);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: "boolean", short: "h" }, timeout: { type: "string", default: "60" } } });
  } catch (e) {
    return error((e as Error).message);
  }
  if (parsed.values.help) { writeSync(1, HELP); return 0; }
  if (parsed.positionals.length !== 1) return error(parsed.positionals.length ? `unrecognized arguments: ${parsed.positionals.slice(1).join(" ")}` : "the following arguments are required: input");
  const timeout = pyInt(parsed.values.timeout!);
  if (timeout === null) return error(`argument --timeout: invalid int value: '${parsed.values.timeout}'`);
  if (timeout < 1 || timeout > 600) return error("--timeout must be between 1 and 600");
  const result = inspectCapture(parsed.positionals[0], timeout);
  writeSync(1, dumps(result, { indent: 2 }) + "\n");
  return result.status === "usable" || result.status === "partial" ? 0 : 2;
}

if (import.meta.main) process.exit(main());
