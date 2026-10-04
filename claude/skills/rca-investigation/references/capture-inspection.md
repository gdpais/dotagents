# Capture usability inspection

Use `bun scripts/inspect_capture.ts INPUT --timeout 60` for supplied packet captures when packet availability or file readability is uncertain. Requires locally available Wireshark `capinfos`; it installs nothing and performs no collection or conversion. Output is JSON on stdout. Exit 0 means usable or partial; exit 2 means unusable or not inspected. Inspect the status and reason even after exit 0.

The helper asks capinfos to scan the capture, reports its exit status, packet count and first/last timestamps as Unix epoch seconds (retaining the reported fractional precision). It disables capture and packet comment output. A successful scan with nonzero packets supports further packet inspection; it does not establish complete payloads, uninterrupted coverage, incident overlap, decryptability, HTTP visibility, request attribution or cause. Follow up with targeted packet inspection for those questions. Capture clock accuracy remains unverified.

Zero packets is unusable. A failed reader is unusable for this validation even if the reader prints a partial count; the original may still contain recoverable records. Missing tooling, missing files, unsupported ETL, timeout or unrecognized output are not inspected. Missing/invalid timestamp ranges and reader warnings produce partial status.

ETL is intentionally unsupported. Prior PktMon evidence contained metadata without usable packet payloads; conversion alone could produce an empty capture. Obtain an appropriate packet-bearing export through the investigation's normal collection process, then verify the output rather than assuming conversion succeeded. Do not infer that every ETL lacks packets.

The command reads one explicit source, never edits it, and makes no network calls. Save JSON only in the chosen derivative directory if a persistent preparation record is useful. Source paths and reader diagnostics can contain sensitive identifiers; review before including in a broader report.
