/**
 * Test doubles and a harness for transcript-artifact service tests. Fakes
 * implement the contracts.ts interfaces only; nothing here runs a browser.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_VERSIONS,
  ArtifactFailure,
  artifactError,
  type ArtifactToolName,
} from "@orkestrator/protocol/transcript-artifacts";
import { StorageService } from "../storage.js";
import type {
  ArtifactContentServer,
  InteractivePreparer,
  PreparedInteractivePackage,
  PreviewJob,
  PreviewJobResult,
  PreviewJobScope,
  PreviewRunner,
  PreviewRunnerStatus,
} from "./contracts.js";
import { sha256Hex } from "./hashing.js";
import type { ArtifactCallerScope } from "./owner.js";
import type { ArtifactRolloutFlags } from "./service-context.js";
import { TranscriptArtifactService, type TranscriptArtifactServiceOptions } from "./service.js";

/** A tiny but signature-valid PNG body (the service checks signature and bounds only). */
export function fakePng(seed = 0): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < bytes.length; index += 1) bytes[index] = (index * 31 + seed) & 0xff;
  new DataView(bytes.buffer).setUint32(16, 1);
  new DataView(bytes.buffer).setUint32(20, 1);
  return bytes;
}

/** A minimal one-page PDF body (signature and one page dictionary). */
export function fakePdf(seed = ""): Uint8Array {
  return new TextEncoder().encode(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n% ${seed}\n%%EOF\n`,
  );
}

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export class FakePreviewRunner implements PreviewRunner {
  available = true;
  browserBuild = "chromium-test-1";
  calls: Array<{ job: PreviewJob; scope: PreviewJobScope }> = [];
  /** When set, jobs wait for `release()` (or abort) before resolving. */
  private gate: Deferred | null = null;
  started = deferred();
  /** Override a job's outcome. */
  respond: ((job: PreviewJob) => PreviewJobResult | null) | null = null;
  /** Current renderer bundle identity per kind (reported in status). */
  bundleHashes: NonNullable<PreviewRunnerStatus["rendererBundleHashes"]> = {
    "html-static": "bundle-1",
    "html-interactive": "bundle-1",
    mermaid: "bundle-1",
  };
  /** When set, the advisory admission probe refuses with this resource. */
  refuse: string | null = null;
  /** The next N runs throw a plain Error (a crashed worker). */
  crashes = 0;

  admissionRefusal(): string | null {
    return this.refuse;
  }

  status(): PreviewRunnerStatus {
    return this.available
      ? {
          available: true,
          isolation: "process",
          browserBuild: this.browserBuild,
          rendererBundleHashes: { ...this.bundleHashes },
        }
      : {
          available: false,
          isolation: "unavailable",
          browserBuild: "unknown",
          reason: "test: unavailable",
        };
  }
  async probe(): Promise<PreviewRunnerStatus> {
    return this.status();
  }
  hold(): void {
    this.gate = deferred();
    this.started = deferred();
  }
  release(): void {
    this.gate?.resolve();
    this.gate = null;
  }
  async run(
    job: PreviewJob,
    scope: PreviewJobScope,
    signal: AbortSignal,
  ): Promise<PreviewJobResult> {
    if (!this.available)
      throw new ArtifactFailure(artifactError("renderer_unavailable", "test: unavailable"));
    this.calls.push({ job, scope });
    if (this.crashes > 0) {
      this.crashes -= 1;
      throw new Error("test: worker crashed");
    }
    this.started.resolve();
    const gate = this.gate;
    if (gate) {
      await Promise.race([
        gate.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    }
    if (signal.aborted) {
      return {
        kind: job.kind,
        ok: false,
        error: artifactError("cancelled", "cancelled"),
        diagnostics: [],
        omittedDiagnostics: 0,
        captures: [],
        blockedRequests: {},
        browserBuild: this.browserBuild,
      };
    }
    const custom = this.respond?.(job);
    if (custom) return custom;
    const base = {
      browserBuild: this.browserBuild,
      rendererBundleHash:
        (this.bundleHashes as Partial<Record<PreviewJob["kind"], string>>)[job.kind] ?? "bundle-1",
      diagnostics: [],
      omittedDiagnostics: 0,
      blockedRequests: {},
    };
    switch (job.kind) {
      case "html-static":
        return {
          ...base,
          kind: "html-static",
          ok: true,
          effectiveHtml: job.html.replace(/<script[\s\S]*?<\/script>/gi, ""),
          captures: [
            {
              png: fakePng(job.html.length),
              width: job.profile.viewport.width,
              height: job.profile.viewport.height,
              label: "initial",
            },
          ],
          sanitizer: {
            scripts: 0,
            handlers: 0,
            externalReferences: 0,
            forbiddenElements: 0,
            executableUrls: 0,
          },
          elementCount: 3,
        };
      case "html-interactive":
        return {
          ...base,
          kind: "html-interactive",
          ok: true,
          captures: [
            {
              png: fakePng(7),
              width: job.profile.viewport.width,
              height: job.profile.viewport.height,
              label: "initial",
            },
          ],
          probeResults: job.probes.map((probe, index) => ({
            index,
            op: probe.op,
            target: probe.target,
            status: "passed" as const,
          })),
          runtimeErrors: 0,
          elementCount: 4,
        };
      case "mermaid":
        if (job.source.includes("SYNTAX_ERROR")) {
          return {
            kind: "mermaid",
            ok: false,
            error: artifactError("validation_failed", "Parse error on line 1"),
            diagnostics: [
              { severity: "error", code: "syntax", message: "Parse error", location: "1:5" },
            ],
            omittedDiagnostics: 0,
            captures: [],
            blockedRequests: {},
            browserBuild: this.browserBuild,
          };
        }
        return {
          ...base,
          kind: "mermaid",
          ok: true,
          svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${job.source.length}-${job.theme}</text></svg>`,
          diagramType: "flowchart",
          svgElements: 2,
          edges: 1,
        };
      case "html-print": {
        const effective =
          job.document.type === "static"
            ? job.document.html.replace(/<script[\s\S]*?<\/script>/gi, "")
            : null;
        return {
          ...base,
          kind: "html-print",
          ok: true,
          pdf: fakePdf(`${job.print.paper}:${job.document.type}`),
          pageCount: 1,
          ...(effective !== null ? { effectiveHtmlSha256: sha256Hex(effective) } : {}),
        };
      }
      case "pdf-thumbnail":
        return {
          ...base,
          kind: "pdf-thumbnail",
          ok: true,
          pageCount: 3,
          thumbnail: { png: fakePng(3), width: 120, height: 160, label: "initial" },
        };
    }
  }
  async close(): Promise<void> {}
}

