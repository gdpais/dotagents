import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize, records, type Args } from "../scripts/parse_logs.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "parse_logs.ts");

const args = (overrides: Partial<Args> = {}): Args => ({ format: "iis", delimiter: ",", timestamp_column: "when", haproxy_timing: "modern", ...overrides });
const rows = (text: string, a: Args) => [...records([text], a)];
const fields = (row: ReturnType<typeof rows>[number]) => Object.fromEntries(row[2]!) as Record<string, any>;

function cli(...argv: string[]) {
  const proc = Bun.spawnSync([process.execPath, SCRIPT, ...argv]);
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("records", () => {
  test("IIS changed headers and bad rows", () => {
    const r = rows("#Fields: date time sc-status\n2026-09-16 12:00:00 200\n#Fields: sc-status time date\n503 12:01:00 2026-09-16\nbad\n", args());
    expect(fields(r[1])["sc-status"]).toBe("503");
    expect(r[1][0]).toBe(4);
    expect(r[2][4]).toBe("column_count_mismatch");
  });

  test("CSV multiline provenance", () => {
    const r = rows('when,message\n2026-09-16T10:00:00Z,"hello\nworld"\n', args({ format: "csv" }));
    expect(r[0].slice(0, 2)).toEqual([2, 3]);
    expect(fields(r[0]).message).toBe("hello\nworld");
  });

  test("CSV duplicate header rejected", () => {
    expect(rows("when,when\na,b\n", args({ format: "csv" }))[0][4]).toBe("invalid_csv_header");
  });

  test("CR-only and CRLF line endings count as physical lines", () => {
    const r = rows("#Fields: date time\r2026-09-16 12:00:00\r\n\r2026-09-16 12:00:01", args());
    expect(r.map((x) => x[0])).toEqual([2, 4]);
  });

  test("lines split across input chunks", () => {
    const text = "when,msg\r\n2026-09-16T10:00:00,\"a\r\nb\"\r\n2026-09-16T10:00:01,c\r\n";
    const whole = [...records([text], args({ format: "csv" }))];
    for (let i = 1; i < text.length; i++) {
      expect([...records([text.slice(0, i), text.slice(i)], args({ format: "csv" }))]).toEqual(whole);
    }
  });

  test("HAProxy timing modes and raw sentinels", () => {
    const line = 'syslog prefix haproxy[4]: 10.0.0.1:123 [16/Sep/2026:10:00:00.123] fe be/srv 0/1/-1/-1/+20 503 0 - - SC-- 1/1/1/1/0 0/0 "GET / HTTP/1.1"\n';
    for (const [mode, first, last] of [["legacy", "Tq", "Tt"], ["modern", "TR", "Ta"]] as const) {
      const row = rows(line, args({ format: "haproxy", haproxy_timing: mode }))[0];
      const timings = Object.fromEntries(fields(row).timings_ms_raw);
      expect(timings[last]).toBe("+20");
      expect(timings[first]).toBe("0");
      expect(timings.Tc).toBe("-1");
      expect(normalize(row[3]!, null, "UTC", true)[0]).toBe("2026-09-16T10:00:00.123000+00:00");
    }
  });
});

describe("normalize", () => {
  test("time uncertainty", () => {
    expect(normalize("2026-09-16T10:00:00")[1]).toBe("timezone_unknown");
    expect(normalize("2026-10-25T01:30:00", null, "Europe/Lisbon")[1]).toBe("ambiguous_local_time");
    expect(normalize("2026-03-29T01:30:00", null, "Europe/Lisbon")[1]).toBe("nonexistent_local_time");
    expect(normalize("2026-09-16T10:00:00", null, "Europe/Lisbon")[0]).toBe("2026-09-16T09:00:00+00:00");
    expect(normalize("2026-09-16T10:00:00+02:00")[0]).toBe("2026-09-16T08:00:00+00:00");
  });

  test("ISO 8601 forms accepted by Python 3.11+ fromisoformat", () => {
    expect(normalize("2026-09-16T10:00:00.1234567Z")[0]).toBe("2026-09-16T10:00:00.123456+00:00");
    expect(normalize("20260916T100000+0530")[0]).toBe("2026-09-16T04:30:00+00:00");
    expect(normalize("2026-W38-3", null, "UTC")[0]).toBe("2026-09-16T00:00:00+00:00");
    expect(normalize("2026-02-29T10:00:00")[1]).toBe("timestamp_invalid");
    expect(normalize("0001-01-01T00:00:00+01:00")[1]).toBe("timestamp_invalid"); // OverflowError
  });

  test("strptime formats", () => {
    expect(normalize("16/09/2026 10:00:00", "%d/%m/%Y %H:%M:%S", "Europe/Lisbon")[0]).toBe("2026-09-16T09:00:00+00:00");
    expect(normalize("Sep 16 2026 12:30 AM", "%b %d %Y %I:%M %p", "UTC")[0]).toBe("2026-09-16T00:30:00+00:00");
    expect(normalize("2026-09-16 10:00:00.5-05:30", "%Y-%m-%d %H:%M:%S.%f%z")[0]).toBe("2026-09-16T15:30:00.500000+00:00");
    expect(normalize("2026 38 3", "%G %V %u", "UTC")[0]).toBe("2026-09-16T00:00:00+00:00");
    expect(normalize("2026 x", "%Y %Q")[1]).toBe("timestamp_invalid");
    expect(normalize("2026 2026", "%Y %Y")[1]).toBe("timestamp_invalid");
  });
});

describe("CLI", () => {
  test("errors do not echo evidence", () => {
    const path = join(mkdtempSync(join(tmpdir(), "parse-logs-")), "synthetic.log");
    const original = "#Fields: date time\nSECRET REJECTED EXTRA\n2026-09-16 10:00:00\n";
    writeFileSync(path, original);
    const { code, stdout, stderr } = cli(path, "--source-id", "S1", "--format", "iis", "--timezone", "UTC");
    expect(code).toBe(2);
    expect(stderr).not.toContain("SECRET");
    expect(JSON.parse(stdout).line_start).toBe(3);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("empty and malformed CSV", () => {
    const path = join(mkdtempSync(join(tmpdir(), "parse-logs-")), "synthetic.csv");
    for (const [content, expected] of [["", 0], ['"unterminated', 2]] as const) {
      writeFileSync(path, content);
      const { code, stderr } = cli(path, "--source-id", "S1", "--format", "csv", "--timestamp-column", "when");
      expect(code).toBe(expected);
      const summary = JSON.parse(stderr.trim().split("\n").at(-1)!);
      expect(summary.source_id).toBe("S1");
      expect(summary.extraction_complete).toBe(expected === 0);
    }
  });

  test("invalid encoding fails instead of replacing bytes", () => {
    const path = join(mkdtempSync(join(tmpdir(), "parse-logs-")), "bad.log");
    writeFileSync(path, Buffer.from("#Fields: date time\n2026-09-16 10:00:\xff00\n", "latin1"));
    const { code, stderr } = cli(path, "--source-id", "S1", "--format", "iis", "--timezone", "UTC");
    expect(code).toBe(2);
    expect(JSON.parse(stderr.trim().split("\n").at(-1)!).errors).toEqual({ source_read_failed: 1 });
  });

  test("argument validation", () => {
    expect(cli("x.log", "--source-id", "S", "--format", "haproxy").code).toBe(2);
    expect(cli("x.log", "--source-id", "S", "--format", "iis", "--timezone", "Mars/Base").stderr).toContain("timezone is unavailable or invalid");
    expect(cli("x.log", "--source-id", "S", "--format", "csv").stderr).toContain("CSV requires --timestamp-column");
  });
});
