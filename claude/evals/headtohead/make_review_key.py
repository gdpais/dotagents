#!/usr/bin/env python3
"""Write review_key.json: each planted defect's file and line, found by its snippet in the fixture
repo at the branch head (so the key always matches make_review_fixtures.sh).

Usage: python3 -I make_review_key.py FIXTURES_DIR OUT_JSON
"""
import json
import os
import sys

REPOS = {
    "rv-billing": {"branch": "feature/pricing-refactor", "lang": "python", "defects": [
        ("D1", "billing/invoices.py", 'WHERE id = ?", (invoice_id,)', "security", "get_invoice no longer filters by tenant_id: any tenant can read another tenant's invoice by id (broken access control / IDOR)."),
        ("D2", "billing/invoices.py", "AND status = '{status}'", "security", "search_invoices interpolates status into the SQL string: SQL injection."),
        ("D3", "billing/pricing.py", "subtotal += price_of(db, line.product_id)", "performance", "order_total queries the price once per line (N+1) instead of the previous single IN query."),
        ("D4", "billing/pricing.py", "return int(subtotal * (1 - discount))", "correctness", "int() truncates instead of rounding (and floats the cents): totals are under-charged by up to a cent compared with main's round()."),
    ], "decoys": ["COLUMNS f-string in get_invoice/search_invoices is a module constant, not user input: flagging it as injection is a false positive."]},
    "rv-inventory": {"branch": "feature/reservations-audit", "lang": "typescript", "defects": [
        ("D1", "src/reservations.ts", "const item = await repo.get(sku);", "concurrency", "reserve reads stock, awaits, then writes available - qty: concurrent reservations race (check-then-act / lost update) and oversell; main used the atomic decrementIfAvailable."),
        ("D2", "src/reservations.ts", "await orders.markPaid(orderId, captureId);", "error-handling", "confirmOrder swallows a failed capture and still marks the order paid (with captureId 'pending'); main marked it failed and rethrew."),
    ], "decoys": ["reserve's new audit parameter changes its signature; the in-repo caller (test) is updated."]},
    "rv-notifier": {"branch": "feature/batch-send", "lang": "typescript", "defects": [
        ("D1", "src/send.ts", "for (let attempt = 1; attempt <= MAX_ATTEMPTS; ) {", "correctness", "attempt is never incremented: a retryable error (5xx, 429, network) retries forever with a constant 400 ms sleep."),
        ("D2", "src/batch.ts", "recipients.forEach(async (r) => {", "error-handling", "forEach with an async callback is not awaited: sendCampaign returns before sends finish, reports every recipient as sent, and send failures become unhandled rejections (also unbounded parallelism)."),
        ("D3", "src/batch.ts", "conn.release();", "error-handling", "release() is no longer in finally: if the query throws, the pooled connection leaks."),
    ], "decoys": []},
    "rv-auth": {"branch": "feature/sso-callback", "lang": "typescript", "defects": [
        ("D1", "src/sso.ts", "if (req.query.state && req.query.state !== req.session.state)", "security", "The state check is skipped when state is absent: login CSRF / session fixation (main rejected a missing state)."),
        ("D2", "src/sso.ts", 'logger.info("sso login", { email, accessToken });', "security", "The IdP access token is written to the logs."),
        ("D3", "src/sso.ts", 'res.redirect(req.query.returnTo ?? "/");', "security", "returnTo is no longer validated: open redirect (main allowed same-site paths only)."),
    ], "decoys": []},
    "rv-ledger": {"branch": "feature/transfer-fees", "lang": "python", "defects": [
        ("D1", "ledger/entries.py", "(account_id, size, page * size),", "correctness", "page is 1-based but the offset is now page * size: page 1 skips the newest `size` entries (main used (page - 1) * size)."),
        ("D2", "ledger/entries.py", "def post(db, account_id: int, amount, memo: str, tags: list[str] = []) -> int:", "correctness", "Mutable default list: the 'fee' tag appended for fee entries persists, so every later entry posted without tags is tagged 'fee'."),
        ("D3", "ledger/entries.py", "post(db, dst, amount, memo)", "concurrency", "The debit and the credit/fee are now in two separate transactions: if the second fails, the source is debited with no credit (money disappears); transfer is no longer atomic."),
    ], "decoys": ["Decimal(str(value)) in to_amount is correct (avoids float noise).", "The fee quantize to 0.01 is intentional."]},
    "rv-cache": {"branch": "feature/dashboard-cache", "lang": "typescript", "defects": [
        ("D1", "src/dashboard.ts", "const key = `dashboard:${req.path}`;", "security", "The cache key ignores the user: every user requesting /dashboard gets whoever's dashboard was cached first (personal balances leak across users)."),
        ("D2", "src/dashboard.ts", "await cache.set(key, res, TTL_SECONDS);", "correctness", "Cache.set takes milliseconds (deps.ts) but gets 300: entries live 0.3 s instead of five minutes, so the cache does nothing."),
        ("D3", "src/dashboard.ts", "const res = await api.dashboard(req.userId);", "error-handling", "Responses are cached whatever their status: an upstream 5xx/4xx is cached and served from cache."),
    ], "decoys": ["widgets(): de-duplicated ids in one batched call is correct; the empty-ids guard is fine."]},
    "rv-clean": {"branch": "refactor/extract-formatters", "lang": "typescript", "defects": [], "decoys": ["Behaviour-preserving move of formatCurrency/formatDate to format.ts, re-exported from orders.ts; new tests pass. Any defect reported here is a false positive."]},
}

if __name__ == "__main__":
    fx, out = sys.argv[1], sys.argv[2]
    key = {}
    for repo, spec in REPOS.items():
        ds = []
        for did, path, snippet, kind, desc in spec["defects"]:
            lines = open(os.path.join(fx, repo, path)).read().split("\n")
            hits = [i + 1 for i, l in enumerate(lines) if snippet in l]
            if len(hits) != 1:
                sys.exit(f"{repo} {did}: snippet found {len(hits)} times")
            ds.append({"id": did, "file": path, "line": hits[0], "kind": kind, "defect": desc, "code": lines[hits[0] - 1].strip()})
        key[repo] = {"branch": spec["branch"], "base": "main", "lang": spec["lang"], "defects": ds, "decoys": spec["decoys"]}
    with open(out, "w") as f:
        json.dump(key, f, indent=1)
        f.write("\n")
    print(json.dumps({r: [(d["id"], d["file"], d["line"], d["kind"]) for d in v["defects"]] for r, v in key.items()}))
