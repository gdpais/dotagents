#!/usr/bin/env python3
"""Build the incident fixtures and their hidden answer keys (deterministic, seeded).

Usage: python3 -I make_incident_fixtures.py OUT_DIR KEYS_DIR

OUT_DIR/fixtures/<scenario>/inputs/...   what a session sees (copied into its working folder)
KEYS_DIR/<scenario>.json                 the answer key: true cause, red herrings, figures recounted
                                         from the generated data, and the facts that are in the evidence

Scenarios (iteration-7 shapes, rebuilt because fixtures are never stored, G-33):
  inc-small      checkout 503s on 30 Sep: config v14 cut the DB pool 50 -> 10; CDN cert rotation is the
                 red herring; edge-01 log only (edge-02 export failed); UTC logs vs Lisbon notes.
  inc-2219       payment confirmations failing on Mon 28 Sep: payments-gw v5.2 synchronous fraud check
                 (flag fraud_check_sync, 3 s timeout) + fraud-svc minReplicas 6 -> 2 + campaign traffic;
                 DB failover and CDN Brotli are red herrings; edge-02 clock runs ~95 s fast; flag OFF
                 restored service, the fraud-svc scale-up only helped. Large logs.
  inc-2219-t1    the same incident with only the edge logs, checkout-svc export, change log and Slack
                 notes (turn 1 of the two-turn RCA); inc-2219-t2 holds the files added for turn 2.
  inc-2219-pm    postmortem inputs: incident record (SLO), RCA summary, change log, Slack notes, Grafana.
  inc-live       no files: the live-report prompt carries all the facts.
"""
import json
import math
import os
import random
import shutil
import sys
from datetime import datetime, timedelta, timezone

UTC = timezone.utc
LIS = timezone(timedelta(hours=1))  # Lisbon summer time (WEST) in late Sep / early Oct


def poisson(rng, lam):
    """Knuth's method; lam is small here (< 5 per second)."""
    L, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= L:
            return k
        k += 1


def hap_line(host, pid, rng, t_logged, backend, server, timers, status, size, term, method, path):
    ip = f"10.0.{rng.randint(1, 9)}.{rng.randint(2, 250)}:{rng.randint(40000, 65000)}"
    ts = t_logged.strftime("%d/%b/%Y:%H:%M:%S.") + f"{t_logged.microsecond // 1000:03d}"
    syslog = t_logged.strftime("%b %d %H:%M:%S")
    conns = f"{rng.randint(300, 460)}/{rng.randint(280, 440)}/{rng.randint(10, 60)}/{rng.randint(2, 14)}/0"
    queue = "0/0" if term[1] != "Q" else f"{rng.randint(5, 40)}/{rng.randint(20, 90)}"
    if 500 <= size <= 599:  # keep byte counts out of the 5xx range so status counts are unambiguous
        size += 100
    return f'{syslog} {host} haproxy[{pid}]: {ip} [{ts}] fe_https~ {backend}/{server} {timers} {status} {size} - - {term} {conns} {queue} "{method} {path} HTTP/1.1"'


def verbatim(folder, names):
    """The short evidence files word for word, so graders don't mistake a quoted detail for an invented one."""
    return [f"Verbatim {n}:\n" + open(os.path.join(folder, n)).read() for n in names]


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text if text.endswith("\n") else text + "\n")


