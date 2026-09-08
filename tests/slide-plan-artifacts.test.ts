import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSlidePlanArtifact, SlidePlanArtifactError } from "../src/slide-plan-artifacts.ts";
import { decodePublicationManifest } from "../src/slides/server-pipeline-publication.ts";

const roots: string[] = [];
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

import { createHttpHandler } from "../src/server/http.ts";

function fixture(manifestOverride: Readonly<Record<string, unknown>> = {}, html = "<!doctype html><title>Deck</title>") {
  const root = mkdtempSync(join(tmpdir(), "slide-plan-artifacts-"));
  roots.push(root);
  mkdirSync(join(root, "standalone"), { recursive: true });
  writeFileSync(join(root, "standalone", "index.html"), html);
  const manifestValue = {
    schemaVersion: 1,
    identity: {
      planId: "plan-safe",
      deckId: "plan-safe:deck",
      snapshot: {
        meetingId: 7,
        transcriptVersionId: "transcript-v7",
        contentSha256: "c".repeat(64),
        lineCount: 1,
      },
      slideIds: ["slide-1"],
      geometryIds: ["geometry-1"],
      claimIds: ["claim-1"],
    },
    planSha256: "a".repeat(64),
    assetManifestSha256: "b".repeat(64),
    artifacts: [{
      format: "standalone-html",
      files: [{ relativePath: "standalone/index.html", byteLength: Buffer.byteLength(html), sha256: hash(html) }],
    }],
    ...manifestOverride,
  };
  const manifest = `${JSON.stringify(manifestValue)}\n`;
  const publicationSha256 = hash(manifest);
  writeFileSync(join(root, "publication.json"), `${JSON.stringify({
    ...manifestValue,
    publicationSha256,
  })}\n`);
  const store = {
    one: (planId: string) => planId === "plan-safe"
      ? { path: root, publicationSha256 }
      : null,
  };
  return { root, manifest, manifestValue, store };
}

const finalIdentity = Object.freeze({
  planId: "plan-safe",
  deckId: "plan-safe:deck",
  snapshot: {
    meetingId: 7,
    transcriptVersionId: "transcript-v7",
    contentSha256: "c".repeat(64),
    lineCount: 1,
  },
  slideIds: ["slide-1"],
  geometryIds: ["geometry-1"],
  claimIds: ["claim-1"],
  reviewId: "review-v7",
  reviewedItemIds: ["item-a", "item-z"],
});

const draftIdentity = Object.freeze({
  planId: "plan-safe",
  deckId: "plan-safe:deck",
  snapshot: finalIdentity.snapshot,
  slideIds: ["slide-1"],
  geometryIds: ["geometry-1"],
  claimIds: ["claim-1"],
});

const finalityReceipt = Object.freeze({
  reviewId: "review-v7",
  confirmedAt: 1_787_048_400_000,
  transcriptVersionId: "transcript-v7",
  contentSha256: "c".repeat(64),
  reviewedItemIds: ["item-a", "item-z"],
});

