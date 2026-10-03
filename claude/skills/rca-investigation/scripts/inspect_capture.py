#!/usr/bin/env python3
"""Read-only capture metadata inspection. No conversion or live capture."""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import subprocess


def inspect_capture(path, timeout=60):
    path = Path(path).resolve()
    result = {"source": str(path), "status": "not inspected", "packet_count": None,
              "first_epoch": None, "last_epoch": None, "tool": None,
              "limitations": ["Observed endpoints do not establish continuous coverage.",
                               "Metadata does not establish HTTP visibility, request identity, or cause."]}
    if not path.is_file():
        result["reason"] = "Input is not a readable regular file."
        return result
    if path.suffix.lower() == ".etl":
        result["reason"] = "ETL is unsupported; obtain a packet-bearing PCAP/PCAPNG export and inspect it. ETL metadata alone does not prove packets exist."
        return result
    tool = shutil.which("capinfos")
    if not tool:
        result["reason"] = "capinfos is unavailable; capture has not been validated."
        return result
    args = [tool, "-c", "-a", "-e", "-S", "-M", "-K", "-P", str(path)]
    result["tool"] = "capinfos"
    result["command"] = args
    try:
        completed = subprocess.run(args, capture_output=True, text=True,
                                   errors="replace", timeout=timeout,
                                   env=dict(os.environ, LC_ALL="C"))
    except (OSError, subprocess.TimeoutExpired) as exc:
        result["reason"] = "Inspection failed: " + str(exc)
        return result
    result["exit_code"] = completed.returncode
    if completed.returncode:
        result["status"] = "unusable"
        result["reason"] = "Reader failed; no successful full-file validation. " + completed.stderr.strip()[:2000]
        return result
    fields = {}
    for line in completed.stdout.splitlines():
        key, separator, value = line.partition(":")
        if separator:
            fields[key.strip()] = value.strip()
    try:
        count = int(fields["Number of packets"])
        if count < 0:
            raise ValueError("negative count")
        result["packet_count"] = count
    except (KeyError, ValueError):
        result["reason"] = "Unrecognized capinfos packet count; validation is incomplete."
        return result
    if count == 0:
        result.update(status="unusable", reason="Zero packets; cannot support packet analysis.")
        return result
    for source, legacy, target in (("Earliest packet time", "First packet time", "first_epoch"), ("Latest packet time", "Last packet time", "last_epoch")):
        try:
            raw = fields.get(source, fields.get(legacy, ""))
            value = float(raw)
            if math.isfinite(value):
                result[target] = raw
        except (KeyError, ValueError):
            pass
    result["status"] = "usable"
    result["reason"] = "Reader successfully scanned packet records; usable for further packet inspection."
    first, last = result["first_epoch"], result["last_epoch"]
    if first is None or last is None or float(first) > float(last):
        result.update(status="partial", reason="Packets exist, but a valid observed timestamp range could not be established.")
    if completed.stderr.strip():
        result["reader_warning"] = completed.stderr.strip()[:2000]
        result.update(status="partial", reason="Reader completed with warnings; inspect warnings before relying on coverage.")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="One supplied capture file")
    parser.add_argument("--timeout", type=int, default=60, help="Reader timeout in seconds (1–600)")
    args = parser.parse_args()
    if not 1 <= args.timeout <= 600:
        parser.error("--timeout must be between 1 and 600")
    result = inspect_capture(args.input, args.timeout)
    print(json.dumps(result, indent=2))
    return 0 if result["status"] in ("usable", "partial") else 2


if __name__ == "__main__":
    raise SystemExit(main())