# --------------------------------------------------------------------------------------------
# inc-small: 30 Sep 2026, checkout 503s, ~40 min around lunchtime (Lisbon)
# --------------------------------------------------------------------------------------------
def inc_small(out, keys):
    rng = random.Random(30092026)
    d = os.path.join(out, "fixtures", "inc-small", "inputs")
    start, end = datetime(2026, 9, 30, 11, 20, tzinfo=UTC), datetime(2026, 9, 30, 12, 50, tzinfo=UTC)
    onset, fixed = datetime(2026, 9, 30, 11, 52, 10, tzinfo=UTC), datetime(2026, 9, 30, 12, 31, 40, tzinfo=UTC)
    lines, stats = [], {"checkout_total": 0, "checkout_503": 0, "checkout_win_total": 0, "checkout_win_503": 0, "cart_total": 0, "cart_5xx": 0, "static_total": 0, "static_5xx": 0}
    per_min = {}
    chk_ts = []  # (ts, failed)
    t = start
    while t < end:
        for kind, lam in (("checkout", 0.40), ("cart", 0.50), ("static", 0.60)):
            for _ in range(poisson(rng, lam)):
                ts = t + timedelta(milliseconds=rng.randint(0, 999))
                inwin = onset <= ts < fixed
                if kind == "checkout":
                    stats["checkout_total"] += 1
                    m = per_min.setdefault(ts.replace(second=0, microsecond=0), [0, 0, []])
                    m[0] += 1
                    if inwin:
                        stats["checkout_win_total"] += 1
                    failed = inwin and rng.random() < 0.34
                    chk_ts.append((ts, failed))
                    if failed:
                        stats["checkout_503"] += 1
                        stats["checkout_win_503"] += 1
                        m[1] += 1
                        m[2].append(10000)
                        lines.append((ts, hap_line("edge-01", 812, rng, ts, "be_checkout", f"checkout-{rng.randint(1, 3)}", f"0/10000/-1/-1/10001", 503, 217, "sQ--", "POST", "/api/checkout")))
                    else:
                        tr = rng.randint(2200, 9400) if inwin else rng.randint(70, 260)
                        tw = rng.randint(800, 6000) if inwin else 0
                        m[2].append(tw + tr)
                        lines.append((ts, hap_line("edge-01", 812, rng, ts, "be_checkout", f"checkout-{rng.randint(1, 3)}", f"0/{tw}/1/{tr}/{tw + tr + 1}", 200, rng.randint(780, 860), "----", "POST", "/api/checkout")))
                elif kind == "cart":
                    stats["cart_total"] += 1
                    tr = rng.randint(20, 90)
                    lines.append((ts, hap_line("edge-01", 812, rng, ts, "be_cart", f"cart-{rng.randint(1, 2)}", f"0/0/1/{tr}/{tr + 1}", 200, rng.randint(400, 1400), "----", rng.choice(["GET", "GET", "POST"]), "/api/cart")))
                else:
                    stats["static_total"] += 1
                    tr = rng.randint(2, 20)
                    lines.append((ts, hap_line("edge-01", 812, rng, ts, "be_static", "cdn-origin-1", f"0/0/0/{tr}/{tr}", 200, rng.randint(2000, 90000), "----", "GET", rng.choice(["/static/app.js", "/static/app.css", "/static/logo.svg"]))))
        t += timedelta(seconds=1)
    lines.sort()
    write(os.path.join(d, "haproxy-edge-01.log"), "\n".join(l for _, l in lines))
    # Grafana export (Lisbon time, per minute)
    rows = ["time_lisbon,checkout_rps,checkout_5xx_pct,checkout_p95_ms,db_pool_active,db_pool_max,db_cpu_pct"]
    cfg_v14, rollback = datetime(2026, 9, 30, 11, 50, tzinfo=UTC), datetime(2026, 9, 30, 12, 28, tzinfo=UTC)
    m = start
    while m < end:
        tot, bad, lat = per_min.get(m, [0, 0, []])
        p95 = sorted(lat)[int(0.95 * (len(lat) - 1))] if lat else 0
        pool_max = 10 if cfg_v14 <= m < rollback else 50
        active = 10 if onset - timedelta(minutes=1) <= m < fixed else min(pool_max, rng.randint(6, 14))
        rows.append(f"{m.astimezone(LIS):%Y-%m-%d %H:%M},{tot / 60:.2f},{100 * bad / tot if tot else 0:.1f},{p95},{active},{pool_max},{rng.randint(27, 33)}")
        m += timedelta(minutes=1)
    write(os.path.join(d, "grafana-checkout-svc.csv"), "\n".join(rows))
    write(os.path.join(d, "changes.md"), """# Change log (times are Europe/Lisbon)

| When | Service | Change | By |
|---|---|---|---|
| 2026-09-30 09:12 | search-svc | Synonym list update | search team |
| 2026-09-30 12:38 | CDN / edge | TLS certificate rotation, all edge hostnames | platform |
| 2026-09-30 12:50 | checkout-svc | Config v14: connection settings cleanup (`db.pool.max` 50 -> 10, `http.keepalive_s` 60 -> 30) | checkout team |
| 2026-09-30 13:28 | checkout-svc | Config rolled back v14 -> v13 | on-call |
""")
    write(os.path.join(d, "oncall-notes.md"), """# On-call notes, 30 Sep (Lisbon time)

- 12:58 Alert: checkout 5xx above 5% (edge).
- 13:02 Ana: the CDN cert was rotated at 12:38, I bet some clients are failing TLS. Probably that.
- 13:06 Marta (DBA): DB is fine, nothing on our side.
- 13:10 Rui: tried to export edge-02's HAProxy log for the window, the export job failed. We only have edge-01.
- 13:19 Rui: checkout pods look healthy, no restarts.
- 13:25 Decided to roll back checkout-svc config v14.
- 13:28 Rollback done.
- 13:33 Checkout errors back to normal.
""")
    w_rate = 100 * stats["checkout_win_503"] / stats["checkout_win_total"]
    first = min(ts for ts, f in chk_ts if f); last = max(ts for ts, f in chk_ts if f)
    def alt(a, b):
        n = sum(1 for ts, _ in chk_ts if a <= ts <= b); return {"requests": n, "503": stats["checkout_503"], "rate_pct": round(100 * stats["checkout_503"] / n, 1)}
    alts = {"first_to_last_503": {"from_utc": f"{first:%H:%M:%S}", "to_utc": f"{last:%H:%M:%S}", **alt(first, last)},
            "minutes_1152_to_1231_inclusive_utc": alt(datetime(2026, 9, 30, 11, 52, tzinfo=UTC), datetime(2026, 9, 30, 12, 31, 59, 999000, tzinfo=UTC)),
            "minutes_1150_to_1235_utc": alt(datetime(2026, 9, 30, 11, 50, tzinfo=UTC), datetime(2026, 9, 30, 12, 35, tzinfo=UTC))}
    keys["inc-small"] = {
        "scenario": "Checkout 503s on 30 Sep 2026, ~40 min around lunchtime Lisbon",
        "true_cause": "checkout-svc config v14 (deployed 12:50 Lisbon = 11:50 UTC) cut db.pool.max from 50 to 10; the pool saturated (db_pool_active pinned at 10), checkout requests queued in HAProxy and hit the queue timeout (termination sQ--, Tw 10000 ms) -> 503 on be_checkout only. Rollback to v13 at 13:28 Lisbon ended it (errors stop 12:31:40 UTC = 13:31:40 Lisbon).",
        "red_herrings": [
            "CDN TLS certificate rotation at 12:38 Lisbon: only be_checkout fails, cart and static on the same edge are 100% 200; failures are server-queue timeouts (sQ), not TLS/handshake; onset is 12:52, 14 min after the rotation and 2 min after config v14.",
            "Marta's 'DB is fine' is reported, not verified; db_cpu stays 27-33% (so the DB itself is not saturated) but that does not clear the client-side pool."
        ],
        "evidence_gaps": ["edge-02 HAProxy log is missing (export failed); counts cover edge-01 only", "no checkout-svc application logs", "recovery after rollback supports but does not prove the cause; a discriminating test would be re-applying pool 10 in staging under load"],
        "timezones": "HAProxy log is UTC; change log, on-call notes and the Grafana export are Lisbon (UTC+1). Onset 11:52:10 UTC = 12:52:10 Lisbon; last 503 before 12:31:40 UTC = 13:31:40 Lisbon.",
        "figures": {
            "edge01_checkout_requests_whole_log": stats["checkout_total"],
            "edge01_checkout_503_whole_log": stats["checkout_503"],
            "edge01_checkout_requests_in_window_1152_1231_UTC": stats["checkout_win_total"],
            "edge01_checkout_503_in_window": stats["checkout_win_503"],
            "edge01_checkout_503_rate_in_window_pct": round(w_rate, 1),
            "edge01_cart_requests": stats["cart_total"], "edge01_cart_5xx": 0,
            "edge01_static_requests": stats["static_total"], "edge01_static_5xx": 0,
            "duration_min": "about 39-40 (12:52-13:31 Lisbon)",
            "db_cpu_pct_range": "27-33",
            "alternative_windows": alts,
        },
        "facts_in_evidence": [
            "Change log: 09:12 search-svc synonyms; 12:38 CDN TLS cert rotation (all edge hostnames); 12:50 checkout-svc config v14 (db.pool.max 50->10, http.keepalive_s 60->30); 13:28 config rolled back v14->v13. All Lisbon.",
            "On-call notes: 12:58 alert 5xx>5%; 13:02 Ana suspects CDN cert; 13:06 Marta says DB fine; 13:10 edge-02 export failed; 13:19 pods healthy, no restarts; 13:25 decided rollback; 13:28 rollback done; 13:33 back to normal.",
            "Grafana (Lisbon, per minute): checkout_rps, checkout_5xx_pct, checkout_p95_ms, db_pool_active, db_pool_max (50, 10 from 12:50 to 13:27, 50 again 13:28), db_cpu_pct 27-33.",
            "HAProxy edge-01 (UTC) 11:20-12:50: be_checkout, be_cart, be_static. Checkout 503s all sQ-- with Tw=10000.",
            "Nothing about customers, revenue, owners, tickets or severity is in the evidence.",
        ] + verbatim(d, ("changes.md", "oncall-notes.md")),
    }


