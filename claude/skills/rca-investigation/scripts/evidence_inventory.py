#!/usr/bin/env python3
"""Read-only source fingerprints and conservative incremental preparation plan."""
import argparse
import hashlib
import json
import os
import stat
import sys

VERSION = 1


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=True, allow_nan=False).encode()).hexdigest()


def identity(path):
    return "src-" + hashlib.sha256(os.fsencode(path)).hexdigest()


def snapshot(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def inspect_file(path):
    result = {"source_id": identity(path), "path": path,
              "inspection": "fingerprint_only", "content_sha256": None}
    try:
        before = os.stat(path)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("Not a regular file")
        digest = hashlib.sha256()
        count = 0
        with open(path, "rb") as stream:
            opened = os.fstat(stream.fileno())
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
                count += len(chunk)
            after_fd = os.fstat(stream.fileno())
        after_path = os.stat(path)
        result.update(size_bytes=before.st_size, bytes_read=count)
        if not (snapshot(before) == snapshot(opened) == snapshot(after_fd)
                == snapshot(after_path)) or count != before.st_size:
            result.update(status="unstable", error="Source changed during read; retry on a stable copy")
        else:
            result.update(status="fingerprinted", content_sha256=digest.hexdigest())
    except (OSError, ValueError) as exc:
        result.update(status="unreadable", error=str(exc))
    return result


def validate_previous(previous):
    if not isinstance(previous, dict) or previous.get("schema_version") != VERSION:
        raise ValueError("Previous inventory has an unsupported schema_version")
    if not isinstance(previous.get("configuration"), dict):
        raise ValueError("Previous inventory configuration must be an object")
    if previous.get("configuration_fingerprint") != fingerprint(previous["configuration"]):
        raise ValueError("Previous inventory configuration fingerprint is inconsistent")
    sources = previous.get("sources")
    if not isinstance(sources, list):
        raise ValueError("Previous inventory sources must be a list")
    seen = set()
    for item in sources:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("Invalid previous source record")
        sid = identity(item["path"])
        if item.get("source_id") != sid or sid in seen:
            raise ValueError("Invalid or duplicate previous source identity")
        seen.add(sid)
        digest = item.get("content_sha256")
        if item.get("status") == "fingerprinted" and (
                not isinstance(digest, str) or len(digest) != 64 or
                any(c not in "0123456789abcdef" for c in digest)):
            raise ValueError("Invalid previous content fingerprint")


def inventory(paths, configuration=None, previous=None):
    configuration = {} if configuration is None else configuration
    if not isinstance(configuration, dict):
        raise ValueError("Configuration must be a JSON object")
    config_hash = fingerprint(configuration)
    if previous is not None:
        validate_previous(previous)
    old = {s["source_id"]: s for s in previous["sources"]} if previous else {}
    config_changed = previous is not None and previous["configuration_fingerprint"] != config_hash
    sources = []
    seen_paths = set()
    for supplied in paths:
        path = os.path.abspath(os.fspath(supplied))
        if path in seen_paths:
            continue
        seen_paths.add(path)
        record = inspect_file(path)
        prior = old.pop(record["source_id"], None)
        if record["status"] != "fingerprinted":
            change, action = "unknown", "retry_inspection"
        elif prior is None:
            change, action = "added", "prepare"
        elif prior.get("status") != "fingerprinted":
            change, action = "unknown", "prepare"
        elif prior["content_sha256"] != record["content_sha256"]:
            change, action = "changed", "reprocess"
        else:
            change = "unchanged"
            action = "reprocess" if config_changed else "candidate_reuse"
        record.update(change=change, preparation_action=action)
        sources.append(record)
    for prior in old.values():
        sources.append({"source_id": prior["source_id"], "path": prior["path"],
                        "status": "not_supplied", "change": "missing",
                        "preparation_action": "review_scope", "content_sha256": None})
    duplicates = {}
    for source in sources:
        if source.get("content_sha256"):
            duplicates.setdefault(source["content_sha256"], []).append(source["source_id"])
    groups = [ids for ids in duplicates.values() if len(ids) > 1]
    return {"schema_version": VERSION, "configuration": configuration,
            "configuration_fingerprint": config_hash, "configuration_changed": config_changed,
            "sources": sources, "duplicate_content_groups": groups,
            "limitations": [
                "Fingerprinting does not verify parsing, event coverage, authenticity or derivative validity.",
                "candidate_reuse requires checking prior derivatives and recorded methods before reuse.",
                "missing means absent from the supplied list, not proven deleted from disk.",
                "Duplicate bytes are not independent evidence; overlapping exports with different bytes are not detected.",
                "Configuration changes conservatively reprocess all supplied unchanged sources; record timezone, filters, incident window and parser version in configuration."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", help="Explicit source paths; directories are not traversed")
    parser.add_argument("--previous", help="Previous JSON inventory")
    parser.add_argument("--config", help="JSON object containing preparation assumptions and method versions")
    args = parser.parse_args()
    try:
        previous = None
        config = {}
        if args.previous:
            with open(args.previous, encoding="utf-8") as stream:
                previous = json.load(stream)
        if args.config:
            with open(args.config, encoding="utf-8") as stream:
                config = json.load(stream)
        result = inventory(args.files, config, previous)
    except (OSError, ValueError, TypeError) as exc:
        parser.error(str(exc))
    json.dump(result, sys.stdout, indent=2, ensure_ascii=True, allow_nan=False)
    sys.stdout.write("\n")
    return 1 if any(s["status"] in ("unreadable", "unstable") for s in result["sources"]) else 0


if __name__ == "__main__":
    sys.exit(main())
