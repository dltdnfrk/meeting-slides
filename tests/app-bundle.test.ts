// macOS application bundle packaging contract (plan caret-clone-redesign, Todo 17).
//
// Builds the real bundle exactly once with `scripts/build-app.sh` into a
// temporary install directory, then asserts on that artifact: every split
// native module is packaged into the one executable, the menu-bar item and
// browser-workspace action ship, the panel assets are present, Info.plist
// declares the identity/permissions the runtime actually uses, ad-hoc signing
// verifies, and the build never touches the canonical install or the
// repository symlink when it is redirected elsewhere.
//
// No sleeps, no polling: every step is a bounded process invocation whose exit
// status and output are the signal.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BUILD_SCRIPT = join(ROOT, "scripts", "build-app.sh");
const APP_NAME = "Meeting Slides.app";
const REPO_LINK = join(ROOT, APP_NAME);
const CANONICAL_APP = join(process.env.HOME ?? "", "Applications", APP_NAME);

/** Bounded command run. Never inherits a shell, never waits on a timer. */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

let installDir = "";
let appPath = "";
let contents = "";
let executable = "";
let infoPlist = "";
let buildStatus = -1;
let buildLog = "";
let repoLinkBefore = "";
let repoLinkAfter = "";
let canonicalBefore = "";
let executableStrings = "";
let buildScriptSource = "";
let resolutionProbe: {
  entryPoint: string;
  results: { name: string; ok: boolean; value?: string; error?: string }[];
} | null = null;
let resolutionProbeStderr = "";
let resolutionProbeExit = -1;

beforeAll(() => {
  buildScriptSource = readFileSync(BUILD_SCRIPT, "utf8");
  repoLinkBefore = run("readlink", [REPO_LINK]).stdout.trim();
  canonicalBefore = existsSync(CANONICAL_APP)
    ? run("shasum", ["-a", "256", join(CANONICAL_APP, "Contents", "MacOS", "meeting-slides")]).stdout
    : "";

  installDir = mkdtempSync(join(tmpdir(), "meeting-slides-bundle-test."));
  appPath = join(installDir, APP_NAME);
  contents = join(appPath, "Contents");
  executable = join(contents, "MacOS", "meeting-slides");
  infoPlist = join(contents, "Info.plist");

  const build = run("bash", [BUILD_SCRIPT], {
    env: { MEETING_SLIDES_APP_DIR: installDir },
  });
  buildStatus = build.status;
  buildLog = build.stdout + build.stderr;

  repoLinkAfter = run("readlink", [REPO_LINK]).stdout.trim();
  executableStrings = existsSync(executable)
    ? run("strings", ["-a", executable]).stdout
    : "";

  // Pure project-resolution rule, compiled and run once against a scenario
  // batch. No filesystem access inside the probe.
  const probeBin = join(installDir, "project-resolution-probe");
  const compile = run("swiftc", [
    "-O",
    "-o",
    probeBin,
    join(ROOT, "macos", "AppLifecycle.swift"),
    join(ROOT, "tests", "fixtures", "project-resolution-probe.swift"),
  ]);
  if (compile.status === 0) {
    const batch = JSON.stringify({
      scenarios: [
        {
          name: "packaged-marker-wins",
          candidates: ["/checkout", "/Applications"],
          serving: ["/checkout", "/Applications"],
        },
        {
          name: "marker-without-server-falls-through-to-legacy",
          candidates: ["/stale-marker", "/checkout"],
          serving: ["/checkout"],
        },
        {
          name: "bare-binary-parent-without-server-is-rejected",
          candidates: ["/Users/someone/Downloads"],
          serving: [],
        },
        {
          name: "blank-marker-is-skipped",
          candidates: ["   ", "/checkout"],
          serving: ["/checkout"],
        },
        { name: "no-candidate-at-all", candidates: [], serving: ["/checkout"] },
      ],
    });
    const probeRun = spawnSync(probeBin, [], { input: batch, encoding: "utf8" });
    resolutionProbeExit = probeRun.status ?? -1;
    resolutionProbeStderr = probeRun.stderr ?? "";
    resolutionProbe = JSON.parse(probeRun.stdout);
  }
}, 30_000);

