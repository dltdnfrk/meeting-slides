# Task 5 evidence

Implemented the batch deck planner and canonical persistence only.

- Planner inputs: complete stored transcript lines and live slide anchors.
- Model contract: HTTP and CLI providers implement `DeckPlanner`; prompt requests typed JSON and forbids HTML.
- Validation: `parseDeckOutline` plus per-spec parsing on persistence, meeting/narrative checks, and explicit model-HTML rejection.
- Recovery: one repair attempt, then deterministic cover + transcript summary chunks + closing fallback.
- Persistence: additive `deck_outlines` metadata and ordered `deck_slide_specs`; rendered HTML is not stored.
- Hermetic tests: injected fake planner, repair, invalid-output fallback/error persistence, validation rejection, and SQLite reopen round-trip.

No server compile action, client control, live session changes, deck rendering, or minutes-bundle work was added.
