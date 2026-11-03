import { realpathSync, writeSync } from "node:fs";

/**
 * Python-compatibility helpers shared by the RCA scripts.
 *
 * The scripts were ported from Python; their JSON output, whitespace handling and
 * fingerprints must stay byte-compatible with the originals so earlier derivatives
 * and inventories remain comparable.
 */

/** Characters Python's str.isspace() accepts (str.split()/strip() and regex \s). */
export const PY_WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp(`[${PY_WS}]+`);
const WS_EDGES = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");
const LINE_BREAKS = /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/;

/** str.split() with no arguments. */
export function pySplit(text: string): string[] {
  const parts = text.split(WS_RUN);
  if (parts[0] === "") parts.shift();
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** str.strip() with no arguments. */
export function pyStrip(text: string): string {
  return text.replace(WS_EDGES, "");
}

/** str.splitlines(). */
export function pySplitlines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(LINE_BREAKS);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Numeric value of a run of Unicode decimal digits, as Python's int() reads them. */
export function digitsValue(text: string): number {
  let value = 0;
  for (const ch of text) {
    let cp = ch.codePointAt(0)!;
    if (cp >= 48 && cp <= 57) {
      value = value * 10 + (cp - 48);
      continue;
    }
    // Nd digits are encoded in contiguous 0-9 runs; walk back to the run's zero.
    let start = cp;
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
    value = value * 10 + ((cp - start) % 10);
  }
  return value;
}

/** JSON string literal; ensureAscii matches json.dumps(ensure_ascii=True). */
export function jsonString(text: string, ensureAscii = false): string {
  const out = JSON.stringify(text);
  if (!ensureAscii) return out;
  return out.replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** A JSON number kept as Python's json module would load it (int vs float). */
export class PyNum {
  constructor(readonly isFloat: boolean, readonly text: string, readonly value: number) {}
}

export type PyValue = null | boolean | string | number | PyNum | PyValue[] | Map<string, PyValue> | { [key: string]: PyValue };

/** repr(float) as used by json.dumps. */
export function floatRepr(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Out of range float values are not JSON compliant");
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const [mantissa, exp] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const decpt = Number(exp) + 1;
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) return sign + "0." + "0".repeat(-decpt) + digits;
    if (decpt >= digits.length) return sign + digits + "0".repeat(decpt - digits.length) + ".0";
    return sign + digits.slice(0, decpt) + "." + digits.slice(decpt);
  }
  const e = decpt - 1;
  return sign + digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (e < 0 ? "-" : "+") + String(Math.abs(e)).padStart(2, "0");
}

function compareCodePoints(a: string, b: string): number {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

export interface DumpOptions {
  indent?: number;
  sortKeys?: boolean;
  ensureAscii?: boolean;
  separators?: [string, string];
}

/** json.dumps(value, ...) with Python's defaults (ensure_ascii=True, allow_nan=False). */
export function dumps(value: PyValue | undefined, options: DumpOptions = {}): string {
  const ascii = options.ensureAscii ?? true;
  const indent = options.indent;
  const [itemSep, keySep] = options.separators ?? (indent === undefined ? [", ", ": "] : [",", ": "]);
  const write = (v: PyValue | undefined, level: number): string => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "string") return jsonString(v, ascii);
    if (typeof v === "number") return Number.isInteger(v) && !Object.is(v, -0) ? String(v) : floatRepr(v);
    if (v instanceof PyNum) return v.isFloat ? floatRepr(v.value) : v.text;
    const entries: [string | null, PyValue][] = Array.isArray(v)
      ? v.map((x) => [null, x])
      : v instanceof Map ? [...v.entries()] : Object.entries(v);
    const open = Array.isArray(v) ? "[" : "{", close = Array.isArray(v) ? "]" : "}";
    if (!entries.length) return open + close;
    if (options.sortKeys && !Array.isArray(v)) entries.sort((a, b) => compareCodePoints(a[0]!, b[0]!));
    const items = entries.map(([k, x]) => (k === null ? "" : jsonString(k, ascii) + keySep) + write(x, level + 1));
    if (indent === undefined) return open + items.join(itemSep) + close;
    const pad = "\n" + " ".repeat(indent * (level + 1));
    return open + pad + items.join(itemSep + pad) + "\n" + " ".repeat(indent * level) + close;
  };
  return write(value, 0);
}

/**
 * json.loads(text) that keeps Python's int/float distinction and object key order
 * (objects become Maps), so re-serialized fingerprints match the Python original.
 */
