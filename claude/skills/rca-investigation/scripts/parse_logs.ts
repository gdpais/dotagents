#!/usr/bin/env bun
/** Stream explicit IIS W3C, CSV or HAProxy HTTP formats as traceable JSONL. */
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { digitsValue, jsonString, pyResolve, pySplit, PY_WS, usageError } from "./_py.ts";

// ---------------------------------------------------------------------------
// Calendar arithmetic (proleptic Gregorian, like Python's datetime)

const MONTHS: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

class InvalidTime extends Error {}

const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const monthDays = (y: number, m: number) => (m === 2 ? (isLeap(y) ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]);

/** Days since 1970-01-01 for a civil date. */
function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}

function civilFromDays(z: number): [number, number, number] {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, doy - Math.floor((153 * mp + 2) / 5) + 1];
}

/** A naive local time: whole seconds since the epoch (as if UTC) plus microseconds. */
interface Parsed {
  seconds: number;
  micro: number;
  /** Explicit UTC offset in microseconds, or null when naive. */
  offset: number | null;
}

/** datetime(...) constructor validation; returns naive epoch seconds. */
function civil(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, us = 0): number {
  if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > monthDays(y, mo) || h > 23 || mi > 59 || s > 59 || us > 999999) throw new InvalidTime();
  return daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s;
}

const DAY_US = 86_400_000_000;
function checkOffset(us: number): number {
  if (us <= -DAY_US || us >= DAY_US) throw new InvalidTime();
  return us;
}

const P2 = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
let lastDays = NaN, lastDayPrefix = "";

/** datetime.isoformat() of a UTC instant; throws like OverflowError outside years 1-9999. */
function isoUtc(seconds: number, micro: number): string {
  const days = Math.floor(seconds / 86400);
  const rem = seconds - days * 86400;
  if (days !== lastDays) {
    const [y, m, d] = civilFromDays(days);
    if (y < 1 || y > 9999) throw new InvalidTime();
    lastDays = days;
    lastDayPrefix = String(y).padStart(4, "0") + "-" + P2[m] + "-" + P2[d] + "T";
  }
  return lastDayPrefix + P2[Math.floor(rem / 3600)] + ":" + P2[Math.floor((rem % 3600) / 60)] + ":" + P2[rem % 60] +
    (micro ? "." + String(micro).padStart(6, "0") : "") + "+00:00";
}

/** Subtract an offset in microseconds from local seconds+micro. */
function toUtc(seconds: number, micro: number, offsetUs: number): string {
  const offS = Math.trunc(offsetUs / 1e6);
  let us = micro - (offsetUs - offS * 1e6);
  let s = seconds - offS;
  if (us < 0) { us += 1e6; s -= 1; } else if (us >= 1e6) { us -= 1e6; s += 1; }
  return isoUtc(s, us);
}

// ---------------------------------------------------------------------------
// datetime.fromisoformat (CPython 3.11+ C implementation, ported literally)

const isDigit = (s: string, i: number) => { const c = s.charCodeAt(i); return c >= 48 && c <= 57; };

function digits(s: string, i: number, n: number): number {
  let v = 0;
  for (let k = 0; k < n; k++) {
    if (!isDigit(s, i + k)) throw new InvalidTime();
    v = v * 10 + s.charCodeAt(i + k) - 48;
  }
  return v;
}

function separatorLocation(s: string): number {
  const len = s.length;
  if (len === 7) return 7;
  if (s[4] === "-") {
    if (s[5] !== "W") return 10;
    if (len < 8) throw new InvalidTime();
    if (len > 8 && s[8] === "-") {
      if (len === 9) throw new InvalidTime();
      return len > 10 && isDigit(s, 10) ? 8 : 10;
    }
    return 8;
  }
  if (s[4] !== "W") return 8;
  let idx = 7;
  while (idx < len && isDigit(s, idx)) idx++;
  if (idx < 9) return idx;
  return idx % 2 === 0 ? 7 : 8;
}

function isoWeekToDays(year: number, week: number, day: number): number {
  if (year < 1 || year > 9999) throw new InvalidTime();
  if (week <= 0 || week >= 53) {
    // Week 53 exists only when the year starts on Thursday, or Wednesday in leap years.
    const jan1 = (daysFromCivil(year, 1, 1) + 3) % 7; // 0 = Monday
    const weekday = ((jan1 % 7) + 7) % 7;
    if (!(week === 53 && (weekday === 3 || (weekday === 2 && isLeap(year))))) throw new InvalidTime();
  }
  if (day <= 0 || day >= 8) throw new InvalidTime();
  const jan4 = daysFromCivil(year, 1, 4);
  const firstMonday = jan4 - ((((jan4 + 3) % 7) + 7) % 7);
  return firstMonday + (week - 1) * 7 + (day - 1);
}

