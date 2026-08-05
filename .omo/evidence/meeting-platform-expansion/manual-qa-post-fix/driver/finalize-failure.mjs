import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import sharp from "sharp";
const ROOT = "/Users/hyunjun/Documents/MUNI/meeting-slides";
const EV = join(ROOT, ".omo/evidence/meeting-platform-expansion/manual-qa-post-fix");
const files = readdirSync(join(EV, "screens")).filter(x => x.endsWith(".png")).sort();
const pngs = [];
for (const file of files) {
  const path = join(EV, "screens", file), bytes = readFileSync(path), meta = await sharp(bytes).metadata();
  const signature = bytes.subarray(0, 8).toString("hex");
  pngs.push({ file: `screens/${file}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), signature, signatureValid: signature === "89504e470d0a1a0a", width: meta.width, height: meta.height, dimensionsValid: Number(meta.width) > 0 && Number(meta.height) > 0 });
}
writeFileSync(join(EV, "artifacts/png-integrity.json"), JSON.stringify({ capturedAt: new Date().toISOString(), count: pngs.length, allValid: pngs.every(x => x.signatureValid && x.dimensionsValid), pngs }, null, 2));
const requirements = [
  [1,"History hydrated; Korean title 논의 remains on one contiguous line","PASS",["screens/t1-02-meeting28-hydrated.png","artifacts/separator-keyboard-aria.json"]],
  [2,"Compiled history hydrated","PASS",["screens/t1-03-meeting43-hydrated-compiled.png","artifacts/track1-results.json"]],
  [3,"Export terminal state and controls recovery","PASS",["screens/t1-07-pdf-export-terminal.png","artifacts/track1-results.json"]],
  [4,"Bad-input terminal recovery","PASS",["screens/t1-08-bad-input-error-recovery.png","artifacts/track1-results.json"]],
  [5,"Provider desktop state after truthful recheck","PASS",["screens/t2-02-settings-desktop-after-recheck.png","artifacts/track2-results.json"]],
  [6,"360px settings open, unclipped, keyboard focus restored","PASS",["screens/t2-08-settings-narrow-360-open.png","artifacts/track2-results.json"]],
  [7,"Provider/model/effort persistence after reload","PASS",["screens/t2-09-settings-after-reload.png","artifacts/track2-results.json"]],
  [8,"Safe connect feedback without optimistic auth","PASS",["screens/t2b-after-connect-clicks.png","artifacts/track2b-connect-results.json"]],
  [9,"STT all four absent","PASS",["screens/t3-01-stt-all-four-absent.png","artifacts/track3-stt-timeline.json"]],
  [10,"STT active progress and hidden partial","PASS",["screens/t3-02-stt-downloading-progress.png","artifacts/track3-stt-timeline.json"]],
  [11,"STT cancelled cleanup","PASS",["screens/t3-03-stt-cancelled-cleanup.png","artifacts/track3-stt-timeline.json"]],
  [12,"Production Small installed, exact size/SHA","PASS",["screens/t3-04-installed-small.png","artifacts/track3-stt-timeline.json"]],
  [13,"Production Medium installed, exact size/SHA","PASS",["screens/t3-04-installed-medium.png","artifacts/track3-stt-timeline.json"]],
  [14,"Production Large v3 Turbo installed, exact size/SHA","PASS",["screens/t3-04-installed-large-v3-turbo.png","artifacts/track3-stt-timeline.json"]],
  [15,"All four installed with STT section visible","NOT-CAPTURED",[]],
  [16,"All-model selection ending at Large v3","NOT-CAPTURED",[]],
  [17,"STT recheck preserves disk truth and selection","NOT-CAPTURED",[]],
  [18,"Post-restart Large v3 selection with 사용 중 visible","NOT-CAPTURED",[]],
].map(([state,name,status,evidence]) => ({state,name,status,evidence}));
writeFileSync(join(EV, "artifacts/requirement-map.json"), JSON.stringify({ stateCount: 18, passed: requirements.filter(x=>x.status==="PASS").length, requirements }, null, 2));
const manifest = {
  taskId: "st_019fc781", revision: "c655ad023a450fa1d29f5c505b305ed50ad2af0c", status: "FAIL_STOPPED_AT_GATE",
  scope: "Fresh post-fix production-app release validation and visual recapture; no product code/tests edited and no commit.",
  releaseValidation: { typescript: "PASS (no output)", tests: "PASS: 188 pass, 0 fail, 669 expect() calls, 33 files, 19.94s; run exactly once", build: "PASS", codesign: "PASS: --deep --strict; designated requirement satisfied", launchHealth: "PASS: launcher 75107 -> server 75121; PID-scoped 127.0.0.1:8787; HTTP 200 and runtime signatures" },
  stopGate: { phase: "STT Large v3 production download", error: "Puppeteer waitForFunction: Waiting failed", evidence: ["artifacts/track3-stt-timeline.json","logs/track3.log"], diskAtStop: { partialFile: ".ggml-large-v3-q8_0.bin.part-75121-22175b43-5d43-40db-bc7a-78243158eb31", partialBytes: 693759223, partialSha256: "35e7c3b6155d0ef610a08e10518c0c1bf7b4794310bf8d5d5cd5aafe7b0da2f9" } },
  pngIntegrity: { path: "artifacts/png-integrity.json", count: pngs.length, allValid: pngs.every(x => x.signatureValid && x.dimensionsValid) },
  requirementMap: "artifacts/requirement-map.json", separatorAria: "artifacts/separator-keyboard-aria.json", cleanupReceipt: "state/cleanup-receipt.txt",
  completion: { passedStates: 14, requiredStates: 18, missingStates: [15,16,17,18] }
};
writeFileSync(join(EV, "final-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ manifest: join(EV,"final-manifest.json"), pngCount: pngs.length, allValid: manifest.pngIntegrity.allValid, passedStates: 14, requiredStates: 18 }, null, 2));
