import { basename } from "node:path";
import { resolvePublicFile } from "../public-path.ts";
import { resolveSlidePlanArtifact, SlidePlanArtifactError } from "../slide-plan-artifacts.ts";

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'sha256-CTSVlnPNqSQZ/c+SNJNy+TlsMKVz2bXM+yySIVG+qv0='; connect-src 'self' ws:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), geolocation=(), payment=(), usb=()",
  "cache-control": "no-store",
} as const;

function secureResponse(body: BodyInit | null = null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(body, { ...init, headers });
}
export function createHttpHandler(deps: {
  readonly publicDir: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowOriginlessWs: boolean;
  readonly automationToken: string;
  readonly slidePlanStore: Parameters<typeof resolveSlidePlanArtifact>[1];
  readonly capture: { readonly capturing: boolean; startCapture(): Promise<void>; stopCapture(): Promise<void> };
  readonly resolveArtifact?: typeof resolveSlidePlanArtifact;
}) {
  const {
    publicDir,
    allowedOrigins: ALLOWED_WS_ORIGINS,
    allowOriginlessWs,
    automationToken,
    slidePlanStore,
    capture,
  } = deps;
  const resolveArtifact = deps.resolveArtifact ?? resolveSlidePlanArtifact;
  function hasValidAutomationToken(req: Request): boolean {
    if (!automationToken) return false;
    const authorization = req.headers.get("authorization");
    const supplied = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : req.headers.get("x-meeting-slides-token");
    return supplied === automationToken;
  }

  function isTrustedAutomationRequest(req: Request): boolean {
    const origin = req.headers.get("origin");
    return (origin === null || ALLOWED_WS_ORIGINS.has(origin)) && hasValidAutomationToken(req);
  }
  return function fetch(
    req: Request,
    server: Pick<Bun.Server<undefined>, "upgrade">,
  ): Response | Promise<Response> | undefined {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const origin = req.headers.get("origin");
      const allowOriginless = allowOriginlessWs;
      if ((origin === null && !allowOriginless) || (origin !== null && !ALLOWED_WS_ORIGINS.has(origin))) {
        return secureResponse("Forbidden origin", { status: 403 });
      }
      const ok = server.upgrade(req);
      if (ok) return undefined;
      return new Response("Upgrade failed", { status: 426 });
    }
    if (url.pathname === "/favicon.ico") return secureResponse(null, { status: 204 });
    const path =
      url.pathname === "/" || url.pathname === "/app" || url.pathname === "/app/" ? "/index.html" : url.pathname;
    if (url.pathname === "/api/auto-capture" && req.method === "POST") {
      if (!automationToken) return secureResponse("Automation API disabled", { status: 503 });
      if (
        !isTrustedAutomationRequest(req) ||
        !req.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      ) {
        return secureResponse("Forbidden", { status: 403 });
      }
      if (!capture.capturing) {
        void capture.startCapture().catch((error) => {
          console.error(`[auto-capture] 시작 실패: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      return secureResponse(JSON.stringify({ ok: true, capturing: capture.capturing }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/api/auto-stop" && req.method === "POST") {
      if (!automationToken) return secureResponse("Automation API disabled", { status: 503 });
      if (
        !isTrustedAutomationRequest(req) ||
        !req.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      ) {
        return secureResponse("Forbidden", { status: 403 });
      }
      if (capture.capturing) {
        void capture.stopCapture().catch((error) => console.error("[auto-stop] failed", error));
      }
      return secureResponse(JSON.stringify({ ok: true, capturing: false }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.startsWith("/slide-plan-artifacts/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return secureResponse("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return resolveArtifact(url.pathname, slidePlanStore)
        .then((artifact) =>
          secureResponse(req.method === "HEAD" ? null : artifact.bytes, {
            headers: {
              "content-type": artifact.contentType,
              "content-disposition": `${artifact.disposition}; filename="${basename(artifact.filePath)}"`,
            },
          }),
        )
        .catch((error) => {
          if (error instanceof SlidePlanArtifactError) {
            return secureResponse(error.message, { status: error.status });
          }
          console.error(`[slide-plan-artifact] ${error instanceof Error ? error.message : String(error)}`);
          return secureResponse("Artifact unavailable", { status: 500 });
        });
    }
    const filePath = resolvePublicFile(publicDir, path);
    if (filePath === null) {
      return secureResponse("Forbidden", { status: 403 });
    }
    const f = Bun.file(filePath);
    return f.exists().then((exists) => {
      if (!exists) return secureResponse("Not Found", { status: 404 });
      const ext = path.split(".").pop() ?? "";
      const mime = MIME[ext] ?? "application/octet-stream";
      return secureResponse(f, { headers: { "content-type": mime } });
    });
  };
}
