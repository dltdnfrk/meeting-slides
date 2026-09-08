import { createMeetingApplication } from "./src/server/application.ts";
import { loadConfig, loadWhisperConfig } from "./src/config.ts";
import { listCaptureDevices } from "./src/whisper.ts";

export { createMeetingApplication } from "./src/server/application.ts";

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--devices")) {
    const devices = await listCaptureDevices(loadWhisperConfig());
    console.log("whisper-stream capture devices:");
    for (const device of devices) console.log(`  #${device.id}: ${device.name}`);
  } else {
    const config = loadConfig(args);
    const application = createMeetingApplication({ config, paths: { projectRoot: import.meta.dir } });
    const running = application.start();
    console.log(`HTTP: http://localhost:${running.server.port}`);
    console.log(`입력 모드: ${config.input.mode}${config.input.filePath ? ` (${config.input.filePath})` : ""}`);
    console.log(`meeting-slides 서버 시작. 브라우저에서 http://localhost:${running.server.port} 접속`);
    const shutdown = () => {
      process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown);
      void application.close().catch(error => { console.error("Shutdown failed", error); process.exitCode = 1; });
    };
    process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
    if (config.server.openBrowser) {
      const url = `http://localhost:${running.server.port}`;
      const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
      void Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).exited.then(code => {
        if (code !== 0) console.warn(`브라우저 열기 실패 (exit ${code})`);
      });
    }
  }
}