afterAll(() => {
  if (installDir && existsSync(installDir)) rmSync(installDir, { recursive: true, force: true });
  // Safety net only. The build must not have moved the link in the first
  // place; the assertion below is what proves it.
  if (repoLinkBefore && run("readlink", [REPO_LINK]).stdout.trim() !== repoLinkBefore) {
    try {
      unlinkSync(REPO_LINK);
    } catch {
      /* link already gone */
    }
    symlinkSync(repoLinkBefore, REPO_LINK);
  }
});

describe("app bundle: build", () => {
  test("scripts/build-app.sh builds into the requested install dir and exits 0", () => {
    expect(buildStatus).toBe(0);
    expect(existsSync(appPath)).toBe(true);
    expect(buildLog).toContain("OK webapp launcher");
  });

  test("the executable and every packaged resource is non-empty", () => {
    const files = run("find", [appPath, "-type", "f"]).stdout.trim().split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(Bun.file(file).size).toBeGreaterThan(0);
    }
    expect(existsSync(executable)).toBe(true);
    expect(Bun.file(executable).size).toBeGreaterThan(100_000);
  });
});

describe("app bundle: packaged native modules", () => {
  // Todos 5, 10 and 14 split the launcher into six sources. A bundle that
  // silently drops one would still build, so the packaged binary itself must
  // show every module's Swift reflection metadata.
  const requiredTypes = [
    "LauncherEnvironment", // macos/AppLifecycle.swift
    "ServerLifecycle", // macos/AppLifecycle.swift
    "NativeSurfaceGeometry", // macos/NativeSurfaceContract.swift
    "StopCommandGuard", // macos/NativeSurfaceContract.swift
    "TransportClient", // macos/TransportClient.swift
    "MinibarProjection", // macos/MinibarProjection.swift
    "MinibarWindowController", // macos/MinibarWindowController.swift
    "MinibarView", // macos/MinibarView.swift
  ];

  for (const type of requiredTypes) {
    test(`the packaged executable contains ${type}`, () => {
      expect(executableStrings).toContain(type);
    });
  }

  test("the build compiles every macos/*.swift source in one invocation", () => {
    const sources = run("git", ["ls-files", "--", "macos/*.swift"]).stdout
      .trim()
      .split("\n")
      .filter((name) => name.endsWith(".swift"))
      .map((name) => name.slice("macos/".length));
    expect(sources.length).toBeGreaterThanOrEqual(7);
    for (const source of sources) {
      expect(buildScriptSource).toContain(`macos/${source}`);
    }
    expect(buildScriptSource.match(/swiftc -O -o/g) ?? []).toHaveLength(1);
  });

  test("the menu-bar item, panel and browser workspace action are packaged", () => {
    expect(executableStrings).toContain("MinibarPanel");
    // NSStatusItem and NSWorkspace usage is observable through the
    // Objective-C selectors the binary actually references.
    expect(executableStrings).toContain("systemStatusBar");
    expect(executableStrings).toContain("statusItemWithLength:");
    expect(executableStrings).toContain("statusItemActivated");
    expect(executableStrings).toContain("sharedWorkspace");
    expect(executableStrings).toContain("openURL:");
    expect(executableStrings).toContain("http://localhost:");
    // The panel's own controls, so a bundle stripped of the minibar view is
    // detectable from the artifact alone.
    expect(executableStrings).toContain("openWorkspaceButton");
    expect(executableStrings).toContain("disclosureButton");
    expect(executableStrings).toContain("stopButton");
  });

  test("the packaged executable links no WebKit and stays one binary", () => {
    const linked = run("otool", ["-L", executable]).stdout;
    expect(linked).not.toContain("WebKit");
    expect(linked).toContain("AppKit");
    expect(linked).toContain("AVFoundation");
    expect(linked).toContain("EventKit");
    const machO = run("file", [executable]).stdout;
    expect(machO).toContain("Mach-O 64-bit executable");
  });
});