afterEach(() => {
  if (process.env.PUBLICATION_TEST_RETAIN_FIXTURES === "1") return;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SlidePlan artifact route", () => {
  test("Given a schema-v1 manifest without publicationStatus, When an artifact is requested, Then its listed file resolves", async () => {
    const { root, store } = fixture();
    const artifact = await resolveSlidePlanArtifact(
      "/slide-plan-artifacts/plan-safe/standalone/index.html",
      store,
    );
    expect(artifact).toEqual({
      filePath: realpathSync(join(root, "standalone", "index.html")),
      bytes: readFileSync(join(root, "standalone", "index.html")),
      contentType: "text/html; charset=utf-8",
      disposition: "attachment",
    });
  });

  test("Given a verified read, When the disk file changes, Then the returned response bytes retain the verified content", async () => {
    const html = "<!doctype html><title>Verified bytes</title>";
    const { root, store } = fixture({}, html);
    const artifact = await resolveSlidePlanArtifact("/slide-plan-artifacts/plan-safe/standalone/index.html", store);

    writeFileSync(join(root, "standalone", "index.html"), "modified after verification");

    expect(await new Response(artifact.bytes).text()).toBe(html);
  });

  for (const method of ["GET", "HEAD"] as const) {
    test(`Given a replaced artifact path after verification, When the server handles ${method}, Then it preserves the verified response contract`, async () => {
      const html = "<!doctype html><title>Verified HTTP publication</title>";
      const { root, store } = fixture({}, html);
      const resolveThenReplace: typeof resolveSlidePlanArtifact = async (pathname, publications) => {
        const artifact = await resolveSlidePlanArtifact(pathname, publications);
        renameSync(artifact.filePath, join(root, "retained-original.html"));
        writeFileSync(artifact.filePath, "unverified replacement bytes");
        return artifact;
      };

      const handler = createHttpHandler({
        publicDir: root, allowedOrigins: new Set(), allowOriginlessWs: false, automationToken: "",
        slidePlanStore: store, resolveArtifact: resolveThenReplace,
        capture: { capturing: false, async startCapture() { }, async stopCapture() { } },
      });
      const response = await handler(
        new Request("http://localhost/slide-plan-artifacts/plan-safe/standalone/index.html", { method }),
        { upgrade: () => false },
      );
      if (!response) throw new Error("artifact request unexpectedly upgraded");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("content-disposition")).toBe('attachment; filename="index.html"');
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe(method === "HEAD" ? "" : html);
    });
  }

  test("Given an escaping manifest symlink, When an artifact is requested, Then the publication is rejected", async () => {
    const { root, store } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "slide-plan-artifacts-outside-"));
    roots.push(outside);
    renameSync(join(root, "publication.json"), join(outside, "publication.json"));
    symlinkSync(join(outside, "publication.json"), join(root, "publication.json"));

    await expect(resolveSlidePlanArtifact("/slide-plan-artifacts/plan-safe/standalone/index.html", store))
      .rejects.toMatchObject({ status: 403 });
  });

  test("Given legacy and current manifests, When artifacts are requested, Then both normalized contracts resolve", async () => {
    const legacy = fixture({ identity: finalIdentity });
    const current = fixture({
      schemaVersion: 2,
      publicationStatus: "final",
      identity: finalIdentity,
      finalityReceipt,
    });

    expect(decodePublicationManifest(legacy.manifestValue)).toMatchObject({
      schemaVersion: 1,
      publicationStatus: "final",
      identity: finalIdentity,
    });
    const normalizedCurrent = decodePublicationManifest(current.manifestValue);
    expect(normalizedCurrent.schemaVersion).toBe(2);
    expect(normalizedCurrent.publicationStatus).toBe("final");
    expect(normalizedCurrent.finalityReceipt).toEqual(finalityReceipt);
    for (const publication of [legacy, current]) {
      await expect(resolveSlidePlanArtifact(
        "/slide-plan-artifacts/plan-safe/standalone/index.html",
        publication.store,
      )).resolves.toMatchObject({ contentType: "text/html; charset=utf-8" });
    }
  });

  test("Given multiple revisions for one plan, When its artifact is requested, Then the greatest publication sequence resolves", async () => {
    const older = fixture({}, "<!doctype html><title>Older audit-later revision</title>");
    const newer = fixture({ schemaVersion: 2, publicationStatus: "draft" }, "<!doctype html><title>Newer sequence revision</title>");
    const publications = [
      { publicationSeq: 1, publishedAt: 200, path: older.root, publicationSha256: hash(older.manifest) },
      { publicationSeq: 2, publishedAt: 100, path: newer.root, publicationSha256: hash(newer.manifest) },
    ];
    const store = {
      one: (planId: string) => planId === "plan-safe"
        ? [...publications].sort((left, right) => right.publicationSeq - left.publicationSeq)[0] ?? null
        : null,
    };

    const artifact = await resolveSlidePlanArtifact(
      "/slide-plan-artifacts/plan-safe/standalone/index.html",
      store,
    );

    expect(artifact.filePath).toBe(realpathSync(join(newer.root, "standalone", "index.html")));
  });

  test("rejects contradictory, unknown, missing, mismatched, and hash-invalid manifests with status 409", async () => {
    const invalidManifests = [
      { schemaVersion: 1, publicationStatus: "draft", identity: finalIdentity },
      { schemaVersion: undefined, identity: draftIdentity },
      { schemaVersion: 99, identity: draftIdentity },
      { schemaVersion: 2, identity: draftIdentity },
      { schemaVersion: 2, publicationStatus: "final", identity: finalIdentity },
      {
        schemaVersion: 2,
        publicationStatus: "final",
        identity: finalIdentity,
        finalityReceipt: { ...finalityReceipt, reviewId: "review-other" },
      },
      {
        schemaVersion: 2,
        publicationStatus: "final",
        identity: finalIdentity,
        finalityReceipt: { ...finalityReceipt, contentSha256: "d".repeat(64) },
      },
      {
        schemaVersion: 2,
        publicationStatus: "final",
        identity: finalIdentity,
        finalityReceipt: { ...finalityReceipt, reviewedItemIds: ["item-a"] },
      },
      { schemaVersion: 2, publicationStatus: "draft", identity: finalIdentity },
      {
        schemaVersion: 2,
        publicationStatus: "draft",
        identity: draftIdentity,
        finalityReceipt,
      },
    ];
    for (const invalid of invalidManifests) {
      const { store } = fixture(invalid);
      await expect(resolveSlidePlanArtifact(
        "/slide-plan-artifacts/plan-safe/standalone/index.html",
        store,
      )).rejects.toMatchObject({ status: 409 });
    }
  });

  test("rejects traversal, unlisted files, tampered manifests, and unknown plans", async () => {
    const { root, store } = fixture();
    await expect(resolveSlidePlanArtifact(
      "/slide-plan-artifacts/plan-safe/%2e%2e/meetings.db",
      store,
    )).rejects.toMatchObject({ status: 403 });
    await expect(resolveSlidePlanArtifact(
      "/slide-plan-artifacts/plan-safe/unlisted.txt",
      store,
    )).rejects.toMatchObject({ status: 404 });
    await expect(resolveSlidePlanArtifact(
      "/slide-plan-artifacts/unknown/standalone/index.html",
      store,
    )).rejects.toMatchObject({ status: 404 });

    writeFileSync(join(root, "standalone", "index.html"), "tampered");
    await expect(resolveSlidePlanArtifact(
      "/slide-plan-artifacts/plan-safe/standalone/index.html",
      store,
    )).rejects.toMatchObject({ status: 409 });

    writeFileSync(join(root, "publication.json"), "{}");
    await expect(resolveSlidePlanArtifact(
      "/slide-plan-artifacts/plan-safe/standalone/index.html",
      store,
    )).rejects.toBeInstanceOf(SlidePlanArtifactError);
  });
});
