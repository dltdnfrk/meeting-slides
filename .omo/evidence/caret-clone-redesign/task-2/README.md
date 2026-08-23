# Task 2 — Inventory protected work and obsolete visual layers

Plan: `.omo/plans/caret-clone-redesign.md`, Todo 2 (Wave 1, blocks Todos 6 and 18)
Canonical root: `/Users/hyunjun/Documents/MUNI/meeting-slides`
Mode: **read-only.** No product file was created, edited, staged, reset, restored, formatted, or committed. Every write landed under this directory.

## Deliverables (Todo 2 acceptance criteria)

| Required item | Artifact |
|---|---|
| Canonical boundary receipt | `green/boundary-receipt.json`, `green/boundary-happy.log` |
| Full pre-work Git status | `green/pre-work-status.txt` |
| Protected path/hash table | `green/protected-hashes-before.tsv` (204 paths) |
| Active CSS/script load order | `green/active-load-order.md` |
| Rule-level keep/replace/delete ledger | `green/ledger.md` |
| End-of-task comparison showing zero content change | `green/protected-hashes-after.tsv`, `green/evidence-validation.log` §6 |

## Verification entry points

```bash
cd /Users/hyunjun/Documents/MUNI/meeting-slides

# Happy boundary check (exit 0, writes the receipt)
./.omo/evidence/caret-clone-redesign/task-2/boundary-validator.sh \
  --emit .omo/evidence/caret-clone-redesign/task-2/green/boundary-receipt.json

# Failure boundary check (exit 2, writes nothing)
cd /Users/hyunjun/Documents/MUNI && \
  ./meeting-slides/.omo/evidence/caret-clone-redesign/task-2/boundary-validator.sh --emit /tmp/x.json

# Re-hash protected paths and validate the whole evidence set
cd /Users/hyunjun/Documents/MUNI/meeting-slides
./.omo/evidence/caret-clone-redesign/task-2/regen-hashes.sh \
  > .omo/evidence/caret-clone-redesign/task-2/green/protected-hashes-after.tsv
./.omo/evidence/caret-clone-redesign/task-2/validate-evidence.sh
```

## Files

| Path | Role |
|---|---|
| `boundary-validator.sh` | Canonical-root gate. Exits 2 before any write when cwd, git top-level, or origin is wrong. |
| `validate-evidence.sh` | 6-part evidence validator: artifacts present, receipt matches live repo, failure proof, table shape, ledger paths + cited line ranges resolve, protected content unchanged. |
| `hash-protected.sh` | Emits the path/hash table. Detects macOS `dataless` files and refuses to fake their digest. |
| `regen-hashes.sh` | Deterministic driver producing the table in fixed order/classes. |
| `rulemap.py` | Brace-balanced CSS parser; emits every top-level rule with its line range. |
| `overlap.py` | Measures selectors styled by more than one active layer. |
| `deadcheck.py` | Flags selectors whose class/id tokens appear in no shipped HTML or JS. |
| `green/active-load-order.md` | Stylesheet cascade, script order, token ownership, cumulative-skin measurement, runtime state hooks. |
| `green/ledger.md` | Layer verdicts, the 16 triple-styled selectors, KEEP set, dead-rule DELETE set, dynamic-class exclusions, deletion order constraint. |
| `green/hashing-integrity-note.md` | Why 122 of 204 paths carry metadata identity instead of a content digest. |
| `green/css-rule-map.tsv` | 673 top-level rules with line ranges across the four active layers. |
| `green/layer-overlap.txt` | 566 distinct selectors; 80 multi-layer; 16 triple-layer. |
| `green/unreferenced-selector-candidates.tsv` | Raw static scan feeding ledger §D/§E. |
| `failure/boundary-failure.log` | Probes 1-4: bad-cwd variants and symlink resolution. |
| `failure/adversarial-probes.log` | Probes 5-10: misleading output, generated artifacts, stale state, dirty worktree, write confinement, concurrent siblings. |

## Headline findings

1. **Four stacked skins are measurable, not rhetorical.** 80 of 566 selectors are styled by more than one active layer; 16 are styled by three. `operational-liquid.css` alone re-styles 50 selectors `style.css` already owns.
2. **Deletion order is forced by the token graph.** `operational-liquid.css` defines zero custom properties and resolves 23 tokens from `style.css`; `caret-shell.css`'s `--caret-*` tokens have no external consumer. Liquid must be removed before the `style.css:1377-1960` TIRO block, never after.
3. **The current Caret layer styles a state the runtime never produces.** `caret-shell.css:71-75` targets `.session-item.is-active` / `[aria-current="true"]`, but `app.js:136-137` emits a bare `<li class="session-item">` and puts selection on the inner `.session-row--selected`. The shell has no working active-session affordance today.
4. **122 of 204 protected paths are cloud-evicted.** Reading them returns zero bytes with exit 0, so a naive `shasum` fabricates the empty-string digest. Caught and corrected; see `green/hashing-integrity-note.md`.
5. **The worktree is a moving target.** Wave-1 siblings (Todos 1/3/4/5) write concurrently. `public/index.html` mtime advanced during this task while its SHA-256 stayed fixed, so the unchanged claim is asserted on content, never timestamps.

## Scope boundary

Verdicts in `green/ledger.md` are an inventory, not an instruction executed here. Todo 18 applies the deletions; Todo 6 consumes the attribution when writing the binding `DESIGN.md` contract. Todo 3 owns the binding DOM/protocol manifest — the state hooks listed in `active-load-order.md` §5 are observations only.
