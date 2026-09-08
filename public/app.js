import { createAppTransport } from "./app-transport.js";
import { createOperatorSurface } from "./operator-surface.js";
import { createSlidePlanWorkspace } from "./slide-plan-workspace.js";
import { createMeetingWorkspace } from "./meeting-workspace.js";
import { createSettingsPanel } from "./settings-panel.js";
import { createAttendeesPanel } from "./attendees-panel.js";
import { createAskPanel } from "./ask-panel.js";
import { createPublicationController } from "./publication-controller.js";

const caretShell = createOperatorSurface();
let workspace;
let publication;
const transport = createAppTransport({
  onMessage: (message) => workspace.handleMessage(message),
  onStatus: (status) => workspace.handleTransport(status),
});
const slidePlanWorkspace = createSlidePlanWorkspace({
  root: document.querySelector("[data-slide-plan-workspace]"),
  fallback: document.getElementById("current-slide"),
  onChange: () => publication?.syncAvailability(),
});
workspace = createMeetingWorkspace({ transport, caretShell, slidePlanWorkspace });
const settings = createSettingsPanel({ transport, workspace });
const attendees = createAttendeesPanel({ transport, workspace });
const ask = createAskPanel({ transport, workspace });
publication = createPublicationController({ transport, workspace, slidePlanWorkspace, ask });
const reviewPanel = window.createReviewPanel({
  send: transport.send, isOpen: transport.isOpen,
  getMeetingId: () => workspace.selectedMeetingId,
  getNotes: () => workspace.notes,
});
workspace.bindControllers({ settings, attendees, ask, publication, reviewPanel });

// Compatibility probes are outputs only. Product wiring uses the instances above.
Object.defineProperties(window, {
  __caretShell: { value: caretShell },
  __slidePlanWorkspace: { value: slidePlanWorkspace },
  __attendeeState: { get: attendees.snapshot },
});
window.addEventListener("pagehide", () => { transport.close(); workspace.dispose(); });
transport.start();
