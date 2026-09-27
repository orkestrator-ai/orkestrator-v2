/**
 * Test doubles for web annotation service suites. Injected rather than
 * module-mocked: a fake dispatch port, a deterministic brief compiler, a
 * fake host storage, a manual clock, and a synthetic PNG builder.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  webAnnotationRequestMarker,
  webAnnotationUtf8Bytes,
  type WebAnnotationDestinationOption,
  type WebAnnotationRequest,
  type WebAnnotationRequestAttachment,
} from "@orkestrator/protocol/web-annotations";
import {
  fixtureCaptureInput,
  fixtureDestination,
} from "@orkestrator/protocol/web-annotations-fixtures";
import { PNG_SIGNATURE, crc32 } from "./web-annotation-assets.js";
import type {
  CancelOutcome,
  CompileBriefInput,
  CompiledBrief,
  ComposeDispatchText,
  DispatchObservation,
  MaterializeInput,
  PublishInput,
  PublishReceipt,
  WebAnnotationDispatchPort,
} from "./web-annotation-contracts.js";
import type {
  WebAnnotationHostComposeDraft,
  WebAnnotationHostEnvironment,
  WebAnnotationHostStorage,
} from "./web-annotation-service-core.js";
import {
  WebAnnotationService,
  type WebAnnotationServiceOptions,
} from "./web-annotation-service.js";

export const ENV_A = "env-a";
export const ENV_B = "env-b";

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.byteLength);
  out.writeUInt32BE(data.byteLength, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.byteLength), 8 + data.byteLength);
  return out;
}

/** A small valid RGB PNG; `seed` changes the pixels (and digest). */
export function makePng(width = 4, height = 3, seed = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const start = y * (1 + width * 3);
    for (let x = 0; x < width * 3; x++) rows[start + 1 + x] = (seed + x + y) & 0xff;
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export class ManualClock {
  constructor(public value = Date.now()) {}
  now = () => this.value;
  advance(ms: number) {
    this.value += ms;
  }
}

export const fakeComposeText: ComposeDispatchText = (requestId, brief, operation, count) =>
  `${webAnnotationRequestMarker(requestId, operation, count)}\n\n${brief.body}`;

/** Deterministic compiler: identical input → identical body and hash. */
export function fakeCompileBrief(input: CompileBriefInput): CompiledBrief {
  const body = JSON.stringify({
    operation: input.operation,
    instruction: input.instruction,
    annotations: input.annotations.map((item) => ({
      id: item.annotation.id,
      contentRevision: item.annotation.contentRevision,
      captureId: item.capture?.id ?? null,
      entries: item.entries.map((entry) => entry.id),
    })),
  });
  const attachments: CompiledBrief["attachments"] = [];
  const seen = new Set<string>();
  for (const item of input.annotations) {
    for (const asset of item.assets) {
      if (seen.has(asset.digest) || input.textOnly) continue;
      seen.add(asset.digest);
      attachments.push({
        assetId: asset.id,
        digest: asset.digest,
        bytes: asset.bytes,
        relativePath: `.orkestrator/annotations/${asset.digest.slice(0, 32)}.png`,
      });
    }
  }
  return {
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    bytes: webAnnotationUtf8Bytes(body),
    selections: input.annotations.map((item, index) => ({
      annotationId: item.annotation.id,
      reference: index + 1,
      contentRevision: item.annotation.contentRevision,
      captureId: item.annotation.currentCaptureId,
      captureRevision: item.annotation.captureRevision,
      entryIds: item.entries.map((entry) => entry.id),
      desiredOutcome: item.desiredOutcome,
      historicalEvidence: item.allowHistoricalEvidence,
    })),
    instruction: input.instruction || "Use the latest note",
    evidence: {
      items: input.annotations.map((item, index) => ({
        annotationId: item.annotation.id,
        reference: index + 1,
        included: ["intent", "target"],
        omitted: [],
        unavailable: [],
        captureState: item.capture?.state ?? "missing",
        targetKind: item.annotation.targetKind,
      })),
      textBytes: webAnnotationUtf8Bytes(body),
      imageCount: attachments.length,
      imageBytes: attachments.reduce((total, attachment) => total + attachment.bytes, 0),
    },
    attachments,
    readOnly: input.operation === "discuss" ? "advisory" : "not-applicable",
    issues: [],
  };
}

export class FakeDispatch implements WebAnnotationDispatchPort {
  published: PublishInput[] = [];
  materializeCalls: MaterializeInput[] = [];
  observations = new Map<string, DispatchObservation>();
  publishReceipt: PublishReceipt = { status: "queued" };
  publishFailures = 0;
  materializeFailures = 0;
  cancelOutcome: CancelOutcome = { outcome: "cancelled" };
  destinationOk = true;
  observeCalls = 0;

  async listDestinations(): Promise<WebAnnotationDestinationOption[]> {
    return [
      {
        destination: fixtureDestination,
        title: "Claude",
        model: null,
        activity: "idle",
        images: true,
        planMode: true,
        resultTools: false,
        holds: [],
        isDefault: true,
      },
    ];
  }
  async validateDestination() {
    return this.destinationOk
      ? { ok: true as const, capabilities: { images: true, planMode: true, resultTools: false } }
      : { ok: false as const, reason: "Session closed", code: "destination-unavailable" as const };
  }
  async materialize(input: MaterializeInput): Promise<WebAnnotationRequestAttachment[]> {
    this.materializeCalls.push(input);
    if (this.materializeFailures > 0) {
      this.materializeFailures--;
      throw new Error("materialize failed");
    }
    const out: WebAnnotationRequestAttachment[] = [];
    for (const attachment of input.attachments) {
      await input.readAsset(attachment.assetId);
      out.push({ ...attachment, materializedPath: `/workspace/${attachment.relativePath}` });
    }
    return out;
  }
  async publish(input: PublishInput): Promise<PublishReceipt> {
    if (this.publishFailures > 0) {
      this.publishFailures--;
      throw new Error("publish timed out");
    }
    this.published.push(input);
    return this.publishReceipt;
  }
  async observe(request: WebAnnotationRequest): Promise<DispatchObservation> {
    this.observeCalls++;
    return (
      this.observations.get(request.id) ?? {
        state: request.state,
        blockedReason: null,
        reason: null,
        dispatchConfirmed: false,
        interactionIds: [],
        destinationMissing: false,
      }
    );
  }
  async cancel(): Promise<CancelOutcome> {
    return this.cancelOutcome;
  }
  async recover(request: WebAnnotationRequest): Promise<DispatchObservation> {
    return this.observe(request);
  }
  async readResponse() {
    return {
      excerpt: {
        text: "Done.",
        capturedAt: "2026-09-24T10:00:00.000Z",
        provenance: "agent-reference" as const,
        truncated: false,
      },
      sourceAvailable: true,
    };
  }
  observe_(
    requestId: string,
    state: DispatchObservation["state"],
    extra: Partial<DispatchObservation> = {},
  ) {
    this.observations.set(requestId, {
      state,
      blockedReason: null,
      reason: null,
      dispatchConfirmed: state !== "queued",
      interactionIds: [],
      destinationMissing: false,
      ...extra,
    });
  }
}

export class FakeHostStorage implements WebAnnotationHostStorage {
  environments = new Map<string, WebAnnotationHostEnvironment>();
  drafts = new Map<string, WebAnnotationHostComposeDraft>();
  sessions: Array<{ environmentId: string; logicalSessionKey: string; pendingDispatch?: unknown }> =
    [];
  failSessions = false;
  /** Called after a draft is read inside `getComposeDraft`, for race tests. */
  onGetDraft: ((key: string) => void) | null = null;

  constructor(environmentIds: string[] = [ENV_A, ENV_B]) {
    for (const id of environmentIds) {
      this.environments.set(id, { id, environmentType: "local", containerId: null });
    }
  }
  async getEnvironment(id: string) {
    return this.environments.get(id) ?? null;
  }
  async listComposeDrafts(ownerType: "environment" | "project", ownerId: string) {
    return Array.from(this.drafts.values())
      .filter((draft) => draft.ownerType === ownerType && draft.ownerId === ownerId)
      .map((draft) => structuredClone(draft));
  }
  async getComposeDraft(key: string) {
    const draft = this.drafts.get(key);
    this.onGetDraft?.(key);
    return draft ? structuredClone(draft) : null;
  }
  async saveComposeDraft(
    key: string,
    ownerType: "environment" | "project",
    ownerId: string,
    value: unknown,
    expectedRevision?: number,
  ) {
    const previous = this.drafts.get(key);
    if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
      throw new Error("Compose draft revision conflict");
    }
    const saved = {
      draftKey: key,
      ownerType,
      ownerId,
      value: structuredClone(value),
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.drafts.set(key, saved);
    return structuredClone(saved);
  }
  async listNativeAgentSessions() {
    if (this.failSessions) throw new Error("sessions unreadable");
    return this.sessions;
  }
  putDraft(key: string, ownerId: string, value: unknown, revision = 1) {
    this.drafts.set(key, {
      draftKey: key,
      ownerType: "environment",
      ownerId,
      value: structuredClone(value),
      revision,
      updatedAt: "2026-09-24T10:00:00.000Z",
    });
  }
}

export interface ServiceHarness {
  dir: string;
  clock: ManualClock;
  dispatch: FakeDispatch;
  host: FakeHostStorage;
  events: Array<{ event: string; payload: unknown }>;
  service: WebAnnotationService;
  restart(overrides?: Partial<WebAnnotationServiceOptions>): Promise<WebAnnotationService>;
  cleanup(): Promise<void>;
}

export async function createHarness(
  overrides: Partial<WebAnnotationServiceOptions> = {},
): Promise<ServiceHarness> {
  const dir = await mkdtemp(join(tmpdir(), "ork-web-annotations-"));
  const clock = new ManualClock();
  const dispatch = new FakeDispatch();
  const host = new FakeHostStorage();
  const events: Array<{ event: string; payload: unknown }> = [];
  const services: WebAnnotationService[] = [];
  const make = (extra: Partial<WebAnnotationServiceOptions> = {}) => {
    const service = new WebAnnotationService({
      dataDir: dir,
      clock: clock.now,
      dispatch,
      compileBrief: fakeCompileBrief,
      composeText: fakeComposeText,
      storage: host,
      syncDirectories: false,
      emit: (event, payload) => events.push({ event, payload }),
      ...overrides,
      ...extra,
    });
    services.push(service);
    return service;
  };
  const harness: ServiceHarness = {
    dir,
    clock,
    dispatch,
    host,
    events,
    service: make(),
    async restart(extra = {}) {
      await harness.service.close();
      harness.service = make(extra);
      await harness.service.initialize();
      return harness.service;
    },
    async cleanup() {
      for (const service of services) await service.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
  };
  await harness.service.initialize();
  return harness;
}

export async function createAnnotation(
  service: WebAnnotationService,
  environmentId = ENV_A,
  body = "Give the Save button more padding.",
  operationId = `op-${Math.random().toString(36).slice(2)}`,
  assetIds: string[] = [],
) {
  return service.create({
    environmentId,
    operationId,
    capture: { ...fixtureCaptureInput("element"), assetIds },
    body,
  });
}