export class FakePreparer implements InteractivePreparer {
  manifestHash = "dependency-manifest-1";
  calls = 0;
  async prepare(input: {
    artifactId: string;
    revision: number;
    html: string;
    dependencyIds: string[];
  }) {
    this.calls += 1;
    if (input.html.includes("UNRESOLVED_IMPORT")) {
      return {
        ok: false as const,
        error: artifactError("policy_denied", "Unresolved import"),
        diagnostics: [
          { severity: "error" as const, code: "unresolved_import", message: "Unresolved import" },
        ],
      };
    }
    const document = `<!doctype html><!-- prepared ${input.artifactId}/${input.revision} -->${input.html}`;
    const prepared: PreparedInteractivePackage = {
      document,
      documentSha256: sha256Hex(document),
      byteLength: new TextEncoder().encode(document).byteLength,
      contentSecurityPolicy: "default-src 'none'; sandbox allow-scripts",
      scriptHashes: [],
      dependencyManifestHash: this.manifestHash,
      resolvedDependencies: [],
      runtimeVersion: ARTIFACT_VERSIONS.interactiveRuntime,
      policyVersion: ARTIFACT_VERSIONS.interactivePolicyVersion,
      readinessNonce: "nonce-1",
      diagnostics: [],
    };
    return { ok: true as const, prepared };
  }
  dependencyManifestHash(): string {
    return this.manifestHash;
  }
}