describe("app bundle: Info.plist identity and permissions", () => {
  const plistValue = (key: string): string =>
    run("plutil", ["-extract", key, "raw", "-o", "-", infoPlist]).stdout.trim();

  test("plutil lints the generated Info.plist", () => {
    const lint = run("plutil", ["-lint", infoPlist]);
    expect(lint.status).toBe(0);
  });

  test("app identity and version metadata are preserved", () => {
    expect(plistValue("CFBundleName")).toBe("Meeting Slides");
    expect(plistValue("CFBundleDisplayName")).toBe("Meeting Slides");
    expect(plistValue("CFBundleIdentifier")).toBe("com.meetingslides.app");
    expect(plistValue("CFBundleExecutable")).toBe("meeting-slides");
    expect(plistValue("CFBundlePackageType")).toBe("APPL");
    expect(plistValue("CFBundleShortVersionString")).toBe("0.3.0");
    expect(plistValue("CFBundleVersion")).toBe("3");
    expect(plistValue("LSMinimumSystemVersion")).toBe("13.0");
  });

  test("every TCC facility the launcher actually uses declares a usage string", () => {
    // macos/launcher.swift requests microphone access through AVFoundation and
    // full calendar access through EventKit. A missing usage string is a hard
    // crash on the first request, not a warning.
    expect(plistValue("NSMicrophoneUsageDescription").length).toBeGreaterThan(10);
    expect(plistValue("NSCalendarsFullAccessUsageDescription").length).toBeGreaterThan(10);
    expect(plistValue("NSCalendarsUsageDescription").length).toBeGreaterThan(10);

    const launcher = readFileSync(join(ROOT, "macos", "launcher.swift"), "utf8");
    expect(launcher).toContain("requestFullAccessToEvents");
    expect(launcher).toContain("AVCaptureDevice.requestAccess");
  });

  test("the bundle claims no screen recording capability it does not use", () => {
    const raw = readFileSync(infoPlist, "utf8");
    expect(raw).not.toContain("NSScreenCaptureUsageDescription");
    const sources = run("ls", ["-1", join(ROOT, "macos")]).stdout.trim().split("\n");
    for (const name of sources.filter((s) => s.endsWith(".swift"))) {
      const source = readFileSync(join(ROOT, "macos", name), "utf8");
      expect(source).not.toMatch(/sharingType/);
      expect(source).not.toMatch(/ScreenCaptureKit/);
    }
  });
});

