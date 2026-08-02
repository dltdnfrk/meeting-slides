# Hybrid PPT harness

The Hybrid path has two deliberately separate responsibilities:

- **Live MeetingCard:** transcript detection updates one stable on-screen card with a title, optional kicker, bullets, and optional emphasis. It is optimized for low-latency meeting use and does not switch among compiled slide kinds.
- **Compiled deck:** the explicit **Compile deck** action plans a typed `DeckOutline` from the canonical transcript and live slide anchors. The registry renders `cover`, `section`, `summary`, `decision`, `actions`, and `closing` specs to standalone HTML. Model-provided HTML is rejected.

After a compile is successfully published, deck/PDF/PNG export uses the compiled specs. Before that, export explicitly falls back to the legacy live-slide history. Export requests are rejected with `compile-busy` while compilation is in progress; PDF/PNG continue through the existing validation and visual-review gates.

## Hermetic QA

Run:

```sh
bun test tests/hybrid-path.e2e.test.ts
```

The suite uses a local static/WebSocket server, the real browser client and session state machine, file-backed temporary SQLite, and fake detector/planner implementations. External browser requests are blocked. It verifies live rendering, persisted compiled specs and registry files, export preference/fallback, invalid outlines, compile-busy handling, planner fallback, and rejection of model HTML. Temporary databases and exports are removed after each test.
