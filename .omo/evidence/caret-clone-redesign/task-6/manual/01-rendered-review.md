# Manual QA: rendered-Markdown source-of-truth review

One human review pass over the rendered document, not the raw source.

- Render command: `pandoc -f gfm -t html5 --standalone DESIGN.md -o manual/DESIGN.rendered.html`
- Plain read: `pandoc -f gfm -t plain DESIGN.md > manual/DESIGN.rendered.txt`
- Reviewed artifact: `manual/DESIGN.rendered.html` (47 KB) and `manual/DESIGN.rendered.txt`

## What was checked by reading, not by regex

| Question | Result |
| --- | --- |
| Does a reader landing on DESIGN.md know which contract binds? | Yes. Section 9 opens by naming itself the single active contract and points at section 10 for history. |
| Can a reader mistake section 10 for a live rule? | No. It opens with "Nothing in this section is an active rule" and each bullet is tagged `(superseded)`. |
| Do all 8 tables render with aligned columns? | Yes. Structural pass over section 9/10 found zero inconsistent pipe counts. |
| Do inline code spans close? | Yes. Zero lines with an odd backtick count. |
| Are subsections numbered in order? | Yes. 9.1 through 9.17, monotonic. |
| Is every measured value attributed? | Yes. 9.5 and 9.6 carry a Source column or an inline occurrence count from the task-1 manifest. |
| Does the deck system (sections 1-8) still read as independent? | Yes. Section 9 states the boundary in its first paragraph; the stale operator font debt row in section 8 now points to 9.17. |
| Does prose contain em dashes or AI filler? | No. Scan in `green/03-anti-slop-scan.txt` returns zero matches for both. |

## Defects found by reading and fixed

1. **Tone defect.** The 9.1 lead read "The reference is measured, not vibed." Too casual for a
   binding contract that downstream tasks quote. Rewritten to "Every value below is measured,
   not asserted from taste."
2. **Stale cross-section claim.** Section 8's Accepted Debt table still listed a network-loaded
   operator font (General Sans via Fontshare), which contradicts the vendored-font rule.
   Replaced with a pointer so the deck table no longer carries an operator-surface rule.
3. **Wrong shipped font location (repair pass).** 9.2 named `public/assets/fonts/`. Todo 9
   actually vendors to `public/fonts/`, served same-origin from `/fonts/`, and vendors
   Pretendard alongside Figtree and DM Mono. Corrected to the real path, the real serve origin,
   and the real receipt file `public/fonts/font-manifest.json`, with Pretendard listed as
   vendored rather than as a fallback-only face.

## Second read after the font-path repair

Re-rendered and re-read the three changed passages in `DESIGN.rendered.txt`:

| Question | Result |
| --- | --- |
| Does 9.2 now match what Todo 9 shipped? | Yes. `public/fonts/`, `/fonts/`, and the manifest name match `ls public/fonts/` and the five `url("/fonts/…")` sources in `public/caret-foundation.css`, recorded in `green/04-font-path-agreement.txt`. |
| Do the deck CDN rows still contradict the operator rule? | No. The 9.17 row is now scoped "deck authoring view only" and points at 9.2 for the operator surface, so a reader cannot read a deck CDN allowance as an operator allowance. |
| Does the section 8 pointer still name the right subsection? | Yes. It points at 9.2, where the vendoring rule actually lives, instead of 9.5. |

## Residual reader risk

Section 9.9 states the 900px split-to-stack seam under "Seam rules" rather than as a row in the
viewport table. A reader skimming only the table sees six widths and no seam. Accepted: the
seam is a rule about behavior between widths, not a width, and Todo 12 asserts it directly.
