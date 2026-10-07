/**
 * Tests for scripts/audit_ci.ts. Run with `bun test` from the skill folder.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditWorkflow, gatesFrom } from "../scripts/audit_ci";

const SCRIPT = join(import.meta.dir, "..", "scripts", "audit_ci.ts");
const SHA = "b4ffde65f46336ab88eb53be808477a3936bae11";
const ids = (wfYaml: string) => auditWorkflow(Bun.YAML.parse(wfYaml), "wf.yml").findings.map((f) => f.id).sort();

const HARDENED = `
name: CI
on: [push, pull_request]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
      - run: bun test
`;

test("hardened workflow has no findings", () => {
  expect(ids(HARDENED)).toEqual([]);
});

test("unpinned third-party and first-party actions", () => {
  const f = ids(HARDENED.replace(`actions/checkout@${SHA}`, "actions/checkout@v4").replace("- run: bun test", "- uses: someone/deploy-action@main\n      - run: bun test"));
  expect(f).toEqual(["CI01", "CI02"]);
});

test("missing permissions, write-all and missing timeout", () => {
  expect(ids(HARDENED.replace("permissions:\n  contents: read\n", "").replace("    timeout-minutes: 15\n", ""))).toEqual(["CI03", "CI08"]);
  expect(ids(HARDENED.replace("permissions:\n  contents: read", "permissions: write-all"))).toEqual(["CI04"]);
});

test("pull_request_target checking out PR head is a pwn request", () => {
  const wf = `
on: pull_request_target
permissions: { contents: read }
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@${SHA}
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          persist-credentials: false
`;
  expect(ids(wf)).toEqual(["CI05"]);
});

test("script injection and secret printing", () => {
  const wf = HARDENED.replace("- run: bun test", '- run: echo "PR ${{ github.event.pull_request.title }}"\n      - run: echo ${{ secrets.TOKEN }}');
  expect(ids(wf)).toEqual(["CI06", "CI07"]);
});

test("deploy job without environment or concurrency; self-hosted on PRs", () => {
  const wf = `
name: Deploy
on: [push, pull_request]
permissions: { contents: read }
jobs:
  deploy:
    runs-on: [self-hosted, linux]
    timeout-minutes: 10
    steps:
      - run: ./deploy.sh
`;
  expect(ids(wf)).toEqual(["CI09", "CI10", "CI11"]);
});

test("reusable workflow call must be SHA-pinned unless local", () => {
  const wf = (uses: string) => `on: push\npermissions: {contents: read}\njobs:\n  call:\n    uses: ${uses}\n`;
  expect(ids(wf("org/repo/.github/workflows/x.yml@main"))).toEqual(["CI01"]);
  expect(ids(wf("./.github/workflows/x.yml"))).toEqual([]);
});

test("gate map recognises common tools", () => {
  const g = gatesFrom("bun test\nnpx eslint .\ngitleaks detect\ngithub/codeql-action/init");
  expect(g).toMatchObject({ test: true, lint: true, secret_scan: true, sast: true, deploy: false });
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "auditci-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("CLI scans the workflows folder and exits 1 on high findings", () => {
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), HARDENED);
  writeFileSync(join(dir, ".github", "workflows", "bad.yaml"), HARDENED.replace(`actions/checkout@${SHA}`, "evil/checkout@v1"));
  const p = Bun.spawnSync([process.execPath, SCRIPT, "-C", dir]);
  const out = JSON.parse(p.stdout.toString());
  expect(p.exitCode).toBe(1);
  expect(out.workflows.map((w: any) => w.file)).toEqual([".github/workflows/bad.yaml", ".github/workflows/ci.yml"]);
  expect(out.counts.high).toBe(1);
  expect(out.gates.test).toBe(true);
  expect(out.missing_gates).toContain("secret_scan");
});

test("CLI with no workflows reports that no gates are enforced", () => {
  const p = Bun.spawnSync([process.execPath, SCRIPT, "-C", dir]);
  expect(p.exitCode).toBe(0);
  expect(JSON.parse(p.stdout.toString()).note).toContain("no gates");
});
