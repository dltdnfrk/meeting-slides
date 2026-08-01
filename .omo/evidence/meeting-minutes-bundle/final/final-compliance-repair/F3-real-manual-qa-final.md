# F3 real manual/adversarial QA - final refresh

- Verdict: PASS
- Audited HEAD: `17d09149bc5248652573142bc6e9ebd2eafcc8fd`
- Product implementation HEAD: `6711ecfcb47f75b1bb22377d97dd551538568ad7`
- verified_by: `st_019fbee5`
- verified_at: `2026-08-01T20:20:00Z`

Fresh sequential real-surface checks at the audited HEAD passed 66/66 (`08-current-head-real-targeted-gates.txt`):

- real Bun server + WebSocket + SQLite review mutation and conclusion;
- malformed, incomplete, out-of-roster, stale-version, rollback, retry, hash-failure, and concurrent-repeat adversarial paths;
- real Chromium review DOM, closed attendee dropdown, edits, rejection/restoration, keyboard access, hostile markup, reconnect, and final confirmation;
- immutable transcript/retranscription, audio hash dedup, recorder startup/stop/failure cleanup;
- vendored Chromium portrait A4 output, first-page decision/action completeness, deterministic shrinking, explicit overflow refusal, and appendix pagination;
- atomic six-output bundle, manifest/hash/byte validation, version-scoped JSONL coordinates, missing-output cleanup, database-finalization retry, and no partial publication.

The earlier comprehensive F3 report at `../f3-manual-qa-rerun/report.md` exercised the complete visible attendee -> capture -> review -> edit/dropdown -> confirm -> six-output bundle flow plus file mode, duplicate audio, retranscription, legacy deck, rollback, and retry. The product tree is unchanged outside `.omo` from that repaired product HEAD through this audited governance HEAD, as proven by `09-current-head-static-scope-pass.txt`.

A copied historical QA driver was also attempted and retained as failed receipts `05`-`07`: it refers to a removed historical schema column and then waits for a pre-remediation review payload shape. Those failures are stale evidence-driver defects, not product failures; current real WS/Chromium tests and the post-remediation comprehensive report supersede it. No product code was changed.
