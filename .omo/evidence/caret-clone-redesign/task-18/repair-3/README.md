# Todo 18 Repair 3

Status: DONE

Repair 3 replaces declaration/property ownership inference with exclusive selector-root ownership.
Only parsed ordinary-rule and `@scope` preludes are scanned. Declaration bodies, including custom
properties, are opaque. The selector lexer masks comments, quotes, and URL/data payloads; finds
class tokens throughout functional selectors; decodes CSS simple/hex escapes; and compares decoded
identifiers against exact/prefix ownership roots.

## RED

- `red/01-four-is-mutations.txt`: all four required `:is()` mutations fail ownership verification.
- `red/02-adversarial-selector-mutations.txt`: all seven `:where`, `:has`, nested functional,
  comma, escaped identifier, and inter-token-comment mutations fail ownership verification.

## GREEN

- `green/01-benign-lookalikes.txt`: attribute/string/URL/data/custom-property/quoted-brace
  lookalikes pass because values are not ownership selectors.
- `green/04-active-shell-post-url-mask.txt`: 12/12.
- `green/05-claimed-suites-final.txt`: 602/602 across the same 28 claimed files.
- `green/06-typescript-final.txt`: project and strict TypeScript exit 0.
- `green/07-diff-hashes-final.txt`: diff check exits 0; product/docs hashes unchanged.
- `green/08-lsp.txt`: changed file absent from completed LSP scan diagnostics; direct final
  fresh-diagnostic requests timed out at the tool boundary and are recorded explicitly.

No product or documentation bytes changed. Chromium was not rerun. PID 32804 was not polled.
Todo 19 was not entered.
