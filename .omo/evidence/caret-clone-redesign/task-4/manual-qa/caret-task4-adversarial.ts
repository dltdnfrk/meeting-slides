// Adversarial probes for the Todo 4 fixture harness. Temporary; deleted after evidence.
import { fixtureById } from "/Users/hyunjun/Documents/MUNI/meeting-slides/tests/fixtures/caret-ui-states.ts";
import {
  CaretFixtureTimeoutError,
  createCaretBrowserDriver,
} from "/Users/hyunjun/Documents/MUNI/meeting-slides/tests/helpers/caret-browser-driver.ts";
import type { CaretUiFixture } from "/Users/hyunjun/Documents/MUNI/meeting-slides/tests/fixtures/caret-ui-states.ts";

const driver = await createCaretBrowserDriver();
const results: Record<string, unknown> = {};

const fail = (error: unknown) => (error instanceof CaretFixtureTimeoutError
  ? { kind: error.name, missingState: error.missingState, capturedStale: error.capturedStale, timeoutMs: error.timeoutMs }
  : { kind: "Error", message: error instanceof Error ? error.message : String(error) });

try {
  // 1. malformed_input: a message with an unknown type must never satisfy a state.
  const malformed: CaretUiFixture = {
    ...fixtureById("live-capturing"),
    id: "probe-malformed-message",
    events: [
      { message: { type: "not-a-real-type" } as never, awaitState: "capture:capturing" },
    ],
  };
  results.malformedMessage = await driver.captureState(malformed, { timeoutMs: 1_500 })
    .then(() => ({ unexpected: "capture succeeded" }), fail);

  // 2. malformed_input: an unknown await state must be a hard typed error, not a hang.
  const unknownState: CaretUiFixture = {
    ...fixtureById("live-capturing"),
    id: "probe-unknown-state",
    events: [{ message: { type: "detect", detecting: true }, awaitState: "totally:bogus" as never }],
  };
  results.unknownAwaitState = await driver.captureState(unknownState, { timeoutMs: 1_500 })
    .then(() => ({ unexpected: "capture succeeded" }), fail);

  // 3. malformed_input: a click target that does not exist must fail loudly.
  const badClick: CaretUiFixture = {
    ...fixtureById("empty-library"),
    id: "probe-missing-click-target",
    events: [{ click: "#does-not-exist", awaitState: "capture:idle" }],
  };
  results.missingClickTarget = await driver.captureState(badClick, { timeoutMs: 1_500 })
    .then(() => ({ unexpected: "capture succeeded" }), fail);

  // 4. stale_state: a fresh page must never inherit the previous fixture's DOM.
  await driver.captureState(fixtureById("live-capturing"));
  const afterLive = await driver.captureState(fixtureById("empty-library"));
  results.noStaleCarryOver = {
    meetingTitles: afterLive.state.meetingTitles,
    transcriptLines: afterLive.state.transcriptLines,
    slideTitle: afterLive.state.slideTitle,
    capturing: afterLive.state.capturing,
  };

  // 5. flaky_tests: five consecutive captures of the same fixture must agree.
  const hashes: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    hashes.push((await driver.captureState(fixtureById("library-transcript"))).hash);
  }
  results.repeatedRuns = { hashes, stable: new Set(hashes).size === 1 };

  // 6. misleading_success_output: the failure probe must not return a capture object.
  const preSubscription: CaretUiFixture = {
    ...fixtureById("live-capturing"),
    id: "probe-pre-subscription-slide",
    events: [{ message: { type: "slide", current: null, history: [] }, awaitState: "capture:capturing" }],
  };
  results.preSubscriptionSlide = await driver.captureState(preSubscription, { timeoutMs: 1_500 })
    .then((capture) => ({ unexpected: "capture returned", hash: capture.hash }), fail);
} finally {
  await driver.close();
}

console.log(JSON.stringify(results, null, 2));
