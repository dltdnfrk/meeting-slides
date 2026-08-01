import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const existingActions = [
  "startCapture",
  "stopCapture",
  "startReview",
  "reset",
  "setAttendees",
  "status",
  "transcript",
  "exportDeck",
  "exportPdf",
  "exportPng",
  "saveNotes",
  "saveJson",
  "setProvider",
  "connectProvider",
  "setProviderKey",
  "recheckProviders",
] as const;

test("the real WS registry contains executable handlers for every existing action", () => {
  const probe = `
    import { handlerMap } from "./server.ts";
    const actions = ${JSON.stringify(existingActions)};
    const missing = actions.filter((action) => !handlerMap.has(action));
    const nonFunctions = actions.filter((action) => typeof handlerMap.get(action) !== "function");
    console.log(JSON.stringify({ missing, nonFunctions, size: handlerMap.size }));
    process.exit(missing.length || nonFunctions.length ? 1 : 0);
  `;
  const result = spawnSync(process.execPath, ["-e", probe], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      HTTP_PORT: String(19_300 + (process.pid % 500)),
      OPEN_BROWSER: "false",
      LLM_PROVIDER: "cli",
      LLM_CLI_BIN: "/usr/bin/true",
      LLM_CLI_PRESET: "claude",
      WHISPER_INPUT_MODE: "mic",
    },
  });

  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
    missing: string[];
    nonFunctions: string[];
    size: number;
  };
  expect(receipt).toEqual({ missing: [], nonFunctions: [], size: existingActions.length });
});
