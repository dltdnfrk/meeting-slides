# F4 authoritative scope-fidelity rerun

- Verdict: **PASS**
- Audited target: `b86610058e2cff22319976b23dd6d48282f7d678`
- Target parent: `7123fd986fceb981c358ad1b73531fab6bd8dc16`
- Target tree: `5e9c65aa72f9c59c7ae4554d137a069c56f12bd0`
- Baseline: `921a01513593c0e10181cf01e535a7abe995deb3`
- Product target: `6711ecfcb47f75b1bb22377d97dd551538568ad7`
- Verification carrier at rerun start: `359562a6555dffe7e7a374c4dd1d1f7e57f63079`
- Verified by: `st_019fbef9` / PI session `019fbf06-0e6b-7eb4-a523-21e3ec9f30b2`
- Verified at: `2026-08-01T20:35:00Z`

## Findings

1. **Ancestry and diff integrity pass.** The baseline is the merge base and an ancestor of the target. The range is linear: 36 commits, zero merges, and one parent for the target. `git diff --check 921a015..b866100`, working-tree diff-check, and index diff-check all exit 0.
2. **No product drift follows the final product target.** `git diff --quiet 6711ecf..b866100 -- . ':(exclude).omo'` exits 0. The four commits in that range are evidence/governance-only. The target commit itself contains exactly one governance receipt, T4-T7 receipt pairs, the plan, and the append-only ledger; no product or test path.
3. **Task receipt bindings pass 11/11.** Every T4-T14 `DoneClaim.json` parses, both receipt files are tracked at the target, both files contain the exact immutable result commit, the actual Git parent matches the expected task parent, and each result commit is an ancestor of `b866100`.
4. **Final receipt bindings are coherent.** At immutable target `b866100`, F2/F3 are confirmed and current-parent-bound while F1/F4 are intentionally `rerun-required`; that is the expected pre-rerun governance state. The current evidence carrier has terminal confirmed F1-F4 ledger entries, 15/15 checked plan items, and no non-`.omo` drift from `b866100`.
5. **Prohibited scope is absent.** Semantic scans find zero email/SMTP delivery, external CRM database writes, realtime speaker identity, transcript-wide identity integration, multitenancy, billing, or marketing automation. The plan's broad literal grep has one expected hit: `src/minutes-store-meetings.ts:126` inserts the approved local `crm_person_entity_id` metadata into the local `attendees` table. It is not an external CRM write.
6. **Static checks pass.** Strict project TypeScript and dedicated browser `checkJs` both exit 0. The static checks run against carrier files proven byte-identical to `b866100` outside `.omo`.
7. **Cleanup and staging pass.** The task worktree had zero tracked dirty paths and zero staged paths. All 119 untracked paths were under preserved meeting-minutes evidence. Three closed ignored SQLite runtime files (`meetings.db`, `meetings.db-wal`, `meetings.db-shm`) had no open file handles and were removed; zero task runtime DB artifacts remain. No unrelated evidence was deleted.
8. **Main worktree preservation passes.** Main remains at `921a01513593c0e10181cf01e535a7abe995deb3`; status SHA-256 `0449b9120369b2fa40d76bab57d842702d576ae05aa4705a572f24acc4127bc8`, tracked diff SHA-256 `bbc5b3cae564b3bfe1fad06d873589a6860692ac3361005b27b8df5ae15190e9`, and empty-index SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` are unchanged.

## Evidence

- `07-authoritative-b866-static-scope-diff.txt`
- `08-authoritative-b866-receipt-bindings.txt`
- `09-authoritative-b866-strict-typescript.txt`
- `10-authoritative-b866-browser-checkjs.txt`
- `11-authoritative-b866-preservation-cleanup.txt`
- `receipt-authoritative-b866.json`

## Decision

**PASS.** No scope-fidelity blocker remains. This rerun changed no product, test, plan, or ledger file and required no redundant product commit.
