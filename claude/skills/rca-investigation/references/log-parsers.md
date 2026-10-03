# Log normalization helper

Use `scripts/parse_logs.py` for supplied text evidence whose schema matches the supported formats below. It uses Python 3.9+ standard library and an installed IANA timezone database. It streams JSONL to stdout and bounded error codes, physical line locators and counts to stderr. It never opens an output file or changes the source. Choose a fresh derivative destination outside original evidence; do not redirect stdout onto the source. Derivatives retain potentially sensitive fields, including query strings, cookies and messages: treat them with the same access restrictions as the originals, and redact separately when preparing a shareable summary.

## Supported inputs

- IIS **W3C text** logs: reads each `#Fields:` header, including changes mid-file. Requires date/time fields and exact row width. Custom fields are preserved as strings. This does not parse IIS native comma-separated logging, binary logs or spreadsheets. Verified unmodified IIS W3C event timestamps are UTC; pass `--timezone UTC`. Local-time file rollover does not change event timestamp semantics. See [Microsoft logFile documentation](https://learn.microsoft.com/en-us/iis/configuration/system.applicationhost/sites/sitedefaults/logfile/).
- CSV exports: requires exact `--timestamp-column`; default timestamp parsing is ISO 8601, optionally `--timestamp-format` using Python strptime. Select delimiter and encoding explicitly when needed. Preserves all columns and multiline row start/end line numbers. This is a schema-mapped CSV reader, not an OutSystems or Dynatrace native parser: verify the actual export columns and semantics before use. JSON, XLSX, locale-specific numeric conversion and nested vendor formats are unsupported.
- HAProxy standard five-timer HTTP text prefix, with optional syslog prefix. Requires `--haproxy-timing modern` for `TR/Tw/Tc/Tr/Ta`, or `legacy` for `Tq/Tw/Tc/Tr/Tt`, selected from the actual configured format. The bracket timestamp remains raw; its start/accept semantics follow the selected log configuration, not an inferred completion time. Preserves sentinel `-1` and `+` prefixes; they are not ordinary completed durations. Remaining cookie/header/request text is retained in `rest`, without interpreting its variable schema. TCP logs, arbitrary custom log formats and JSON are unsupported. See [HAProxy logging format](https://www.haproxy.com/documentation/haproxy-enterprise/administration/logs/) and verify legacy mappings against the deployment's configuration/manual.

## Invocation

Run from the `rca-investigation` skill directory, replacing synthetic paths and IDs with authorized source paths and stable manifest IDs:

```sh
python3 scripts/parse_logs.py /path/to/iis.log --source-id S1 --format iis --timezone UTC
python3 scripts/parse_logs.py /path/to/export.csv --source-id S2 --format csv --timestamp-column Timestamp --timezone Europe/Lisbon
python3 scripts/parse_logs.py /path/to/haproxy.log --source-id S3 --format haproxy --haproxy-timing modern --timezone UTC
```

Omit `--timezone` when unknown. UTC is then null unless the timestamp carries an explicit offset. A declared timezone means the caller established it; record the basis in the manifest. Ambiguous/nonexistent daylight-saving local times and invalid timestamps retain raw values with null UTC and a reason. No clock correction or matching is performed.

Output records contain source ID/path, physical line range, raw time, UTC when justified, time status, declared zone and observed fields. Exit 0 means traversal completed without rejected structural records; it does **not** establish trustworthy timestamps or continuous observation coverage. Exit 2 means rejection or read failure; earlier JSONL may still be useful as a partial derivative. Inspect the summary's time-status counters and errors. Empty/header-only input can succeed with zero events; it is not usable event evidence. A malformed quoted CSV record stops CSV parsing because its next record boundary is uncertain. Invalid encodings fail rather than silently replacing evidence bytes. Record command/options, source identity, counts and limitations in the manifest. Read-only source hashes and coverage checks are separate helpers/procedures.

Synthetic unit checks:

```sh
python3 -m unittest discover -s tests -p test_parse_logs.py
python3 -m pytest tests   # all helper tests, if pytest is installed
```