function parseIsoDate(s: string, len: number): [number, number, number] {
  const year = digits(s, 0, 4);
  let p = 4;
  const sep = s[p] === "-";
  if (sep) p++;
  if (s[p] === "W") {
    p++;
    const week = digits(s, p, 2);
    p += 2;
    let day = 1;
    if (p < len) {
      if (sep && s[p++] !== "-") throw new InvalidTime();
      day = digits(s, p, 1);
    }
    const ymd = civilFromDays(isoWeekToDays(year, week, day));
    return ymd;
  }
  const month = digits(s, p, 2);
  p += 2;
  if (sep && s[p++] !== "-") throw new InvalidTime();
  return [year, month, digits(s, p, 2)];
}

/** parse_hh_mm_ss_ff: returns [h, m, s, us, moreInput]; `end` bounds the time part. */
function parseHms(s: string, start: number, end: number): [number, number, number, number, boolean] {
  const vals = [0, 0, 0];
  let p = start;
  let hasSep = true;
  for (let i = 0; i < 3; i++) {
    vals[i] = digits(s, p, 2);
    p += 2;
    const c = s[p++] ?? "";
    if (i === 0) hasSep = c === ":";
    if (p >= end) return [vals[0], vals[1], vals[2], 0, c !== ""];
    if (hasSep && c === ":") continue;
    if (c === "." || c === ",") {
      if (i < 2) throw new InvalidTime();
      break;
    }
    if (!hasSep) p--;
    else throw new InvalidTime();
  }
  const remains = end - p;
  const take = Math.min(remains, 6);
  let us = take ? digits(s, p, take) : 0;
  if (take && take < 6) us *= 10 ** (6 - take);
  p += take;
  while (isDigit(s, p)) p++;
  return [vals[0], vals[1], vals[2], us, p < s.length];
}

function fromIsoFormat(raw: string): Parsed {
  const s = raw.replaceAll("Z", "+00:00");
  const loc = separatorLocation(s);
  const [y, mo, d] = parseIsoDate(s, loc);
  let h = 0, mi = 0, sec = 0, us = 0, offset: number | null = null;
  if (loc < s.length) {
    const cp = s.codePointAt(loc)!;
    const t = loc + (cp > 0xffff ? 2 : 1);
    let tz = t;
    do {
      const c = s[tz];
      if (c === "Z" || c === "+" || c === "-") break;
    } while (++tz < s.length);
    let more: boolean;
    [h, mi, sec, us, more] = parseHms(s, t, tz);
    if (tz === s.length) {
      if (more) throw new InvalidTime();
    } else if (s[tz] === "Z") {
      if (tz + 1 !== s.length) throw new InvalidTime();
      offset = 0;
    } else {
      const sign = s[tz] === "-" ? -1 : 1;
      const [th, tm, ts, tus, tzMore] = parseHms(s, tz + 1, s.length);
      if (tzMore) throw new InvalidTime();
      offset = checkOffset(sign * ((th * 3600 + tm * 60 + ts) * 1e6 + tus));
    }
  }
  return { seconds: civil(y, mo, d, h, mi, sec, us), micro: us, offset };
}

