/**
 * Tests for scripts/scan_secrets.ts. Run with `bun test` from the skill folder.
 * Fake credentials are assembled at runtime so this file never matches a scanner itself.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { entropy, mask, scanLine, scanPatch, scanText } from "../scripts/scan_secrets";

const SCRIPT = join(import.meta.dir, "..", "scripts", "scan_secrets.ts");
const AWS_ID = "AKIA" + "Q7XK2M4N8P3R5T6W";
const GH = "ghp_" + "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3zA5";
const STRIPE = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc";
const PEM = "-----BEGIN RSA " + "PRIVATE KEY-----";
const DB_URL = "postgres://app:" + "Zq8vT2nRw9" + "@db.internal:5432/app";
const STRONG = "Xk9#mQ2$" + "vL7!pR4@";

test("detects provider tokens and masks the value", () => {
  const f = scanLine(`const k = "${AWS_ID}"; const t = '${GH}';`, "a.ts", 3);
  expect(f.map((x) => x.rule).sort()).toEqual(["aws-access-key-id", "github-token"]);
  expect(f[0].masked).toBe("AKIA…(20 chars)");
  expect(JSON.stringify(f)).not.toContain(AWS_ID);
});

test("private key header and credentials in URL", () => {
  expect(scanLine(PEM, "k.pem", 1)[0].rule).toBe("private-key");
  const url = scanLine(`DATABASE_URL=${DB_URL}`, ".env", 1);
  expect(url[0].rule).toBe("credentials-in-url");
  expect(url[0].masked).toBe("Zq8v…(10 chars)");
});

test("generic assignment needs entropy and ignores placeholders", () => {
  expect(scanLine(`password = "${STRONG}"`, "c.py", 1)[0].rule).toBe("generic-secret-assignment");
  expect(scanLine('password = "aaaaaaaaaaaaaaaa"', "c.py", 1)).toEqual([]);
  expect(scanLine('api_key = "your-api-key-here-please"', "c.py", 1)).toEqual([]);
  expect(scanLine('secret = "${SECRET_FROM_ENV}"', "c.py", 1)).toEqual([]);
  expect(scanLine('url = "postgres://user:<password>@host/db"', "c.py", 1)).toEqual([]);
});

test("inline allow comment suppresses a reviewed line", () => {
  expect(scanLine(`key = "${STRIPE}" // secret-scan: allow`, "x.js", 1)).toEqual([]);
  expect(scanLine(`key = "${STRIPE}"`, "x.js", 1)[0].rule).toBe("stripe-live-key");
});

test("scanText reports line numbers", () => {
  const f = scanText(`a\nb\nconst t = "${GH}"\n`, "f.ts");
  expect(f[0].line).toBe(3);
});

test("scanPatch only looks at added lines and tracks numbering", () => {
  const patch = [`+++ b/src/a.ts`, `@@ -1,0 +7,2 @@`, `+ok line`, `+const k = "${AWS_ID}"`, `-const old = "${GH}"`].join("\n");
  const f = scanPatch(patch);
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ file: "src/a.ts", line: 8, rule: "aws-access-key-id" });
});

test("entropy and mask helpers", () => {
  expect(entropy("aaaa")).toBe(0);
  expect(entropy("abcd")).toBe(2);
  expect(mask("short")).toBe("*****");
});

// ------------------------------------------------------------------ CLI
let dir: string;
const put = (name: string, text: string) => {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), text);
};
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "secrets-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("CLI walks directories, skips node_modules, exits 1 on high findings", () => {
  put("src/config.ts", `export const token = "${GH}";\n`);
  put("node_modules/pkg/index.js", `const k = "${AWS_ID}";\n`);
  const p = Bun.spawnSync([process.execPath, SCRIPT, "-C", dir]);
  const out = JSON.parse(p.stdout.toString());
  expect(p.exitCode).toBe(1);
  expect(out.findings.map((f: any) => f.file)).toEqual(["src/config.ts"]);
});

test("CLI exits 0 on a clean tree", () => {
  put("src/a.ts", "export const a = 1;\n");
  const p = Bun.spawnSync([process.execPath, SCRIPT, "-C", dir]);
  expect(p.exitCode).toBe(0);
  expect(JSON.parse(p.stdout.toString()).findings).toEqual([]);
});

test("CLI --staged scans only the index", () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env });
  put("staged.ts", `const k = "${AWS_ID}";\n`);
  put("unstaged.ts", `const t = "${GH}";\n`);
  Bun.spawnSync(["git", "add", "staged.ts"], { cwd: dir, env });
  const p = Bun.spawnSync([process.execPath, SCRIPT, "-C", dir, "--staged"], { env });
  const out = JSON.parse(p.stdout.toString());
  expect(out.findings.map((f: any) => f.file)).toEqual(["staged.ts"]);
});
