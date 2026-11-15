#!/usr/bin/env bun
/**
 * Prove which effort a headless session really sends to the API. A local proxy (ANTHROPIC_BASE_URL) records
 * `output_config.effort` from each /v1/messages request and forwards it unchanged to api.anthropic.com.
 * The init and result events of `claude -p` don't carry the effort, so this is the only direct evidence.
 *
 * Usage: bun probe_effort.ts [--model claude-opus-5-5] [level ...]   (default levels: medium high, plus no flag)
 * Prints one line per run: the flag passed and the effort values the requests carried. Costs a few cents.
 */
import { parseArgs } from "node:util";

const { values: o, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { model: { type: "string" } } });
const model = o.model ?? "claude-opus-5-5";
const levels: (string | null)[] = positionals.length ? positionals : ["medium", "high", null];

let seen: string[] = [];
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.text() : undefined;
  if (body && url.pathname.endsWith("/messages")) { try { const j = JSON.parse(body); seen.push(`${j.model}=${j.output_config?.effort ?? "none"}`); } catch { /* not JSON */ } }
  const headers = new Headers(req.headers);
  headers.delete("host"); headers.delete("accept-encoding");
  const res = await fetch(`https://api.anthropic.com${url.pathname}${url.search}`, { method: req.method, headers, body });
  // fetch has already decoded the body, so the encoding headers no longer apply.
  const out = new Headers(res.headers); out.delete("content-encoding"); out.delete("content-length");
  return new Response(res.body, { status: res.status, headers: out });
} });

for (const level of levels) {
  seen = [];
  const args = ["claude", "-p", "Reply OK", "--model", model, "--output-format", "json", ...(level ? ["--effort", level] : [])];
  // Async spawn: a synchronous one would block this process's own proxy.
  const p = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` } });
  const stdout = await new Response(p.stdout).text();
  await p.exited;
  const result = (() => { try { return JSON.parse(stdout).result; } catch { return stdout.slice(0, 80); } })();
  console.log(`--effort ${level ?? "(none)"}: requests carried effort ${[...new Set(seen)].join(", ") || "–"} (${seen.length} requests; reply: ${JSON.stringify(result)})`);
}
server.stop(true);