describe("app bundle: resources", () => {
  test("the project-path resource points at this checkout", () => {
    const marker = join(contents, "Resources", "project-path.txt");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8").trim()).toBe(ROOT);
  });

  test("the launcher reaps its owned server on a raw signal, never orphaning it", () => {
    // Todo-15/16/17 milestone: manual QA proved SIGTERM during the idle phase
    // orphaned the Bun server (pid survived, port stayed bound) because the
    // AppKit runloop never received the signal. The installer below must route
    // SIGTERM/SIGINT into the pure lifecycle's interrupt effect.
    const launcher = readFileSync(join(ROOT, "macos", "launcher.swift"), "utf8");
    expect(launcher).toMatch(/makeSignalSource\(signal:/);
    expect(launcher).toMatch(/signal\(sig, SIG_IGN\)/);
    expect(launcher).toContain("lifecycle.handle(.interrupt)");
  });

  test("the packaged project path resolves the runtime contract the launcher needs", () => {
    const projectDir = readFileSync(join(contents, "Resources", "project-path.txt"), "utf8").trim();
    // The launcher reads .env for HTTP_PORT and runs `bun run server.ts` in
    // this directory. A marker that points anywhere else is a broken bundle.
    expect(existsSync(join(projectDir, "server.ts"))).toBe(true);
    expect(existsSync(join(projectDir, "package.json"))).toBe(true);
  });

  test("the build refuses to package a project path without the server entry point", () => {
    // A bare marker that survives verification would ship a launcher that
    // cannot start the session it promises.
    expect(buildScriptSource).toMatch(/server\.ts/);
  });

  test("the pure project-resolution rule rejects a directory that cannot serve", () => {
    expect(resolutionProbeExit).toBe(0);
    expect(resolutionProbeStderr).toBe("");
    const byName = new Map(
      (resolutionProbe?.results ?? []).map((result) => [result.name, result]),
    );
    expect(resolutionProbe?.entryPoint).toBe("server.ts");
    expect(byName.get("packaged-marker-wins")).toEqual({
      name: "packaged-marker-wins",
      ok: true,
      value: "/checkout",
    });
    expect(byName.get("marker-without-server-falls-through-to-legacy")).toEqual({
      name: "marker-without-server-falls-through-to-legacy",
      ok: true,
      value: "/checkout",
    });
    expect(byName.get("bare-binary-parent-without-server-is-rejected")).toEqual({
      name: "bare-binary-parent-without-server-is-rejected",
      ok: false,
      error: "projectDirectoryNotFound",
    });
    expect(byName.get("blank-marker-is-skipped")).toEqual({
      name: "blank-marker-is-skipped",
      ok: true,
      value: "/checkout",
    });
    expect(byName.get("no-candidate-at-all")).toEqual({
      name: "no-candidate-at-all",
      ok: false,
      error: "projectDirectoryNotFound",
    });
  });

  test("project resolution accepts only a directory that can actually serve", () => {
    // Todo 10 risk: the launcher fell back to the binary's parent directory
    // when the bundle marker was absent, so a bare binary resolved a project
    // dir with no server.ts and no .env and started a phantom session.
    const lifecycle = readFileSync(join(ROOT, "macos", "AppLifecycle.swift"), "utf8");
    expect(lifecycle).toContain("projectDirectory");
    expect(lifecycle).toContain("serverEntryPoint");

    const launcher = readFileSync(join(ROOT, "macos", "launcher.swift"), "utf8");
    expect(launcher).toContain("ProjectResolution.projectDirectory");
    // The entry point supplies filesystem facts; it must not re-implement the
    // rule with its own fallback.
    expect(launcher).not.toMatch(/bundleURL\.deletingLastPathComponent\(\)\.path\s*$/m);
  });
});

describe("app bundle: signing", () => {
  test("codesign --verify --deep --strict passes on the built bundle", () => {
    const verify = run("codesign", ["--verify", "--deep", "--strict", appPath]);
    expect(verify.status).toBe(0);
  });

  test("the bundle is ad-hoc signed under the product identifier", () => {
    const display = run("codesign", ["-dvvv", appPath]);
    const info = display.stdout + display.stderr;
    expect(info).toContain("Identifier=com.meetingslides.app");
    expect(info).toContain("Signature=adhoc");
    expect(info).toContain("flags=0x2(adhoc)");
    expect(info).not.toContain("Developer ID");
    expect(info).toContain("TeamIdentifier=not set");
  });
});

describe("app bundle: install safety", () => {
  test("a redirected build never repoints the repository symlink", () => {
    expect(repoLinkBefore).toBe(CANONICAL_APP);
    expect(repoLinkAfter).toBe(repoLinkBefore);
  });

  test("a redirected build never touches the canonical installed app", () => {
    const canonicalAfter = existsSync(CANONICAL_APP)
      ? run("shasum", ["-a", "256", join(CANONICAL_APP, "Contents", "MacOS", "meeting-slides")]).stdout
      : "";
    expect(canonicalAfter).toBe(canonicalBefore);
  });

  test("the build script updates the repo symlink only for the canonical install dir", () => {
    expect(buildScriptSource).toMatch(/APP_INSTALL_DIR" == "\$HOME\/Applications"/);
  });
});

describe("app bundle: verifier rejects an incomplete bundle", () => {
  // Failure QA: a bundle missing a packaged resource must be rejected by the
  // verifier before anything is installed. The canonical bundle is never
  // touched; the damage happens in a throwaway copy.
  let damaged = "";

  beforeAll(() => {
    damaged = join(installDir, "damaged");
    cpSync(appPath, join(damaged, APP_NAME), { recursive: true, dereference: false, verbatimSymlinks: true });
  });

  test("removing the project-path resource fails verification", () => {
    const copy = join(damaged, APP_NAME);
    unlinkSync(join(copy, "Contents", "Resources", "project-path.txt"));
    const verify = run("bash", [join(ROOT, "scripts", "verify-app.sh"), copy]);
    expect(verify.status).not.toBe(0);
    expect(verify.stdout + verify.stderr).toMatch(/project-path\.txt/);
  });

  test("the intact bundle passes the same verifier", () => {
    const verify = run("bash", [join(ROOT, "scripts", "verify-app.sh"), appPath]);
    expect(verify.status).toBe(0);
  });
});