# --------------------------------------------------------------------------------------------
# INC-2219: Mon 28 Sep 2026, payment confirmations failing ~09:43-10:40 Lisbon
# --------------------------------------------------------------------------------------------
SKEW = timedelta(seconds=95)  # edge-02 clock runs fast


def inc_2219(out, keys):
    rng = random.Random(28092026)
    base = os.path.join(out, "fixtures")
    start, end = datetime(2026, 9, 28, 8, 20, tzinfo=UTC), datetime(2026, 9, 28, 10, 0, tzinfo=UTC)
    v52 = datetime(2026, 9, 28, 8, 36, tzinfo=UTC)
    campaign = datetime(2026, 9, 28, 8, 40, tzinfo=UTC)
    onset = datetime(2026, 9, 28, 8, 42, 52, tzinfo=UTC)
    failover = (datetime(2026, 9, 28, 9, 5, 10, tzinfo=UTC), datetime(2026, 9, 28, 9, 5, 31, tzinfo=UTC))
    scaleup = datetime(2026, 9, 28, 9, 25, tzinfo=UTC)
    flagoff = datetime(2026, 9, 28, 9, 40, tzinfo=UTC)
    win = (onset, flagoff)
    st = {e: {"confirm_total_log": 0, "confirm_503_log": 0, "confirm_502_log": 0, "confirm_win": 0, "confirm_503_win": 0, "confirm_502_win": 0,
              "confirm_win_uncorrected": 0, "confirm_503_win_uncorrected": 0, "checkout_502_log": 0, "other_5xx": 0} for e in ("edge-01", "edge-02")}
    phase = {"pre_scaleup": [0, 0], "post_scaleup": [0, 0]}
    confirm_per_min = {}
    confirms = []  # (true ts, logged ts, edge, status)
    iis, iis_stats = [], {"confirm_total": 0, "confirm_503": 0, "precheck_total": 0, "precheck_504": 0}
    for edge, pid in (("edge-01", 812), ("edge-02", 744)):
        lines = []
        t = start
        while t < end:
            boost = 2.3 if t >= campaign else 1.0
            for kind, lam in (("confirm", 0.30 * boost), ("checkout", 0.45 * boost), ("cart", 0.8 * boost), ("static", 1.6 * boost)):
                for _ in range(poisson(rng, lam)):
                    ts = t + timedelta(milliseconds=rng.randint(0, 999))
                    logged = ts + SKEW if edge == "edge-02" else ts
                    in_fail = failover[0] <= ts < failover[1]
                    s = st[edge]
                    if kind == "confirm":
                        s["confirm_total_log"] += 1
                        inwin = win[0] <= ts < win[1]
                        inwin_unc = win[0] <= logged < win[1]
                        if inwin:
                            s["confirm_win"] += 1
                        if inwin_unc:
                            s["confirm_win_uncorrected"] += 1
                        key = ts.replace(second=0, microsecond=0)
                        cm = confirm_per_min.setdefault(key, [0, 0])
                        cm[0] += 1
                        p_fail = 0.0
                        if onset <= ts < scaleup:
                            p_fail = 0.36
                        elif scaleup <= ts < flagoff:
                            p_fail = 0.14
                        if in_fail and rng.random() < 0.8:
                            confirms.append((ts, logged, edge, 502))
                            s["confirm_502_log"] += 1
                            if inwin:
                                s["confirm_502_win"] += 1
                            cm[1] += 1
                            lines.append((logged, hap_line(edge, pid, rng, logged, "be_payments", f"pgw-{rng.randint(1, 4)}", "0/0/1/-1/180", 502, 204, "SH--", "POST", "/api/checkout/confirm")))
                            iis.append((ts + timedelta(milliseconds=rng.randint(5, 30)), "POST", "/v1/payments/confirm", 500, rng.randint(120, 175)))
                            continue
                        if rng.random() < p_fail:
                            confirms.append((ts, logged, edge, 503))
                            s["confirm_503_log"] += 1
                            if inwin:
                                s["confirm_503_win"] += 1
                            if inwin_unc:
                                s["confirm_503_win_uncorrected"] += 1
                            cm[1] += 1
                            ph = "pre_scaleup" if ts < scaleup else "post_scaleup"
                            phase[ph][1] += 1
                            iis_stats["confirm_503"] += 1
                            lines.append((logged, hap_line(edge, pid, rng, logged, "be_payments", f"pgw-{rng.randint(1, 4)}", f"0/0/1/{rng.randint(3020, 3180)}/{rng.randint(3190, 3260)}", 503, 231, "----", "POST", "/api/checkout/confirm")))
                            iis.append((ts + timedelta(milliseconds=rng.randint(5, 30)), "POST", "/v1/payments/confirm", 503, rng.randint(3010, 3150)))
                        else:
                            confirms.append((ts, logged, edge, 200))
                            tr = rng.randint(900, 2900) if onset <= ts < flagoff else (rng.randint(140, 420) if ts >= v52 else rng.randint(120, 380))
                            lines.append((logged, hap_line(edge, pid, rng, logged, "be_payments", f"pgw-{rng.randint(1, 4)}", f"0/0/1/{tr}/{tr + 2}", 200, rng.randint(300, 360), "----", "POST", "/api/checkout/confirm")))
                            iis.append((ts + timedelta(milliseconds=rng.randint(5, 30)), "POST", "/v1/payments/confirm", 200, tr - rng.randint(3, 20)))
                        if onset <= ts < flagoff:
                            phase["pre_scaleup" if ts < scaleup else "post_scaleup"][0] += 1
                        iis_stats["confirm_total"] += 1
                    elif kind == "checkout":
                        if in_fail and rng.random() < 0.7:
                            s["checkout_502_log"] += 1
                            lines.append((logged, hap_line(edge, pid, rng, logged, "be_checkout", f"checkout-{rng.randint(1, 3)}", "0/0/1/-1/160", 502, 204, "SH--", "POST", "/api/checkout")))
                        else:
                            tr = rng.randint(60, 240)
                            lines.append((logged, hap_line(edge, pid, rng, logged, "be_checkout", f"checkout-{rng.randint(1, 3)}", f"0/0/1/{tr}/{tr + 1}", 200, rng.randint(700, 900), "----", "POST", "/api/checkout")))
                    elif kind == "cart":
                        tr = rng.randint(15, 80)
                        lines.append((logged, hap_line(edge, pid, rng, logged, "be_cart", f"cart-{rng.randint(1, 2)}", f"0/0/1/{tr}/{tr + 1}", 200, rng.randint(400, 1500), "----", "GET", "/api/cart")))
                    else:
                        tr = rng.randint(1, 15)
                        lines.append((logged, hap_line(edge, pid, rng, logged, "be_static", "cdn-origin-1", f"0/0/0/{tr}/{tr}", 200, rng.randint(1500, 70000), "----", "GET", rng.choice(["/static/app.js", "/static/app.css", "/static/checkout.js", "/static/fonts/inter.woff2"]))))
            t += timedelta(seconds=1)
        lines.sort()
        write(os.path.join(base, "inc-2219", "inputs", f"haproxy-{edge}.log"), "\n".join(l for _, l in lines))
    # payments-gw internal pre-check calls from the orders worker (customer outcome unknown)
    t = start
    while t < end:
        for _ in range(poisson(rng, 0.25 if t < campaign else 0.5)):
            ts = t + timedelta(milliseconds=rng.randint(0, 999))
            iis_stats["precheck_total"] += 1
            if onset <= ts < flagoff and rng.random() < (0.31 if ts < scaleup else 0.12):
                iis_stats["precheck_504"] += 1
                iis.append((ts, "POST", "/internal/orders/fraud-precheck", 504, rng.randint(3001, 3090)))
            else:
                iis.append((ts, "POST", "/internal/orders/fraud-precheck", 200, rng.randint(40, 1800) if onset <= ts < flagoff else rng.randint(30, 110)))
        t += timedelta(seconds=1)
    iis.sort()
    hdr = "#Software: Microsoft Internet Information Services 10.0\n#Version: 1.0\n#Date: 2026-09-28 08:20:00\n#Fields: date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) sc-status sc-substatus sc-win32-status time-taken"
    body = [f"{ts:%Y-%m-%d %H:%M:%S} 10.20.1.15 {m} {u} - 443 - 10.0.{rng.randint(1, 9)}.{rng.randint(2, 250)} {'checkout-svc/2.30' if u.startswith('/v1') else 'orders-worker/1.8'} {s} 0 0 {tt}" for ts, m, u, s, tt in iis]
    iis_text = hdr + "\n" + "\n".join(body)

    # Grafana exports (Lisbon, per minute)
    def minutes():
        m = start
        while m < end:
            yield m
            m += timedelta(minutes=1)
    fraud = ["time_lisbon,replicas,cpu_pct,p95_ms,rps,timeouts_per_min"]
    for m in minutes():
        reps = 6 if m >= scaleup else 2
        boost = 2.3 if m >= campaign else 1.0
        if m < v52 or m >= flagoff:  # async scoring only: light load
            cpu, p95 = rng.randint(22, 34), rng.randint(90, 160)
        elif m < onset.replace(second=0):  # sync check on, before the campaign peak
            cpu, p95 = rng.randint(64, 76), rng.randint(600, 900)
        elif m < scaleup:  # saturated on 2 replicas
            cpu, p95 = rng.randint(97, 99), 3000
        else:  # 6 replicas, still behind
            cpu, p95 = rng.randint(80, 90), rng.randint(2300, 3000)
        rps = boost * (6.0 if v52 <= m < flagoff else 1.5) + rng.uniform(-0.3, 0.3)
        to = rng.randint(70, 120) if onset.replace(second=0) <= m < scaleup else (rng.randint(15, 35) if scaleup <= m < flagoff else 0)
        fraud.append(f"{m.astimezone(LIS):%Y-%m-%d %H:%M},{reps},{cpu},{p95},{rps:.1f},{to}")
    chk = ["time_lisbon,confirm_rps,confirm_5xx_pct,checkout_rps,cart_rps"]
    for m in minutes():
        tot, bad = confirm_per_min.get(m, [0, 0])
        boost = 2.3 if m >= campaign else 1.0
        chk.append(f"{m.astimezone(LIS):%Y-%m-%d %H:%M},{tot / 60:.2f},{100 * bad / tot if tot else 0:.1f},{0.9 * boost + rng.uniform(-0.05, 0.05):.2f},{1.6 * boost + rng.uniform(-0.1, 0.1):.2f}")
    db = ["time_lisbon,role_primary,connections,cpu_pct,replication_lag_s,errors_per_min"]
    for m in minutes():
        prim = "db-b" if m >= failover[0].replace(second=0) + timedelta(minutes=1) else "db-a"
        err = 38 if m == failover[0].replace(second=0) else 0
        db.append(f"{m.astimezone(LIS):%Y-%m-%d %H:%M},{prim},{rng.randint(180, 240)},{rng.randint(24, 36)},{0 if err == 0 else 20},{err}")
    changes = """# Change log (times are Europe/Lisbon)

| When | Service | Change | By |
|---|---|---|---|
| 2026-09-25 (Fri) 17:10 | fraud-svc | HPA `minReplicas` 6 -> 2 (cost review, low weekend traffic) | platform |
| 2026-09-28 09:20 | CDN | Brotli compression enabled for static assets (`/static/*`) | platform |
| 2026-09-28 09:36 | payments-gw | v5.2: synchronous fraud check before confirm, behind flag `fraud_check_sync` (default ON), fraud call timeout 3 s | payments team |
| 2026-09-28 09:40 | marketing | "Autumn sale" campaign email sent to 1.2M customers | marketing |
| 2026-09-28 10:05 | orders-db | Planned failover db-a -> db-b (maintenance window) | DBA |
| 2026-09-28 10:25 | fraud-svc | Scaled to 6 replicas (manual) | on-call |
| 2026-09-28 10:40 | payments-gw | Flag `fraud_check_sync` set OFF | payments team |
"""
    slack = """# #inc-2219 (Slack export, Lisbon time)

09:51 alertmanager: [FIRING] checkout confirm 5xx > 10% (edge)
09:53 Rui: confirms failing with 503 at the edge, cart and browsing fine
09:58 Sofia: anything deployed? CDN turned on Brotli at 09:20, could be breaking checkout.js?
10:03 Rui: fraud-svc CPU looks high, but it's always spiky
10:07 Tiago: the DB just failed over, that has to be it
10:09 Marta (DBA): failover was planned for 10:05, done in ~20 s, db-b is primary now
10:14 Tiago: still think it's the DB, confirms write to orders
10:20 Rui: fraud-svc CPU pegged at ~99% on 2 pods, why only 2?
10:25 Rui: scaled fraud-svc to 6 replicas
10:31 Rui: better, but confirms still failing
10:36 Inês (payments): v5.2 went out at 09:36 with a synchronous fraud check (3 s timeout). Turning flag fraud_check_sync off.
10:40 Inês: fraud_check_sync OFF
10:44 Rui: confirm errors gone
11:20 Rui: resolved, keeping an eye on it
"""
    fx = os.path.join(base, "inc-2219", "inputs")
    write(os.path.join(fx, "payments-gw-iis.log"), iis_text)
    write(os.path.join(fx, "grafana-fraud-svc.csv"), "\n".join(fraud))
    write(os.path.join(fx, "grafana-checkout-svc.csv"), "\n".join(chk))
    write(os.path.join(fx, "grafana-orders-db.csv"), "\n".join(db))
    write(os.path.join(fx, "changes.md"), changes)
    write(os.path.join(fx, "slack-notes.md"), slack)

    e1, e2 = st["edge-01"], st["edge-02"]
    tot = e1["confirm_win"] + e2["confirm_win"]
    f503 = e1["confirm_503_win"] + e2["confirm_503_win"]
    f502 = e1["confirm_502_win"] + e2["confirm_502_win"]
    failed = f503 + f502
    monthly_volume, slo = 428000, 99.5
    def alt(a, b, use_logged=False):
        sel = [c for c in confirms if a <= (c[1] if use_logged else c[0]) < b]
        n, f3, f2 = len(sel), sum(1 for c in sel if c[3] == 503), sum(1 for c in sel if c[3] == 502)
        return {"requests": n, "503": f3, "502": f2, "failed": f3 + f2, "rate_pct": round(100 * (f3 + f2) / n, 1) if n else None}
    alts = {"minutes_0842_to_0940_utc_corrected": alt(datetime(2026, 9, 28, 8, 42, tzinfo=UTC), datetime(2026, 9, 28, 9, 40, tzinfo=UTC)),
            "minutes_0842_to_0944_utc_corrected": alt(datetime(2026, 9, 28, 8, 42, tzinfo=UTC), datetime(2026, 9, 28, 9, 44, tzinfo=UTC)),
            "0842:52_to_0940_uncorrected_edge02_timestamps": alt(onset, flagoff, True),
            "0845_to_0940_utc_corrected": alt(datetime(2026, 9, 28, 8, 45, tzinfo=UTC), flagoff),
            "whole_log_both_edges": alt(start, end + SKEW, True),
            "before_scaleup_0842:52_to_0925": alt(onset, scaleup), "after_scaleup_0925_to_0940": alt(scaleup, flagoff)}
    allowed = round(monthly_volume * (100 - slo) / 100)
    figures = {
        "impact_window": "09:42:52-10:40:00 Lisbon (08:42:52-09:40:00 UTC); first confirm 503 at 08:42:52 UTC on edge-01 (edge-02 logs it ~95 s later)",
        "edge02_clock_offset_s": 95,
        "confirm_requests_in_window_both_edges_corrected": tot,
        "confirm_503_in_window": f503,
        "confirm_502_in_window_db_failover_blip": f502,
        "confirm_failed_in_window": failed,
        "confirm_failure_rate_pct": round(100 * failed / tot, 1),
        "confirm_503_rate_pct": round(100 * f503 / tot, 1),
        "per_edge": {k: {kk: v for kk, v in s.items()} for k, s in st.items()},
        "alternative_windows": alts,
        "failure_rate_before_scaleup_pct": round(100 * phase["pre_scaleup"][1] / max(1, phase["pre_scaleup"][0]), 1),
        "failure_rate_after_scaleup_before_flagoff_pct": round(100 * phase["post_scaleup"][1] / max(1, phase["post_scaleup"][0]), 1),
        "iis_confirm_503_total": iis_stats["confirm_503"],
        "iis_confirm_500_during_db_blip": f502,
        "iis_precheck_504_internal": iis_stats["precheck_504"],
        "iis_precheck_total": iis_stats["precheck_total"],
        "db_failover": "10:05:10-10:05:31 Lisbon (~20 s): 502 SH-- on confirm and checkout during the blip only; orders-db errors 38 in that minute; after onset and a different signature",
        "slo": f"{slo}% of payment confirmations succeed (event-based), monthly volume {monthly_volume:,}",
        "error_budget_allowed_failures": allowed,
        "error_budget_consumed_pct": round(100 * failed / allowed, 1),
        "error_budget_consumed_pct_503_only": round(100 * f503 / allowed, 1),
        "time_to_detect": "onset 09:42:52 -> alert 09:51 = ~8 min",
        "time_to_restore": "09:42:52 -> 10:40 flag off (errors gone by 10:44 per Slack) = ~57 min",
    }
    facts = [
        "Change log (Lisbon), with the team that made each change: Fri 25 Sep 17:10 fraud-svc HPA minReplicas 6->2 (cost review, low weekend traffic; platform); Mon 28 Sep 09:20 CDN Brotli for /static/* (platform); 09:36 payments-gw v5.2 sync fraud check behind flag fraud_check_sync (default ON), 3 s timeout (payments team); 09:40 'Autumn sale' email to 1.2M customers (marketing); 10:05 planned orders-db failover db-a->db-b, maintenance window (DBA); 10:25 fraud-svc scaled to 6 replicas, manual (on-call); 10:40 fraud_check_sync OFF (payments team).",
        "Slack (Lisbon): 09:51 alertmanager [FIRING] confirm 5xx>10% (edge); 09:53 Rui confirms 503 at edge, cart/browsing fine; 09:58 Sofia suspects CDN Brotli; 10:03 fraud-svc CPU high; 10:07 Tiago blames DB failover; 10:09 Marta (DBA): failover was planned for 10:05, ~20 s, db-b primary; 10:14 Tiago still blames DB; 10:20 fraud-svc ~99% CPU on 2 pods; 10:25 scaled to 6; 10:31 better but still failing; 10:36 Ines (payments): v5.2 went out at 09:36 with a sync fraud check (3 s timeout), turning flag off; 10:40 flag OFF; 10:44 errors gone; 11:20 Rui: resolved, keeping an eye on it.",
        "HAProxy edge-01 and edge-02 (UTC, edge-02 clock ~95 s fast), 08:20-10:00 UTC (edge-02's lines are logged 95 s late relative to edge-01): be_payments (/api/checkout/confirm), be_checkout, be_cart, be_static. Only confirm has 503s (Tr ~3.0-3.2 s). 502 SH-- on confirm and checkout only during 09:05:10-09:05:31 UTC.",
        "payments-gw IIS (UTC): /v1/payments/confirm (status 200/503, 503s take ~3 s; 500s only during the DB blip) and /internal/orders/fraud-precheck from orders-worker (200/504). The 504s are internal calls; their customer outcome is not in the evidence.",
        "Grafana fraud-svc (Lisbon): replicas 2 until 10:24, 6 from 10:25; CPU 22-34% before 09:36, 64-76% from 09:36, 97-99% with p95 3000 ms from 09:42 to 10:24, 80-90% from 10:25, 22-34% after 10:40; rps x4 from 09:36, x2.3 more from 09:40; timeouts per minute drop after the scale-up but reach 0 only at 10:40.",
        "Grafana checkout-svc (Lisbon): confirm_rps roughly doubles from 09:40 (campaign); confirm_5xx_pct high from 09:43, lower after 10:25, 0 after 10:40.",
        "Grafana orders-db (Lisbon): primary db-a until the failover minute, db-b after; errors 38 only in the 10:05 minute; CPU 24-36%.",
        "No customer counts, revenue, refunds, owners, ticket numbers or severity are in the evidence (the campaign's 1.2M recipients is the only customer-related figure).",
    ]
    facts = facts + verbatim(fx, ("changes.md", "slack-notes.md"))
    common = {
        "scenario": "INC-2219, Mon 28 Sep 2026, payment confirmations failing ~09:43-10:40 Lisbon",
        "true_cause": "payments-gw v5.2 (09:36 Lisbon) added a synchronous fraud check (flag fraud_check_sync, 3 s timeout) on the confirm path. fraud-svc had been cut to 2 replicas on Friday (minReplicas 6->2) and the 09:40 campaign doubled traffic, so fraud-svc saturated (~99% CPU, p95 3 s), fraud calls timed out at 3 s and payments-gw returned 503 for confirms. Trigger/enabling change: v5.2 sync check; contributing conditions: replicas cut, campaign traffic. Scaling fraud-svc to 6 at 10:25 only reduced failures (partial mitigation); setting fraud_check_sync OFF at 10:40 ended the impact.",
        "red_herrings": [
            "orders-db failover at 10:05 Lisbon: planned, ~20 s, 23 min after onset, produced 502 SH-- on both confirm and checkout only during the blip (different signature), errors 38 in one minute only.",
            "CDN Brotli at 09:20: static assets only, /static/* stays 200, onset is 23 min later, only the confirm path fails.",
        ],
        "traps": [
            "edge-02 clock runs ~95 s fast: its first confirm 503 is logged ~95 s after edge-01's; correct or exclude it before merging timelines.",
            "UTC logs vs Lisbon (UTC+1) change log, Slack and Grafana.",
            "Edge 503s (customer-facing confirm failures) and payments-gw internal 504s (orders-worker fraud pre-checks) are different stages; adding them into one customer-failure total is wrong.",
            "Only /api/checkout/confirm is materially affected; cart, browsing and static are fine.",
        ],
        "figures": figures,
        "facts_in_evidence": facts,
    }
    keys["inc-2219"] = common
    # Two-turn RCA: turn 1 has edge logs, checkout-svc export, change log, Slack notes; turn 2 adds the rest.
    t1 = os.path.join(base, "inc-2219-t1", "inputs")
    t2 = os.path.join(base, "inc-2219-t2", "inputs")
    for f in ("haproxy-edge-01.log", "haproxy-edge-02.log", "grafana-checkout-svc.csv", "changes.md", "slack-notes.md"):
        os.makedirs(t1, exist_ok=True)
        shutil.copy(os.path.join(fx, f), os.path.join(t1, f))
    for f in ("payments-gw-iis.log", "grafana-fraud-svc.csv", "grafana-orders-db.csv"):
        os.makedirs(t2, exist_ok=True)
        shutil.copy(os.path.join(fx, f), os.path.join(t2, f))
    keys["inc-2219-twoturn"] = {**common, "turn1_inputs": "edge logs, checkout-svc export, change log, Slack notes only (no IIS, fraud-svc or orders-db data)",
                                "turn1_expectation": "Turn 1 cannot confirm the cause: payments-gw/fraud-svc involvement (v5.2 sync check) is a candidate below 'confirmed', and the missing gateway, fraud-svc and DB evidence is named. The edge-02 skew is already detectable in turn 1."}
    # Postmortem inputs: record, RCA summary, change log, Slack, Grafana (no raw logs needed).
    pm = os.path.join(base, "inc-2219-pm", "inputs")
    for f in ("changes.md", "slack-notes.md", "grafana-fraud-svc.csv", "grafana-checkout-svc.csv", "grafana-orders-db.csv"):
        os.makedirs(pm, exist_ok=True)
        shutil.copy(os.path.join(fx, f), os.path.join(pm, f))
    write(os.path.join(pm, "incident-record.md"), f"""# INC-2219 incident record

- Title: Payment confirmations failing
- Status: Resolved
- Detected: 2026-09-28 09:51 Lisbon (alert: confirm 5xx > 10%)
- Incident lead: Rui (on-call SRE)
- Resolved: 2026-09-28 11:20 Lisbon (declared after monitoring)
- Services: payments-gw, fraud-svc, checkout (confirm path)

## SLO

Payment confirmation success: {slo}% of confirmation requests succeed (event-based SLI, measured at the edge), per calendar month. September volume forecast: {monthly_volume:,} confirmations.
""")
    write(os.path.join(pm, "rca-summary.md"), f"""# INC-2219 investigation summary (RCA)

**Confidence: strongly supported** (not confirmed: no controlled re-test of the v5.2 path under load yet).

- Trigger / enabling change: payments-gw v5.2 (09:36) added a synchronous fraud check before confirm, behind flag `fraud_check_sync` (default ON), 3 s timeout.
- Contributing conditions: fraud-svc `minReplicas` cut 6 -> 2 on Fri 25 Sep; "Autumn sale" campaign at 09:40 roughly doubled confirm traffic.
- Mechanism: fraud-svc saturated (~99% CPU on 2 replicas, p95 3 s); fraud calls hit the 3 s timeout; payments-gw returned 503 on confirm.
- Ruled out: orders-db failover at 10:05 (planned, ~20 s, after onset, 502 signature on all paths during the blip only); CDN Brotli at 09:20 (static assets only).
- Impact (edge logs, both edges, edge-02 clock corrected by -95 s), 09:42:52-10:40:00: {failed:,} of {tot:,} confirmation requests failed ({100 * failed / tot:.1f}%): {f503:,} x 503 and {f502} x 502 during the DB failover blip. Internal fraud pre-check 504s on payments-gw ({iis_stats['precheck_504']}) are not customer requests and are not counted.
- Mitigation: fraud-svc scaled to 6 replicas at 10:25 reduced failures (partial). Restoration: `fraud_check_sync` OFF at 10:40; errors gone by 10:44.
- Open questions: why v5.2 shipped with the flag ON by default; whether HPA should have scaled fraud-svc on its own; customer outcome of failed confirms (retries, abandoned orders) not measured.
""")
    pm_facts = common["facts_in_evidence"] + [
        f"incident-record.md: INC-2219 'Payment confirmations failing', status Resolved; detected 09:51 Lisbon (alert confirm 5xx > 10%); incident lead Rui (on-call SRE); resolved 11:20 Lisbon (declared after monitoring); services payments-gw, fraud-svc, checkout (confirm path). SLO {slo}% of confirmation requests succeed (event-based SLI measured at the edge) per calendar month; September forecast {monthly_volume:,} confirmations.",
        f"rca-summary.md: confidence strongly supported (no controlled re-test of the v5.2 path under load yet); trigger v5.2 sync fraud check (flag default ON, 3 s); contributing: minReplicas 6->2 on Fri 25 Sep, campaign at 09:40 roughly doubled confirm traffic; mechanism: fraud-svc ~99% CPU on 2 replicas, p95 3 s, calls hit 3 s timeout, payments-gw returned 503; ruled out DB failover and CDN Brotli; impact {failed:,} of {tot:,} ({100 * failed / tot:.1f}%): {f503:,} x 503 and {f502} x 502; {iis_stats['precheck_504']} internal pre-check 504s not counted; mitigation scale-up 10:25 partial, restoration flag OFF 10:40, errors gone 10:44; open questions: why v5.2 shipped with the flag ON by default, whether HPA should have scaled fraud-svc on its own, customer outcome of failed confirms not measured.",
    ]
    pm_facts = common["facts_in_evidence"] + verbatim(pm, ("incident-record.md", "rca-summary.md"))
    keys["inc-2219-pm"] = {**common, "facts_in_evidence": pm_facts, "postmortem_expectations": [
        f"Cause matches the RCA summary and keeps confidence 'strongly supported' (not upgraded to confirmed).",
        f"Impact: {failed:,} of {tot:,} failed confirmations ({100 * failed / tot:.1f}%), or {f503:,} 503s with the same denominator.",
        f"Error budget from the event-based SLI: allowed failures {allowed:,} ({monthly_volume:,} x 0.5%); consumed ~{100 * failed / allowed:.1f}% by {failed:,} (or ~{100 * f503 / allowed:.1f}% by 503s only); not from duration.",
        "Time to detect from a stated impact start: 09:42:52 (or ~09:43) to 09:51 = ~8 min; no MTTR label for a single incident.",
        "Partial mitigation (scale-up 10:25) is distinguished from restoration (flag off 10:40).",
        "Action items do not invent owners or due dates (to be assigned / proposed is fine).",
    ]}