export function loads(text: string): PyValue {
  let i = 0;
  const fail = (msg: string): never => {
    const line = text.slice(0, i).split("\n").length;
    const col = i - text.lastIndexOf("\n", i - 1);
    throw new SyntaxError(`${msg}: line ${line} column ${col} (char ${i})`);
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/y;
  const value = (): PyValue => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const map = new Map<string, PyValue>();
      ws();
      if (text[i] === "}") { i++; return map; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("Expecting property name enclosed in double quotes");
        const key = string();
        ws();
        if (text[i++] !== ":") { i--; fail("Expecting ':' delimiter"); }
        map.set(key, value());
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return map; }
        fail("Expecting ',' delimiter");
      }
    }
    if (c === "[") {
      i++;
      const list: PyValue[] = [];
      ws();
      if (text[i] === "]") { i++; return list; }
      for (;;) {
        list.push(value());
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return list; }
        fail("Expecting ',' delimiter");
      }
    }
    if (c === '"') return string();
    for (const [word, v] of [["null", null], ["true", true], ["false", false], ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity]] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return typeof v === "number" ? new PyNum(true, word, v) : v;
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return fail("Expecting value");
    i += m[0].length;
    if (m[1] || m[2]) return new PyNum(true, m[0], Number(m[0]));
    return new PyNum(false, m[0] === "-0" ? "0" : m[0], Number(m[0]));
  };
  const string = (): string => {
    const start = i++;
    let out = "";
    let run = i;
    for (;;) {
      if (i >= text.length) { i = start; fail("Unterminated string starting at"); }
      const code = text.charCodeAt(i);
      if (code === 34) { out += text.slice(run, i++); return out; }
      if (code < 0x20) fail("Invalid control character at");
      if (code !== 92) { i++; continue; }
      out += text.slice(run, i);
      const esc = text[i + 1];
      const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (esc in simple) { out += simple[esc]; i += 2; }
      else if (esc === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; }
      else fail("Invalid \\escape");
      run = i;
    }
  };
  const result = value();
  ws();
  if (i !== text.length) fail("Extra data");
  return result;
}

/** pathlib.Path.resolve() (strict=False): realpath of the longest existing prefix. */
export function pyResolve(path: string): string {
  const absolute = pyAbspath(path);
  const tail: string[] = [];
  for (let head = absolute; ;) {
    try {
      const real = realpathSync(head);
      return [real === "/" ? "" : real, ...tail].join("/") || "/";
    } catch {
      const cut = head.lastIndexOf("/");
      if (cut <= 0) return absolute;
      tail.unshift(head.slice(cut + 1));
      head = head.slice(0, cut) || "/";
    }
  }
}

/** Python's posixpath.abspath(): lexical, keeps a leading "//". */
export function pyAbspath(path: string): string {
  if (!path.startsWith("/")) path = process.cwd() + "/" + path;
  const initial = path.startsWith("//") && !path.startsWith("///") ? 2 : 1;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/".repeat(initial) + parts.join("/");
}

const STRERROR: Record<string, [number, string]> = {
  ENOENT: [2, "No such file or directory"], EIO: [5, "Input/output error"], EBADF: [9, "Bad file descriptor"],
  EACCES: [13, "Permission denied"], EPERM: [1, "Operation not permitted"], EISDIR: [21, "Is a directory"],
  ENOTDIR: [20, "Not a directory"], ELOOP: [62, "Too many levels of symbolic links"],
  ENAMETOOLONG: [63, "File name too long"], EMFILE: [24, "Too many open files"], EPIPE: [32, "Broken pipe"],
};

/** repr(str) for the common cases that appear in OSError messages. */
export function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const body = text.replace(/[\\\n\r\t\x00-\x1f\x7f]/g, (c) =>
    ({ "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" } as Record<string, string>)[c] ?? "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
  return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
}

/** str(OSError) as Python formats it: "[Errno 2] No such file or directory: '/x'". */
export function osErrorMessage(error: unknown, path?: string): string {
  const e = error as { code?: string; errno?: number; message?: string };
  const known = e?.code ? STRERROR[e.code] : undefined;
  if (!known) return e?.message ?? String(error);
  return `[Errno ${known[0]}] ${known[1]}` + (path === undefined ? "" : `: ${pyRepr(path)}`);
}

/** argparse-style usage error: message on stderr, exit status 2. */
export function usageError(prog: string, usage: string, message: string): never {
  writeSync(2, `usage: ${prog} ${usage}\n${prog}: error: ${message}\n`);
  process.exit(2);
}
