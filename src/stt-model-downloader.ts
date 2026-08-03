import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { STT_MODEL_CATALOG, type SttModelArtifact, type SttModelId } from "./stt-model-catalog.js";
import { SttModelSettingsStore } from "./stt-model-settings.js";

export type SttModelState =
  | { readonly status: "absent"; readonly model: SttModelArtifact }
  | { readonly status: "downloading"; readonly model: SttModelArtifact; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly status: "installed"; readonly model: SttModelArtifact; readonly path: string }
  | { readonly status: "selected"; readonly model: SttModelArtifact; readonly path: string }
  | { readonly status: "failed"; readonly model: SttModelArtifact; readonly error: string };

export interface DownloadOptions {
  signal?: AbortSignal;
  maxRedirects?: number;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
}

function abortError(): DOMException {
  return new DOMException("Download cancelled", "AbortError");
}

/** Stream, verify by the published LFS SHA-256, then atomically install a model. */
export async function downloadSttModel(artifact: SttModelArtifact, destination: string, options: DownloadOptions = {}): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true });
  const partPath = join(dirname(destination), `.${basename(destination)}.part-${process.pid}-${randomUUID()}`);
  let fd: number | undefined;
  try {
    let url = new URL(artifact.url);
    const maxRedirects = options.maxRedirects ?? 5;
    let response: Response | undefined;
    for (let redirects = 0; ; redirects += 1) {
      if (options.signal?.aborted) throw abortError();
      response = await fetch(url, { redirect: "manual", signal: options.signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirects >= maxRedirects) throw new Error(`Too many redirects downloading ${artifact.id}`);
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect without location downloading ${artifact.id}`);
      url = new URL(location, url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported download protocol: ${url.protocol}`);
    }
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
    if (!response.body) throw new Error("Download response has no body");
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) !== artifact.sizeBytes) {
      throw new Error(`Content length mismatch: expected ${artifact.sizeBytes}, received ${declaredLength}`);
    }

    fd = openSync(partPath, "wx", 0o600);
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let received = 0;
    while (true) {
      if (options.signal?.aborted) {
        await reader.cancel();
        throw abortError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      writeSync(fd, value);
      hash.update(value);
      received += value.byteLength;
      if (received > artifact.sizeBytes) throw new Error(`Download exceeds expected size ${artifact.sizeBytes}`);
      options.onProgress?.(received, artifact.sizeBytes);
    }
    if (received !== artifact.sizeBytes) throw new Error(`Size mismatch: expected ${artifact.sizeBytes}, received ${received}`);
    const digest = hash.digest("hex");
    if (digest !== artifact.sha256) throw new Error(`SHA-256 mismatch for ${artifact.fileName}`);
    closeSync(fd);
    fd = undefined;
    renameSync(partPath, destination);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(partPath, { force: true });
  }
}

export type SttModelListener = (state: SttModelState) => void;

/** Disk-authoritative lifecycle manager; integration can subscribe before invoking an action. */
export class SttModelManager {
  private readonly states = new Map<SttModelId, SttModelState>();
  private readonly listeners = new Set<SttModelListener>();
  private readonly downloads = new Map<SttModelId, AbortController>();
  private selectedModelId: SttModelId | undefined;

  constructor(
    readonly modelDirectory: string,
    readonly settings: SttModelSettingsStore,
    readonly catalog: readonly SttModelArtifact[] = STT_MODEL_CATALOG,
  ) {
    mkdirSync(modelDirectory, { recursive: true });
    this.selectedModelId = settings.load()?.selectedModelId;
    const partialPrefixes = catalog.map((model) => `.${model.fileName}.part-`);
    for (const entry of readdirSync(modelDirectory, { withFileTypes: true })) {
      if (entry.isFile() && partialPrefixes.some((prefix) => entry.name.startsWith(prefix))) {
        rmSync(join(modelDirectory, entry.name), { force: true });
      }
    }
    for (const model of catalog) this.states.set(model.id, this.diskState(model));
  }

  private path(model: SttModelArtifact): string { return join(this.modelDirectory, model.fileName); }
  private isInstalled(model: SttModelArtifact): boolean {
    const path = this.path(model);
    return existsSync(path) && statSync(path).isFile() && statSync(path).size === model.sizeBytes;
  }
  private diskState(model: SttModelArtifact): SttModelState {
    if (!this.isInstalled(model)) return { status: "absent", model };
    const path = this.path(model);
    return this.selectedModelId === model.id ? { status: "selected", model, path } : { status: "installed", model, path };
  }
  private publish(state: SttModelState): void {
    this.states.set(state.model.id, state);
    for (const listener of this.listeners) listener(state);
  }
  state(id: SttModelId): SttModelState {
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown STT model: ${id}`);
    return state;
  }
  allStates(): readonly SttModelState[] { return this.catalog.map((model) => this.state(model.id)); }
  recheck(): readonly SttModelState[] {
    for (const model of this.catalog) {
      if (!this.downloads.has(model.id)) this.states.set(model.id, this.diskState(model));
    }
    return this.allStates();
  }
  subscribe(listener: SttModelListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async install(id: SttModelId): Promise<void> {
    const model = this.catalog.find((entry) => entry.id === id);
    if (!model) throw new Error(`Unknown STT model: ${id}`);
    if (this.downloads.has(id)) throw new Error(`${id} is already downloading`);
    if (this.isInstalled(model)) { this.publish(this.diskState(model)); return; }
    const controller = new AbortController();
    this.downloads.set(id, controller);
    this.publish({ status: "downloading", model, receivedBytes: 0, totalBytes: model.sizeBytes });
    try {
      await downloadSttModel(model, this.path(model), {
        signal: controller.signal,
        onProgress: (receivedBytes, totalBytes) => this.publish({ status: "downloading", model, receivedBytes, totalBytes }),
      });
      this.publish(this.diskState(model));
    } catch (error) {
      if (controller.signal.aborted) this.publish(this.diskState(model));
      else this.publish({ status: "failed", model, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.downloads.delete(id);
    }
  }

  cancel(id: SttModelId): boolean {
    const controller = this.downloads.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  select(id: SttModelId): string {
    const model = this.catalog.find((entry) => entry.id === id);
    if (!model || !this.isInstalled(model)) throw new Error(`STT model is not installed: ${id}`);
    const previous = this.selectedModelId;
    this.settings.save(id);
    this.selectedModelId = id;
    if (previous && previous !== id) {
      const old = this.catalog.find((entry) => entry.id === previous);
      if (old) this.publish(this.diskState(old));
    }
    const state = this.diskState(model);
    this.publish(state);
    return this.path(model);
  }

  selectedPath(): string | null {
    if (!this.selectedModelId) return null;
    const model = this.catalog.find((entry) => entry.id === this.selectedModelId);
    return model && this.isInstalled(model) ? this.path(model) : null;
  }
}
