import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCapture, TimeoutExpired, type Runner } from "../scripts/inspect_capture.ts";

let path: string;
beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "capture-")), "capture.pcap");
  writeFileSync(path, "");
});

function mockResult(stdout: string, exitCode = 0, stderr = "") {
  const calls: [string[], number][] = [];
  const run: Runner = (args, timeout) => {
    calls.push([args, timeout]);
    return { exitCode, stdout, stderr };
  };
  const result = inspectCapture(path, 60, { which: () => "/tool/capinfos", run });
  expect(calls).toHaveLength(1);
  expect(calls[0][1]).toBe(60);
  expect(calls[0][0][0]).toBe("/tool/capinfos"); // argv list, never a shell string
  return result;
}

test("zero packets", () => expect(mockResult("Number of packets: 0\n").status).toBe("unusable"));

test("valid capture", () => {
  const result = mockResult("Number of packets: 2\nFirst packet time: 100.000000001\nLast packet time: 102.1\n");
  expect(result.status).toBe("usable");
  expect(result.first_epoch).toBe("100.000000001");
});

test("failed reader", () => expect(mockResult("Number of packets: 10", 1, "truncated").status).toBe("unusable"));
test("unknown range", () => expect(mockResult("Number of packets: 2").status).toBe("partial"));
test("invalid range", () => expect(mockResult("Number of packets: 2\nEarliest packet time: nan\nLatest packet time: inf").status).toBe("partial"));
test("reader warning", () => expect(mockResult("Number of packets: 2\nFirst packet time: 1\nLast packet time: 2", 0, "reader warning").status).toBe("partial"));
test("bad count", () => expect(mockResult("Number of packets: invalid").status).toBe("not inspected"));
test("missing tool", () => expect(inspectCapture(path, 60, { which: () => null }).status).toBe("not inspected"));

test("ETL is never handed to the reader", () => {
  const etl = path.replace(/\.pcap$/, ".etl");
  writeFileSync(etl, "");
  const run: Runner = () => { throw new Error("must not run"); };
  expect(inspectCapture(etl, 60, { which: () => "/tool/capinfos", run }).reason).toContain("unsupported");
});

test("timeout", () => {
  const run: Runner = (args, timeout) => { throw new TimeoutExpired(args, timeout); };
  const result = inspectCapture(path, 60, { which: () => "capinfos", run });
  expect(result.status).toBe("not inspected");
  expect(result.reason).toContain("timed out after 60 seconds");
});

test.skipIf(!Bun.which("capinfos"))("real pcap", () => {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeUInt32LE(65535, 16);
  header.writeUInt32LE(1, 20);
  const record = (captured: number) => {
    const r = Buffer.alloc(16);
    r.writeUInt32LE(1700000000, 0);
    r.writeUInt32LE(250000, 4);
    r.writeUInt32LE(14, 8);
    r.writeUInt32LE(14, 12);
    return Buffer.concat([r, Buffer.alloc(captured)]);
  };
  writeFileSync(path, header);
  expect(inspectCapture(path).status).toBe("unusable");
  writeFileSync(path, Buffer.concat([header, record(14)]));
  const result = inspectCapture(path);
  expect(result.status).toBe("usable");
  expect(result.packet_count).toBe(1);
  writeFileSync(path, Buffer.concat([header, record(4)]));
  expect(inspectCapture(path).status).toBe("unusable");
});