def inc_live(keys):
    keys["inc-live"] = {
        "scenario": "Live checkout 5xx incident, prompt-only (no files)",
        "true_cause": "Unknown at this point. checkout-svc v2.31 (deployed 13:58) is a candidate hypothesis only; DB CPU 30% is reported by Marta; DB pool graphs are being checked by Rui.",
        "red_herrings": [],
        "figures": {"error_rate": "~12% of POST /api/checkout", "edges": "edge-01 and edge-02", "start": "~14:05 Lisbon", "window": "14:05-14:20, still ongoing", "deploy": "checkout-svc v2.31 at 13:58", "db_cpu": "30% (Marta, DBA)"},
        "facts_in_evidence": [
            "Since about 14:05 Lisbon the checkout API returns 5xx; Grafana: ~12% of POST /api/checkout failing on edge-01 and edge-02 (window 14:05-14:20, still ongoing).",
            "checkout-svc v2.31 deployed at 13:58. Payments provider status page green.",
            "Rui is on call, checking DB pool graphs. Marta (DBA) says DB CPU is 30%. No customer comms sent yet. Gabriel is the incident lead.",
            "Nothing else: no customer counts, revenue, severity, ETA, rollback decision, ticket numbers or other owners.",
        ],
    }


if __name__ == "__main__":
    out, keydir = sys.argv[1], sys.argv[2]
    shutil.rmtree(os.path.join(out, "fixtures"), ignore_errors=True)
    keys = {}
    inc_small(out, keys)
    inc_2219(out, keys)
    inc_live(keys)
    os.makedirs(keydir, exist_ok=True)
    for k, v in keys.items():
        with open(os.path.join(keydir, f"{k}.json"), "w") as f:
            json.dump(v, f, indent=1, ensure_ascii=False)
            f.write("\n")
    print(json.dumps({k: v.get("figures", {}) for k, v in keys.items() if k in ("inc-small", "inc-2219")}, indent=1)[:3000])
