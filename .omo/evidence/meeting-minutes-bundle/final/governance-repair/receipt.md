# Final governance repair receipt

- Result: READY FOR F1/F4 RERUN
- Audited governance parent: `7123fd986fceb981c358ad1b73531fab6bd8dc16`
- Audited parent tree: `28d739abc56fc90cd358d14d98d858cede1e3635`
- Baseline: `921a01513593c0e10181cf01e535a7abe995deb3`
- Product implementation HEAD: `6711ecfcb47f75b1bb22377d97dd551538568ad7`
- verified_by: `st_019fbeea`
- verified_at: `2026-08-01T20:12:43Z`

## Reconciliation

The parent had all T4-T14 and F1-F4 boxes checked, but its F1/F3/F4 ledger records targeted parent `17d0914`, before the authoritative plan and completion ledger existed in Git. F1 and F4 therefore could not truthfully certify the governance state committed by `7123fd9`. Their earlier `confirmed` ledger events are retained as history and superseded by append-only `rerun-required` events. F1 and F4 are unchecked pending independent reruns against the commit containing this receipt. F2 and F3 remain checked because their product/runtime evidence is unaffected by this receipts-only delta; append-only current-parent binding events distinguish that audited governance state from their immutable product/evidence commits.

T4-T14 remain checked. Their immutable result commits are:

| Task | Result commit |
| --- | --- |
| T4 | `6ec8905e686bd23ee351cfb08795ec2f959d291b` |
| T5 | `dff8ea5bc92bdf454622c29b1748ef21d2300100` |
| T6 | `9b0b79c0f0cfcd5b8169c11bbd8d4fd4c18ce367` |
| T7 | `b12706c2b1099f315f19c6bf528880789be18bbe` |
| T8 | `524292a3a23584bacf6787ccfce3e318293b0e47` |
| T9 | `a29d0d4856e7020edf031317ab9a91f0afa54218` |
| T10 | `94fea038c0ca47e8b32950a8d666550bd9dea448` |
| T11 | `f64fb18c83659dd6732d9481434d8758f98c231a` |
| T12 | `f223c9aa0b3cb24ae01398b9efaaa7a8ea8aeccc` |
| T13 | `0c0d5aa55f4def8f8cd79ee398417b7acf8788d4` |
| T14 | `c2736c81fe6ca04167b4f2ded7e67804226471ce` |

The previously untracked T4-T7 `DoneClaim.json` and `final-receipt.txt` files are included in this repair. T4/T5 identity metadata was normalized to full result hashes; no command result or behavioral claim was changed. T8-T14 immutable receipts remain committed in `67dbb92179e7dd8ba703a2940e69c10c8d56949f`.

## Scope

Only the plan checkbox state, append-only completion ledger, T4-T7 task receipts, and this receipt are in scope. Product source, tests, historical F1-F4 reports, main-worktree files, and unrelated untracked evidence are unchanged. The commit containing this receipt is the required rerun target and must be reported by hash after commit creation; no self-referential hash is fabricated here.