export class FakeContentServer implements ArtifactContentServer {
  minted: Array<{
    artifactId: string;
    preparedSha256: string;
    generation: string;
    load: () => Promise<Uint8Array>;
    authorize?: () => Promise<boolean>;
  }> = [];
  revoked: string[] = [];
  revokedArtifacts: string[] = [];
  origin(): string | null {
    return "http://localhost:4999";
  }
  mint(input: {
    artifactId: string;
    revision: number;
    preparedSha256: string;
    contentSecurityPolicy: string;
    load: () => Promise<Uint8Array>;
    authorize?: () => Promise<boolean>;
  }) {
    const generation = `gen-${this.minted.length + 1}`;
    this.minted.push({
      artifactId: input.artifactId,
      preparedSha256: input.preparedSha256,
      generation,
      load: input.load,
      ...(input.authorize ? { authorize: input.authorize } : {}),
    });
    return {
      url: `http://localhost:4999/a/${generation}`,
      shellUrl: `http://localhost:4999/s/${generation}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      generation,
    };
  }
  revoke(generation: string): void {
    this.revoked.push(generation);
  }
  revokeArtifact(artifactId: string): void {
    this.revokedArtifacts.push(artifactId);
  }
  async close(): Promise<void> {}
}

export const ENV = "env-1";
export const PROJECT = "project-1";
export const TAB: ArtifactCallerScope = { environmentId: ENV, projectId: PROJECT, tabId: "tab-1" };
export const CONVERSATION = `env-${ENV}:tab-1`;

export interface Harness {
  dataDir: string;
  storage: StorageService;
  service: TranscriptArtifactService;
  runner: FakePreviewRunner;
  preparer: FakePreparer;
  content: FakeContentServer;
  clock: { now: number };
  flags: ArtifactRolloutFlags;
  /** Content-free change hints the service announced, in order. */
  announcements: Array<{ environmentId: string; conversationKey: string }>;
  call(
    name: ArtifactToolName,
    args: Record<string, unknown>,
    scope?: ArtifactCallerScope,
  ): Promise<Record<string, any>>;
  reopen(overrides?: Partial<TranscriptArtifactServiceOptions>): Promise<TranscriptArtifactService>;
  /** A second service on the same data dir (another process), without draining the first. */
  fork(overrides?: Partial<TranscriptArtifactServiceOptions>): TranscriptArtifactService;
  close(): Promise<void>;
}

export async function createHarness(
  overrides: Partial<TranscriptArtifactServiceOptions> = {},
): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "ork-artifacts-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addProject({
    id: PROJECT,
    name: PROJECT,
    gitUrl: `https://example.invalid/${PROJECT}.git`,
    localPath: null,
    addedAt: new Date(0).toISOString(),
    order: 0,
  });
  for (const id of [ENV, "env-2"]) {
    await storage.addEnvironment({
      id,
      projectId: PROJECT,
      name: id,
      branch: "main",
      environmentType: "local",
      worktreePath: dataDir,
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      setupPhase: "ready",
      setupScriptsComplete: true,
    });
  }
  const runner = new FakePreviewRunner();
  const preparer = new FakePreparer();
  const content = new FakeContentServer();
  const clock = { now: Date.now() };
  const flags: ArtifactRolloutFlags = {
    richMarkdown: true,
    artifactPublication: true,
    liveInteractive: true,
  };
  const services: TranscriptArtifactService[] = [];
  const announcements: Array<{ environmentId: string; conversationKey: string }> = [];
  const make = (extra: Partial<TranscriptArtifactServiceOptions> = {}) => {
    const service: TranscriptArtifactService = new TranscriptArtifactService({
      dataDir,
      workflows: storage,
      announce: (environmentId, conversationKey) =>
        announcements.push({ environmentId, conversationKey }),
      // Production wiring: staged uploads of the same owner only.
      assetResolver: (owner, assetRef) => service.resolveStagedAsset(owner, assetRef),
      environmentProject: async (environmentId) =>
        (await storage.getEnvironment(environmentId))?.projectId ?? null,
      runtime: { runner, preparer, contentServer: content },
      now: () => clock.now,
      syncDirectories: false,
      rollout: () => flags,
      ...overrides,
      ...extra,
    });
    services.push(service);
    return service;
  };
  const harness: Harness = {
    dataDir,
    storage,
    service: make(),
    runner,
    preparer,
    content,
    clock,
    flags,
    announcements,
    async call(name, args, scope = TAB) {
      const response = await harness.service.handleTool(name, scope, args);
      return {
        ...response.value,
        isError: response.isError,
        ...(response.image ? { image: response.image } : {}),
      };
    },
    async reopen(extra = {}) {
      await harness.service.drain();
      harness.service = make(extra);
      return harness.service;
    },
    fork(extra = {}) {
      return make(extra);
    },
    async close() {
      for (const service of services) await service.close();
      storage.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  return harness;
}

let keys = 0;
export function key(label = "k"): string {
  keys += 1;
  return `${label}-${keys}-${Math.random().toString(36).slice(2, 8)}`;
}

export const SAMPLE_CHART = {
  schemaVersion: 1,
  kind: "bar",
  title: "Revenue",
  description: "Quarterly revenue",
  xAxis: { kind: "category", label: "Quarter" },
  yAxis: { label: "Revenue", unit: "USD" },
  categories: [
    { id: "q1", label: "Q1" },
    { id: "q2", label: "Q2" },
  ],
  series: [
    {
      id: "rev",
      label: "Revenue",
      points: [
        { categoryId: "q1", value: 10 },
        { categoryId: "q2", value: 20 },
      ],
    },
  ],
};

/** Waits until the operation leaves queued/running. */
export async function settle(
  harness: Harness,
  operationId: string,
  scope: ArtifactCallerScope = TAB,
): Promise<Record<string, any>> {
  await harness.service.drain();
  return harness.call("get_artifact_operation", { operationId }, scope);
}
