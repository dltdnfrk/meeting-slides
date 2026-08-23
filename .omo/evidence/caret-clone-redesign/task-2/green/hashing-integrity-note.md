# Hashing integrity note — why 122 protected paths are not content-hashed

Recorded because a naive reading of `protected-hashes-before.tsv` would otherwise treat these rows as weaker evidence than they are, or — worse — treat a fabricated digest as proof.

## Defect found and fixed during this task

The first version of `hash-protected.sh` emitted

```
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

for 118 research artifacts. That value is the SHA-256 of the **empty string**, not of any file. Two independent causes were found:

1. **stdin drain.** `shasum` inside a `while IFS= read -r p` loop inherited and consumed the loop's stdin. Fixed by redirecting `</dev/null` on the `shasum` call.
2. **macOS dataless files (the real cause).** 122 of the 204 protected paths carry the `dataless` file flag — they are cloud-evicted (iCloud) placeholders. `stat` still reports the true logical size, but reading the file returns **zero bytes with exit status 0**. `shasum` therefore reports a valid-looking digest for content it never read.

Verified on `.omo/ulw-research/20260809-065345/final-report.md`:

```
$ ls -laO .omo/ulw-research/20260809-065345/final-report.md
-rw-r--r--@ 1 hyunjun staff hidden,compressed,dataless 14600 Aug 9 08:00 ...
$ wc -c < .omo/ulw-research/20260809-065345/final-report.md
14600
$ head -c 80 .omo/ulw-research/20260809-065345/final-report.md | od -c
(no output - zero bytes readable)
$ shasum -a 256 .omo/ulw-research/20260809-065345/final-report.md
e3b0c44298fc...b855   <- empty-string digest for a 14600-byte file
```

This is precisely the `misleading_success_output` adversarial class: a command exits 0 and prints a well-formed hash that proves nothing.

## Resolution

`hash-protected.sh` now checks `stat -f '%Sf'` before hashing and records dataless files under the distinct identity kind `size+mtime(dataless)`, so no fabricated digest can enter the table.

Forcing content hashes was rejected deliberately: materializing these paths would trigger a multi-GB iCloud download and would *write* to protected trees this task is required not to touch.

## Resulting table composition

| Identity kind | Rows | Meaning |
|---|---|---|
| `sha256` | 82 | true content digest |
| `size+mtime(dataless)` | 122 | cloud-evicted; logical size + mtime identity only |
| **total** | **204** | |

## Coverage where it matters

Every path this task actually reasons about carries a real `sha256`:

- all five active layers (`public/index.html`, `style.css`, `workspace-shell.css`, `operational-liquid.css`, `caret-shell.css`)
- all six active scripts
- all 11 provider/Alibaba dirty files (`src/*.ts`, `.env.example`, `server.ts`, `README.md`, `tests/*.ts`)
- `DESIGN.md`, `HANDOFF.md`, the plan, the draft, `tiro-operator-rebuild.md`

The 122 metadata-only rows are the 118 `.omo/ulw-research` artifacts plus the 4 `models/` weight files — the exact set Todo 2 requires be left untouched and which no later todo reads.

## Strength of the unchanged claim

For the 82 `sha256` rows the before/after comparison is a true content-equality proof. For the 122 dataless rows it proves size and mtime are unchanged, which detects any write that a normal edit would produce (every writer updates mtime) but would not detect a same-size same-mtime forgery. No such vector exists here, since nothing in this task writes outside `.omo/evidence/caret-clone-redesign/task-2/`.
