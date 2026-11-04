# Evidence inventory and incremental preparation

Use `scripts/evidence_inventory.ts` (run from the `rca-investigation` skill folder) when comparing supplied evidence with an earlier intake or identifying exact duplicate files. It needs only Bun and reads only explicitly listed files. It streams hashes so large exports need not fit in memory, and hashes several large files in parallel. Fingerprints and source IDs are identical to the earlier Python helper, so its inventories remain valid `--previous` input. Originals and previous inventories are never modified.

```sh
bun scripts/evidence_inventory.ts --config /case/preparation-config.json --previous /case/inventory-v1.json /case/haproxy.log /case/iis.log
```

The JSON result goes to stdout; save it separately as a new derivative if needed. Exit 0 means supplied files were fingerprinted; exit 1 means at least one source was unreadable or changed during reading (the partial JSON is still returned); exit 2 means invalid arguments, configuration or prior inventory. Exit 0 does not establish usable log content or continuous coverage.

Configuration is a JSON object recording relevant assumptions and methods, for example:

```json
{"timezone":"UTC","timezone_basis":"export documentation","incident_window":["2026-09-16T12:00:00Z","2026-09-16T13:00:00Z"],"filter":null,"parser_version":"w3c-v1"}
```

Specify all assumptions that affect processing. If configuration changes, unchanged supplied files are conservatively marked for reprocessing. Omitting `--config` uses an empty object; it does not infer prior configuration. This first version cannot identify narrower dependencies between a changed assumption and individual extracts.

Each source gets an ID derived from its absolute supplied path and a separate SHA256 content fingerprint. Renaming a file therefore appears as added plus missing, while identical content is reported as a duplicate group. Relative paths are made absolute; symlink aliases remain separate path identities and may appear as duplicate content. Changed files retain their path identity. Treat exact duplicates as the same bytes, not corroboration from independent sources.

The plan marks added, changed, unchanged, missing or unknown content. Missing means omitted from this invocation's file list, not deleted. Pass the full current intake file list when comparing inventories. `candidate_reuse` means unchanged bytes and configuration only: verify prior extracts, provenance and method validity before actually reusing preparation. Hashes cannot establish authenticity, parsing success, time coverage, overlapping exports, or preservation of a causal conclusion. No extracts are reused or deleted by this helper.

File metadata is checked before and after hashing to detect normal concurrent changes or replacement. Unstable files receive no accepted content fingerprint; retry against a stable supplied copy. This is a consistency check, not a forensic guarantee against undetectable concurrent manipulation.