// ---------------------------------------------------------------------------
// datetime.strptime (CPython _strptime, C locale)

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTH_NAMES = ["", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const D = "\\p{Nd}";
const alternatives = (words: string[]) => [...words].filter(Boolean).sort((a, b) => b.length - a.length).join("|");
const DIRECTIVES: Record<string, string> = {
  d: `3[01]|[12]${D}|0[1-9]|[1-9]| [1-9]`,
  f: "[0-9]{1,6}",
  H: `2[0-3]|[0-1]${D}|${D}`,
  I: "1[0-2]|0[1-9]|[1-9]",
  G: `${D}${D}${D}${D}`,
  j: `36[0-6]|3[0-5]${D}|[12]${D}${D}|0[1-9]${D}|00[1-9]|[1-9]${D}|0[1-9]|[1-9]`,
  m: "1[0-2]|0[1-9]|[1-9]",
  M: `[0-5]${D}|${D}`,
  S: `6[0-1]|[0-5]${D}|${D}`,
  U: `5[0-3]|[0-4]${D}|${D}`,
  w: "[0-6]",
  u: "[1-7]",
  V: `5[0-3]|0[1-9]|[1-4]${D}|${D}`,
  y: `${D}${D}`,
  Y: `${D}${D}${D}${D}`,
  z: `[+-]${D}${D}:?[0-5]${D}(?::?[0-5]${D}(?:\\.${D}{1,6})?)?|Z`,
  A: alternatives(WEEKDAYS),
  a: alternatives(WEEKDAYS.map((w) => w.slice(0, 3))),
  B: alternatives(MONTH_NAMES),
  b: alternatives(MONTH_NAMES.map((m) => m.slice(0, 3))),
  p: "am|pm",
  Z: "utc|gmt",
  W: `5[0-3]|[0-4]${D}|${D}`,
};
const COMPOSITE: Record<string, string> = { c: "%a %b %d %H:%M:%S %Y", x: "%m/%d/%y", X: "%H:%M:%S" };

interface Compiled { regex: RegExp; keys: string[] }
const compiledFormats = new Map<string, Compiled | null>();

function compileFormat(format: string): Compiled | null {
  const keys: string[] = [];
  const expand = (fmt: string): string => {
    let out = "";
    fmt = fmt.replace(/[\\.^$*+?(){}[\]|]/g, "\\$&").replace(new RegExp(`[${PY_WS}]+`, "g"), `[${PY_WS}]+`);
    for (;;) {
      const at = fmt.indexOf("%");
      if (at < 0) return out + fmt;
      const directive = fmt[at + 1];
      if (directive === undefined) throw new InvalidTime(); // stray %
      out += fmt.slice(0, at);
      if (directive === "%") out += "%";
      else if (directive in COMPOSITE) out += expand(COMPOSITE[directive]);
      else if (directive in DIRECTIVES) {
        if (keys.includes(directive)) throw new InvalidTime(); // redefinition of group name
        keys.push(directive);
        out += `(${DIRECTIVES[directive]})`;
      } else throw new InvalidTime(); // bad directive
      fmt = fmt.slice(at + 2);
    }
  };
  try {
    return { regex: new RegExp("^(?:" + expand(format) + ")", "iu"), keys };
  } catch (e) {
    if (e instanceof InvalidTime) return null;
    throw e;
  }
}

function strptime(raw: string, format: string): Parsed {
  let compiled = compiledFormats.get(format);
  if (compiled === undefined) compiledFormats.set(format, (compiled = compileFormat(format)));
  if (!compiled) throw new InvalidTime();
  const m = compiled.regex.exec(raw);
  if (!m || m[0].length !== raw.length) throw new InvalidTime();
  const found: Record<string, string> = {};
  compiled.keys.forEach((k, i) => (found[k] = m[i + 1]));
  let year: number | null = null, month = 1, day = 1, hour = 0, minute = 0, second = 0, fraction = 0;
  let gmtoff: number | null = null, isoYear: number | null = null, isoWeek: number | null = null;
  let weekOfYear = -1, weekStart = -1, weekday: number | null = null, julian: number | null = null;
  for (const key of compiled.keys) {
    const v = found[key];
    switch (key) {
      case "y": year = digitsValue(v); year += year <= 68 ? 2000 : 1900; break;
      case "Y": year = digitsValue(v); break;
      case "G": isoYear = digitsValue(v); break;
      case "m": month = digitsValue(v); break;
      case "B": month = MONTH_NAMES.indexOf(v.toLowerCase()); break;
      case "b": month = MONTH_NAMES.findIndex((n) => n && n.slice(0, 3) === v.toLowerCase()); break;
      case "d": day = digitsValue(v.trim()); break;
      case "H": hour = digitsValue(v); break;
      case "I": {
        hour = digitsValue(v);
        const ampm = (found.p ?? "").toLowerCase();
        if (ampm === "" || ampm === "am") { if (hour === 12) hour = 0; }
        else if (hour !== 12) hour += 12;
        break;
      }
      case "M": minute = digitsValue(v); break;
      case "S": second = digitsValue(v); break;
      case "f": fraction = Number(v.padEnd(6, "0")); break;
      case "A": weekday = WEEKDAYS.indexOf(v.toLowerCase()); break;
      case "a": weekday = WEEKDAYS.findIndex((w) => w.slice(0, 3) === v.toLowerCase()); break;
      case "w": weekday = (digitsValue(v) + 6) % 7; break;
      case "u": weekday = digitsValue(v) - 1; break;
      case "j": julian = digitsValue(v); break;
      case "U": case "W": weekOfYear = digitsValue(v); weekStart = key === "U" ? 6 : 0; break;
      case "V": isoWeek = digitsValue(v); break;
      case "z": {
        if (v === "z") throw new InvalidTime(); // Python matches Z case-sensitively
        if (v === "Z") { gmtoff = 0; break; }
        let z = v;
        if (z[3] === ":") {
          z = z.slice(0, 3) + z.slice(4);
          if (z.length > 5) {
            if (z[5] !== ":") throw new InvalidTime();
            z = z.slice(0, 5) + z.slice(6);
          }
        }
        if (!/^\p{Nd}*$/u.test(z.slice(5, 7))) throw new InvalidTime(); // int() of a stray ':'
        const secs = digitsValue(z.slice(1, 3)) * 3600 + digitsValue(z.slice(3, 5)) * 60 + (z.length > 5 ? digitsValue(z.slice(5, 7)) : 0);
        const frac = z.length > 8 ? digitsValue(z.slice(8).padEnd(6, "0")) : 0;
        gmtoff = (z[0] === "-" ? -1 : 1) * (secs * 1e6 + frac);
        break;
      }
    }
  }
  if (year === null && isoYear !== null) {
    if (isoWeek === null || weekday === null || julian !== null) throw new InvalidTime();
  } else if (weekOfYear === -1 && isoWeek !== null) throw new InvalidTime();
  let leapFix = false;
  if (year === null && month === 2 && day === 29) { year = 1904; leapFix = true; }
  else if (year === null) year = 1900;
  const ordinal = (y: number, mo: number, d: number) => { civil(y, mo, d); return daysFromCivil(y, mo, d); };
  if (julian === null && weekday !== null) {
    if (weekOfYear !== -1) {
      let first = (((ordinal(year, 1, 1) + 3) % 7) + 7) % 7;
      let dow = weekday;
      if (weekStart !== 0) { first = (first + 1) % 7; dow = (dow + 1) % 7; }
      julian = weekOfYear === 0 ? 1 + dow - first : 1 + (7 - first) % 7 + 7 * (weekOfYear - 1) + dow;
    } else if (isoYear !== null && isoWeek !== null) {
      const correction = ((((ordinal(isoYear, 1, 4) + 3) % 7) + 7) % 7) + 1 + 3;
      julian = isoWeek * 7 + weekday + 1 - correction;
      year = isoYear;
      if (julian < 1) {
        julian += ordinal(year, 1, 1);
        year -= 1;
        julian -= ordinal(year, 1, 1);
      }
    }
    if (julian !== null && julian <= 0) {
      year -= 1;
      julian += isLeap(year) ? 366 : 365;
    }
  }
  if (julian !== null) [year, month, day] = civilFromDays(julian - 1 + ordinal(year, 1, 1));
  else ordinal(year, month, day);
  if (leapFix) year = 1900;
  return { seconds: civil(year, month, day, hour, minute, second, fraction), micro: fraction, offset: gmtoff === null ? null : checkOffset(gmtoff) };
}

// ---------------------------------------------------------------------------
// IANA zones via Intl, with the same fold/gap detection as the zoneinfo original

class Zone {
  private readonly format: Intl.DateTimeFormat;
  private readonly hours = new Map<number, number>();

  constructor(name: string) {
    this.format = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone: name, hourCycle: "h23", era: "short",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
  }

  private exactOffset(t: number): number {
    const f: Record<string, string> = {};
    for (const part of this.format.formatToParts(new Date(t * 1000))) f[part.type] = part.value;
    const year = f.era === "BC" || f.era === "B" ? 1 - Number(f.year) : Number(f.year);
    return daysFromCivil(year, Number(f.month), Number(f.day)) * 86400 + Number(f.hour) * 3600 + Number(f.minute) * 60 + Number(f.second) - t;
  }

  /** UTC offset in seconds at UTC instant t; cached per UTC hour without a transition. */
  offset(t: number): number {
    const hour = Math.floor(t / 3600);
    let cached = this.hours.get(hour);
    if (cached === undefined) {
      const start = this.exactOffset(hour * 3600);
      cached = start === this.exactOffset(hour * 3600 + 3599) ? start : NaN;
      this.hours.set(hour, cached);
    }
    return Number.isNaN(cached) ? this.exactOffset(t) : cached;
  }

  /** Candidate UTC instants (seconds) for a naive local time. */
  candidates(local: number): Set<number> {
    const found = new Set<number>();
    for (const probe of [local - 86400, local, local + 86400]) {
      const guess = this.offset(probe);
      if (this.offset(local - guess) === guess) found.add(local - guess);
    }
    return found;
  }
}

const zones = new Map<string, Zone>();

export function validTimezone(name: string): boolean {
  if (!name || /^[+-]/.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const HAP_TIME_ASCII = /^([0-9]{2})\/([A-Za-z]{3})\/([0-9]{4}):([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?$/;

function parseHaproxyTime(raw: string): Parsed {
  const a = HAP_TIME_ASCII.exec(raw);
  if (a) {
    const month = MONTHS[a[2]];
    if (!month) throw new InvalidTime();
    const micro = a[7] ? Number(a[7].padEnd(6, "0")) : 0;
    return { seconds: civil(+a[3], month, +a[1], +a[4], +a[5], +a[6], micro), micro, offset: null };
  }
  const m = /^(\p{Nd}{2})\/([A-Za-z]{3})\/(\p{Nd}{4}):(\p{Nd}{2}):(\p{Nd}{2}):(\p{Nd}{2})(\.\p{Nd}{1,6})?$/u.exec(raw);
  if (!m) throw new InvalidTime();
  const month = MONTHS[m[2]];
  if (!month) throw new InvalidTime();
  const micro = digitsValue((m[7] ?? ".0").slice(1).padEnd(6, "0"));
  return { seconds: civil(digitsValue(m[3]), month, digitsValue(m[1]), digitsValue(m[4]), digitsValue(m[5]), digitsValue(m[6]), micro), micro, offset: null };
}

/** Return UTC only with explicit offset or caller-established zone; detect DST. */
export function normalize(raw: string, fmt?: string | null, timezone?: string | null, haproxy = false): [string | null, string] {
  try {
    const value = haproxy ? parseHaproxyTime(raw) : fmt ? strptime(raw, fmt) : fromIsoFormat(raw);
    if (value.offset !== null) return [toUtc(value.seconds, value.micro, value.offset), "explicit_offset"];
    if (!timezone) return [null, "timezone_unknown"];
    let zone = zones.get(timezone);
    if (!zone) zones.set(timezone, (zone = new Zone(timezone)));
    const candidates = zone.candidates(value.seconds);
    if (candidates.size === 0) return [null, "nonexistent_local_time"];
    if (candidates.size !== 1) return [null, "ambiguous_local_time"];
    const [utc] = candidates;
    return [isoUtc(utc, value.micro), "declared_timezone"];
  } catch (e) {
    if (e instanceof InvalidTime) return [null, "timestamp_invalid"];
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Input

/** Physical lines with terminators, split like Python's open(newline=''): \n, \r\n or \r. */
export function* physicalLines(chunks: Iterable<string>): Generator<string> {
  let parts: string[] = [];
  let pendingCR = false;
  for (const text of chunks) {
    const n = text.length;
    if (!n) continue;
    let pos = 0;
    if (pendingCR) {
      pendingCR = false;
      if (text.charCodeAt(0) === 10) { parts.push("\n"); pos = 1; }
      yield parts.join("");
      parts = [];
    }
    let nl = text.indexOf("\n", pos), cr = text.indexOf("\r", pos);
    while (pos < n) {
      if (nl !== -1 && nl < pos) nl = text.indexOf("\n", pos);
      if (cr !== -1 && cr < pos) cr = text.indexOf("\r", pos);
      let end: number;
      if (cr !== -1 && (nl === -1 || cr < nl)) {
        if (cr + 1 === n) { parts.push(text.slice(pos)); pendingCR = true; break; }
        end = text.charCodeAt(cr + 1) === 10 ? cr + 2 : cr + 1;
      } else if (nl !== -1) end = nl + 1;
      else { parts.push(text.slice(pos)); break; }
      const piece = text.slice(pos, end);
      if (parts.length) { parts.push(piece); yield parts.join(""); parts = []; }
      else yield piece;
      pos = end;
    }
  }
  if (parts.length) yield parts.join("");
}

class CsvError extends Error {}
const FIELD_LIMIT = 131072; // csv.field_size_limit() default

/** csv.reader(strict=True) over physical lines, exposing line_num. */
class CsvReader {
  lineNum = 0;
  private readonly lines: Iterator<string>;
  constructor(lines: Iterable<string>, private readonly delimiter: string) {
    this.lines = lines[Symbol.iterator]();
  }

  next(): string[] | null {
    const delim = this.delimiter.charCodeAt(0);
    const fields: string[] = [];
    let field = "";
    let fieldLen = 0;
    // 0 START_RECORD, 1 START_FIELD, 2 IN_FIELD, 3 IN_QUOTED_FIELD, 4 QUOTE_IN_QUOTED_FIELD, 5 EAT_CRNL
    let state = 0;
    let run = -1; // start of a pending slice of plain characters in `line`
    let line = "";
    const flush = (i: number) => { if (run >= 0) { field += line.slice(run, i); run = -1; } };
    const save = (i: number) => { flush(i); fields.push(field); field = ""; fieldLen = 0; };
    const add = (i: number, c: number) => {
      if (fieldLen >= FIELD_LIMIT) throw new CsvError(`field larger than field limit (${FIELD_LIMIT})`);
      if (c < 0xdc00 || c > 0xdfff) fieldLen++;
      if (run < 0) run = i;
    };
    do {
      const result = this.lines.next();
      if (result.done) {
        if (fieldLen !== 0 || state === 3) throw new CsvError("unexpected end of data");
        return null;
      }
      line = result.value;
      this.lineNum++;
      const n = line.length;
      for (let i = 0; i <= n; i++) {
        const eol = i === n;
        const c = eol ? -1 : line.charCodeAt(i);
        const crnl = c === 10 || c === 13;
        switch (state) {
          case 0:
            if (eol) { state = 0; continue; }
            if (crnl) { state = 5; continue; }
            state = 1;
          // falls through
          case 1:
            if (eol || crnl) { save(i); state = eol ? 0 : 5; }
            else if (c === 34) state = 3;
            else if (c === delim) save(i);
            else { add(i, c); state = 2; }
            break;
          case 2:
            if (eol || crnl) { save(i); state = eol ? 0 : 5; }
            else if (c === delim) { save(i); state = 1; }
            else add(i, c);
            break;
          case 3:
            if (eol) break;
            if (c === 34) { flush(i); state = 4; }
            else add(i, c);
            break;
          case 4:
            if (c === 34) { add(i, c); state = 3; }
            else if (c === delim) { save(i); state = 1; }
            else if (eol || crnl) { save(i); state = eol ? 0 : 5; }
            else throw new CsvError(`'${this.delimiter}' expected after '"'`);
            break;
          case 5:
            if (crnl) break;
            if (eol) state = 0;
            else throw new CsvError("new-line character seen in unquoted field");
            break;
        }
      }
      flush(n);
    } while (state !== 0);
    return fields;
  }
}

export interface Args {
  format: "iis" | "csv" | "haproxy";
  delimiter: string;
  timestamp_column?: string;
  haproxy_timing?: "legacy" | "modern";
}

/** start/end physical line, fields (ordered key/value pairs), raw timestamp, error. */
export type RecordTuple = [number, number, [string, unknown][] | null, string | null, string | null];

const NS = `[^${PY_WS}]`;
const NUM = "\\p{Nd}";
const TIMER = `[+${NUM}-]+`;
const HAP = new RegExp(`(${NS}+) \\[([^\\]]+)\\] (${NS}+) (${NS}+) (${TIMER}/${TIMER}/${TIMER}/${TIMER}/${TIMER}) (${NUM}{3}) (\\+?${NUM}+) ([^\\n]*)$`, "u");
const TIMERS = { legacy: ["Tq", "Tw", "Tc", "Tr", "Tt"], modern: ["TR", "Tw", "Tc", "Tr", "Ta"] };

/** Yield start/end physical lines, fields, timestamp or bounded error code. */
export function* records(chunks: Iterable<string>, args: Args): Generator<RecordTuple> {
  const lines = physicalLines(chunks);
  if (args.format === "csv") {
    const reader = new CsvReader(lines, args.delimiter);
    const header = reader.next();
    if (header === null) return;
    if (new Set(header).size !== header.length || !header.includes(args.timestamp_column!)) {
      yield [1, reader.lineNum, null, null, "invalid_csv_header"];
      return;
    }
    const column = header.indexOf(args.timestamp_column!);
    let previous = reader.lineNum;
    try {
      for (;;) {
        const row = reader.next();
        if (row === null) return;
        const start = previous + 1, end = reader.lineNum;
        previous = end;
        if (!row.length) continue;
        if (row.length !== header.length) {
          yield [start, end, null, null, "column_count_mismatch"];
          continue;
        }
        yield [start, end, header.map((h, i) => [h, row[i]]), row[column], null];
      }
    } catch (e) {
      if (!(e instanceof CsvError)) throw e;
      yield [previous + 1, reader.lineNum, null, null, "malformed_csv"];
    }
    return;
  }
  let header: string[] | null = null;
  let dateAt = 0, timeAt = 0;
  let number = 0;
  const names = TIMERS[args.haproxy_timing ?? "modern"];
  for (let line of lines) {
    number++;
    let end = line.length;
    while (end && (line.charCodeAt(end - 1) === 10 || line.charCodeAt(end - 1) === 13)) end--;
    if (!end) continue;
    if (end !== line.length) line = line.slice(0, end);
    if (args.format === "iis") {
      if (line.startsWith("#Fields:")) {
        header = pySplit(line.slice(8));
        if (new Set(header).size !== header.length || !header.includes("date") || !header.includes("time")) {
          header = null;
          yield [number, number, null, null, "invalid_iis_header"];
        } else {
          dateAt = header.indexOf("date");
          timeAt = header.indexOf("time");
        }
        continue;
      }
      if (line.startsWith("#")) continue;
      if (header === null) {
        yield [number, number, null, null, "missing_iis_header"];
        continue;
      }
      const values = pySplit(line);
      if (values.length !== header.length) {
        yield [number, number, null, null, "column_count_mismatch"];
        continue;
      }
      const fields = header.map((h, i) => [h, values[i]] as [string, unknown]);
      yield [number, number, fields, values[dateAt] + "T" + values[timeAt], null];
    } else {
      const m = HAP.exec(line);
      if (!m) {
        yield [number, number, null, null, "unsupported_haproxy_line"];
        continue;
      }
      const timings = m[5].split("/");
      yield [number, number, [
        ["client", m[1]], ["frontend", m[3]], ["backend", m[4]], ["status", m[6]], ["bytes", m[7]], ["rest", m[8]],
        ["timings_ms_raw", names.map((n, i) => [n, timings[i]])], ["timing_mode", args.haproxy_timing],
      ], m[2], null];
    }
  }
}

// ---------------------------------------------------------------------------
// Output

class ReadFailure extends Error {}

/** Python codec names -> decoder factory. Unknown names raise LookupError in Python. */
function decoderFor(encoding: string): (bytes: Uint8Array, stream: boolean) => string {
  const name = encoding.toLowerCase().replace(/[-_ ]/g, "");
  const fatal = (label: string, ignoreBOM: boolean) => {
    const d = new TextDecoder(label, { fatal: true, ignoreBOM });
    return (b: Uint8Array, stream: boolean) => {
      try {
        return d.decode(b, { stream });
      } catch {
        throw new ReadFailure(); // UnicodeDecodeError: never replace evidence bytes
      }
    };
  };
  if (name === "utf8sig") return fatal("utf-8", false);
  if (["utf8", "u8", "utf", "cp65001"].includes(name)) return fatal("utf-8", true);
  if (["latin1", "iso88591", "l1", "8859", "cp819", "latin"].includes(name)) {
    return (b) => { let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };
  }
  if (["ascii", "usascii", "646"].includes(name)) {
    const d = fatal("utf-8", true);
    return (b, stream) => { if (b.some((x) => x > 0x7f)) throw new ReadFailure(); return d(b, stream); };
  }
  if (name === "utf16") {
    let inner: ((b: Uint8Array, s: boolean) => string) | null = null;
    return (b, stream) => {
      if (!inner) inner = fatal(b[0] === 0xfe && b[1] === 0xff ? "utf-16be" : "utf-16le", false);
      return inner(b, stream);
    };
  }
  if (name === "utf16le") return fatal("utf-16le", true);
  if (name === "utf16be") return fatal("utf-16be", true);
  if (name === "cp1252" || name === "windows1252") {
    const d = fatal("windows-1252", true);
    return (b, stream) => { if (b.some((x) => x === 0x81 || x === 0x8d || x === 0x8f || x === 0x90 || x === 0x9d)) throw new ReadFailure(); return d(b, stream); };
  }
  try {
    return fatal(encoding, true);
  } catch {
    throw new ReadFailure();
  }
}

function* readText(path: string, encoding: string): Generator<string> {
  const decode = decoderFor(encoding);
  const fd = openSync(path, "r");
  try {
    const buffer = new Uint8Array(1 << 20);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      yield decode(buffer.subarray(0, n), true);
    }
    const tail = decode(new Uint8Array(0), false);
    if (tail) yield tail;
  } finally {
    closeSync(fd);
  }
}

/** Buffered writer for a file descriptor: records are UTF-8 encoded into one reusable buffer. */
class Output {
  private readonly buffer = new Uint8Array(4 << 20);
  private used = 0;
  private readonly encoder = new TextEncoder();
  constructor(private readonly fd: number) {}
  write(text: string) {
    if (text.length * 3 > this.buffer.length - this.used) {
      this.flush();
      if (text.length * 3 > this.buffer.length) return this.writeAll(Buffer.from(text));
    }
    this.used += this.encoder.encodeInto(text, this.buffer.subarray(this.used)).written;
  }
  flush() {
    this.writeAll(this.buffer.subarray(0, this.used));
    this.used = 0;
  }
  private writeAll(bytes: Uint8Array) {
    for (let off = 0; off < bytes.length;) {
      try {
        off += writeSync(this.fd, bytes, off);
      } catch (e) {
        if ((e as { code?: string }).code !== "EAGAIN") throw e;
        Bun.sleepSync(1);
      }
    }
  }
}

/** JSON.stringify for strings, skipping the escaper when nothing needs escaping. */
function quote(v: string): string {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 32 || c === 34 || c === 92) return JSON.stringify(v);
  }
  return '"' + v + '"';
}

const keyJson = new Map<string, string>();
function fieldsJson(fields: [string, unknown][]): string {
  let out = "{";
  for (let i = 0; i < fields.length; i++) {
    const [k, v] = fields[i];
    let key = keyJson.get(k);
    if (key === undefined) keyJson.set(k, (key = quote(k) + ": "));
    out += (i ? ", " : "") + key + (typeof v === "string" ? quote(v) : fieldsJson(v as [string, unknown][]));
  }
  return out + "}";
}

const USAGE = "[-h] --source-id SOURCE_ID --format {iis,csv,haproxy} [--timezone TIMEZONE] [--timestamp-format TIMESTAMP_FORMAT] [--timestamp-column TIMESTAMP_COLUMN] [--delimiter DELIMITER] [--haproxy-timing {legacy,modern}] [--encoding ENCODING] source";
const HELP = `usage: parse_logs.ts ${USAGE}

Stream explicit IIS W3C, CSV or HAProxy HTTP formats as traceable JSONL.

positional arguments:
  source

options:
  -h, --help            show this help message and exit
  --source-id SOURCE_ID
  --format {iis,csv,haproxy}
  --timezone TIMEZONE   Verified IANA timezone, e.g. UTC or Europe/Lisbon; never inferred
  --timestamp-format TIMESTAMP_FORMAT
                        CSV strptime format; default ISO 8601
  --timestamp-column TIMESTAMP_COLUMN
                        Exact CSV column name; no vendor schema inferred
  --delimiter DELIMITER
  --haproxy-timing {legacy,modern}
                        Required for HAProxy; establish from log-format configuration
  --encoding ENCODING
`;

export function main(argv = process.argv.slice(2)): number {
  const error = (message: string): never => usageError("parse_logs.ts", USAGE, message);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        help: { type: "boolean", short: "h" }, "source-id": { type: "string" }, format: { type: "string" },
        timezone: { type: "string" }, "timestamp-format": { type: "string" }, "timestamp-column": { type: "string" },
        delimiter: { type: "string", default: "," }, "haproxy-timing": { type: "string" }, encoding: { type: "string", default: "utf-8-sig" },
      },
    });
  } catch (e) {
    return error((e as Error).message);
  }
  const o = parsed.values;
  if (o.help) { writeSync(1, HELP); return 0; }
  if (parsed.positionals.length !== 1) return error(parsed.positionals.length ? `unrecognized arguments: ${parsed.positionals.slice(1).join(" ")}` : "the following arguments are required: source");
  if (o["source-id"] === undefined) return error("the following arguments are required: --source-id");
  if (!["iis", "csv", "haproxy"].includes(o.format ?? "")) return error(o.format === undefined ? "the following arguments are required: --format" : `argument --format: invalid choice: '${o.format}' (choose from 'iis', 'csv', 'haproxy')`);
  if (o["haproxy-timing"] !== undefined && !["legacy", "modern"].includes(o["haproxy-timing"])) return error(`argument --haproxy-timing: invalid choice: '${o["haproxy-timing"]}' (choose from 'legacy', 'modern')`);
  const args: Args = { format: o.format as Args["format"], delimiter: o.delimiter!, timestamp_column: o["timestamp-column"], haproxy_timing: o["haproxy-timing"] as Args["haproxy_timing"] };
  if (args.format === "csv" && !args.timestamp_column) return error("CSV requires --timestamp-column");
  if (args.format === "haproxy" && !args.haproxy_timing) return error("HAProxy requires --haproxy-timing");
  if ([...args.delimiter].length !== 1) return error("delimiter must be one character");
  const timezone = o.timezone ?? null;
  if (timezone && !validTimezone(timezone)) return error("timezone is unavailable or invalid");

  const sourceId = o["source-id"]!;
  const source = parsed.positionals[0];
  const fmt = args.format === "csv" ? o["timestamp-format"] ?? null : null;
  const haproxy = args.format === "haproxy";
  const out = new Output(1);
  const err = new Output(2);
  const counts = new Map<string, number>();
  const errors = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const sid = jsonString(sourceId, true);
  const resolved = pyResolve(source);
  const prefix = `{"source_id": ${jsonString(sourceId)}, "source": ${JSON.stringify(resolved)}, "line_start": `;
  const tz = timezone === null ? "null" : JSON.stringify(timezone);
  let lastRaw: string | null = null;
  let lastTime: [string | null, string] = [null, ""];
  try {
    for (const [start, end, fields, raw, reason] of records(readText(source, o.encoding!), args)) {
      bump(counts, "records_seen");
      if (reason) {
        bump(errors, reason);
        err.write(`{"event": "rejected", "source_id": ${sid}, "line_start": ${start}, "line_end": ${end}, "reason": "${reason}"}\n`);
        continue;
      }
      if (raw !== lastRaw) {
        lastTime = normalize(raw!, fmt, timezone, haproxy);
        lastRaw = raw;
      }
      const [utc, status] = lastTime;
      bump(counts, "emitted");
      bump(counts, status);
      out.write(prefix + start + ', "line_end": ' + end + ', "timestamp_raw": ' + quote(raw!) + ', "timestamp_utc": ' +
        (utc === null ? "null" : '"' + utc + '"') + ', "time_status": "' + status + '", "declared_timezone": ' + tz +
        ', "fields": ' + fieldsJson(fields!) + "}\n");
    }
    out.flush();
  } catch (e) {
    // OSError, UnicodeError, LookupError and csv.Error in the original.
    if (!(e instanceof ReadFailure || e instanceof CsvError || (e instanceof Error && "code" in e))) throw e;
    bump(errors, "source_read_failed");
  }
  const get = (k: string) => counts.get(k) ?? 0;
  const normalized = get("explicit_offset") + get("declared_timezone");
  const obj = (m: Map<string, number>) => "{" + [...m].map(([k, v]) => `"${k}": ${v}`).join(", ") + "}";
  err.write(`{"event": "summary", "source_id": ${sid}, "counts": ${obj(counts)}, "errors": ${obj(errors)}, "extraction_complete": ${errors.size === 0}, "emitted_records_time_complete": ${normalized === get("emitted")}, "emitted_records_with_utc": ${normalized}}\n`);
  err.flush();
  return errors.size ? 2 : 0;
}

if (import.meta.main) process.exit(main());
