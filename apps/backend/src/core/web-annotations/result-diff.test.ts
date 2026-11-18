/**
 * Advisory result diffs (to-do 0047 (retired) task 2): the backend decodes the stored images
 * of an original capture and its after-capture with real `sharp`, leaves out
 * redactions and the unstable-region mask, and refuses incomparable captures
 * with reasons. The capability gates the command and the agent tool option.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import type {
  WebAnnotationCaptureInput,
  WebAnnotationGeometry,
  WebAnnotationResultCaptureMetadata,
} from "@orkestrator/protocol/web-annotations";
import {
  fixtureCaptureInput,
  fixtureDestination,
} from "@orkestrator/protocol/testing/web-annotations-fixtures";
import type { WebAnnotationRaster } from "@orkestrator/protocol/web-annotations-diff";
import { crc32, PNG_SIGNATURE } from "./assets.js";
import type { WebAnnotationServiceOptions } from "./context.js";
import { resultDiffPreconditions } from "./result-diff.js";
import type { WebAnnotationService } from "./service.js";
import { ENV_A, createHarness, type ServiceHarness } from "./test-support.js";
import { WebAnnotationToolLimiter, registerWebAnnotationTools } from "./tools.js";

let harness: ServiceHarness;
afterEach(async () => {
  await harness?.cleanup();
});

const WIDTH = 64;
const HEIGHT = 40;
const SCROLL = { x: 0, y: 120 };
const BACKGROUND: [number, number, number] = [240, 240, 240];
const INK: [number, number, number] = [20, 20, 160];

type Rect = { x: number; y: number; w: number; h: number };
const inside = (x: number, y: number, r: Rect) =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.byteLength);
  out.writeUInt32BE(data.byteLength, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.byteLength), 8 + data.byteLength);
  return out;
}

/** An RGB PNG painted with `INK` inside `blocks` on a flat background. */
function png(blocks: Rect[], width = WIDTH, height = HEIGHT): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = 1 + width * 3;
  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = blocks.some((block) => inside(x, y, block)) ? INK : BACKGROUND;
      rows.set(color, y * stride + 1 + x * 3);
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function geometry(width = WIDTH, height = HEIGHT): WebAnnotationGeometry {
  return {
    viewport: { width, height },
    scroll: { ...SCROLL },
    zoomFactor: 1,
    devicePixelRatio: 2,
    image: { width, height, scale: 1, reduced: false },
  };
}

let stageCount = 0;
async function stage(service: WebAnnotationService, bytes: Buffer): Promise<string> {
  stageCount += 1;
  const staged = await service.stageAsset({
    environmentId: ENV_A,
    operationId: `op-asset-${stageCount}`,
    mediaType: "image/png",
    data: bytes.toString("base64"),
  });
  return staged.asset.id;
}

/** A note whose original capture shows `blocks`, sent as request `req-1`. */
async function noteWithRequest(service: WebAnnotationService, blocks: Rect[] = []) {
  const assetId = await stage(service, png(blocks));
  const receipt = await service.create({
    environmentId: ENV_A,
    operationId: "op-note",
    capture: { ...fixtureCaptureInput("element"), geometry: geometry(), assetIds: [assetId] },
    body: "Add a badge next to Save.",
  });
  const { annotation } = await service.get(ENV_A, receipt.annotationId);
  const preparation = await service.prepare({
    environmentId: ENV_A,
    operation: "implement",
    destination: fixtureDestination,
    annotations: [
      {
        annotationId: annotation.id,
        expectedContentRevision: annotation.contentRevision,
        expectedCaptureId: annotation.currentCaptureId,
      },
    ],
    instruction: "",
  });
  await service.send({
    environmentId: ENV_A,
    preparationId: preparation.preparationId,
    requestId: "req-1",
    bodyHash: preparation.bodyHash,
  });
  return { annotationId: annotation.id, originalCaptureId: annotation.currentCaptureId };
}

const STABLE: WebAnnotationResultCaptureMetadata = {
  zoomFactor: 1,
  deviceScaleFactor: 2,
  scroll: { ...SCROLL },
  stability: "stable",
  masks: [],
  unstableRegions: [],
};

let resultCount = 0;
async function captureResult(
  service: WebAnnotationService,
  options: {
    image?: Buffer | null;
    capture?: Partial<WebAnnotationCaptureInput>;
    metadata?: WebAnnotationResultCaptureMetadata;
  } = {},
) {
  resultCount += 1;
  const assetIds = options.image === null ? [] : [await stage(service, options.image ?? png([]))];
  return service.captureResult({
    environmentId: ENV_A,
    operationId: `op-result-${resultCount}`,
    requestId: "req-1",
    capture: {
      ...fixtureCaptureInput("page"),
      producer: "result-capture",
      geometry: geometry(),
      assetIds,
      ...options.capture,
    },
    ...(options.metadata ?? STABLE),
  });
}

async function diffOptionHarness(overrides: Partial<WebAnnotationServiceOptions> = {}) {
  harness = await createHarness(overrides);
  return harness.service;
}

describe("advisory result diffs", () => {
  test("marks the changed region and leaves out redactions and moving regions", async () => {
    const service = await diffOptionHarness();
    await noteWithRequest(service, [{ x: 0, y: 0, w: 8, h: 8 }]);
    // A new badge, a change under a redaction, and an animated corner.
    const after = png([
      { x: 20, y: 10, w: 8, h: 8 },
      { x: 56, y: 32, w: 8, h: 8 },
    ]);
    const { captureId, result } = await captureResult(service, {
      image: after,
      metadata: {
        ...STABLE,
        masks: [{ source: "sensitive-field", rect: { x: 0, y: 120, width: 8, height: 8 } }],
        unstableRegions: [{ x: 56, y: 152, width: 8, height: 8 }],
      },
    });
    expect(result.observations?.[0]?.comparison.unstableRegions).toEqual([
      { x: 56, y: 152, width: 8, height: 8 },
    ]);
    const diff = await service.resultDiff(ENV_A, captureId);
    expect(diff).toMatchObject({
      status: "compared",
      advisory: true,
      afterCaptureId: captureId,
      image: { width: WIDTH, height: HEIGHT },
      scale: 1,
      changedPixels: 64,
      excludedPixels: 128,
      comparedPixels: WIDTH * HEIGHT - 128,
      truncatedRegions: false,
      excluded: { masks: 1, unstableRegions: 1 },
      regions: [
        {
          rect: { x: 16, y: 8, width: 16, height: 16 },
          cssRect: { x: 16, y: 8, width: 16, height: 16 },
          changedPixels: 64,
        },
      ],
    });
    expect(diff.status === "compared" && diff.changedRatio).toBe(
      Math.round((64 / (WIDTH * HEIGHT - 128)) * 10_000) / 10_000,
    );
    // Captures are immutable, so asking again gives the same answer.
    expect(await service.resultDiff(ENV_A, captureId)).toEqual(diff);
  });

  test("reports no change, still as advisory, when only masked content moved", async () => {
    const service = await diffOptionHarness();
    await noteWithRequest(service);
    const { captureId } = await captureResult(service, {
      image: png([{ x: 56, y: 32, w: 8, h: 8 }]),
      metadata: { ...STABLE, unstableRegions: [{ x: 56, y: 152, width: 8, height: 8 }] },
    });
    expect(await service.resultDiff(ENV_A, captureId)).toMatchObject({
      status: "compared",
      advisory: true,
      changedPixels: 0,
      regions: [],
    });
  });

  test("refuses captures that cannot be compared, naming every reason", async () => {
    const service = await diffOptionHarness();
    await noteWithRequest(service);
    const { captureId } = await captureResult(service, {
      image: png([], 80, 40),
      capture: { geometry: geometry(80, 40) },
      metadata: { ...STABLE, unstableRegions: undefined },
    });
    const diff = await service.resultDiff(ENV_A, captureId);
    expect(diff).toMatchObject({ status: "incomparable", advisory: true });
    expect(diff.status === "incomparable" && diff.reasons.map((reason) => reason.code)).toEqual([
      "viewport",
      "image-size",
      "no-unstable-mask",
    ]);
    expect(diff.status === "incomparable" && diff.reasons[2]!.message).toContain(
      "unstable-region mask",
    );
  });

  test("refuses an unsettled page, another scroll position and a text-only capture", async () => {
    const service = await diffOptionHarness();
    await noteWithRequest(service);
    const unsettled = await captureResult(service, {
      metadata: { ...STABLE, stability: "unstable", scroll: { x: 0, y: 400 } },
    });
    const first = await service.resultDiff(ENV_A, unsettled.captureId);
    expect(first.status === "incomparable" && first.reasons.map((reason) => reason.code)).toEqual([
      "scroll",
      "unstable",
    ]);
    const textOnly = await captureResult(service, {
      image: null,
      capture: {
        geometry: { ...geometry(), image: null },
        redaction: { ...fixtureCaptureInput().redaction, imageExcluded: true },
      },
    });
    const second = await service.resultDiff(ENV_A, textOnly.captureId);
    expect(second.status === "incomparable" && second.reasons.map((reason) => reason.code)).toEqual(
      ["image-excluded"],
    );
  });

  test("an original capture is not a result capture; an unknown id is not found", async () => {
    const service = await diffOptionHarness();
    const { originalCaptureId } = await noteWithRequest(service);
    expect(await service.resultDiff(ENV_A, originalCaptureId)).toMatchObject({
      status: "incomparable",
      beforeCaptureId: null,
      reasons: [{ code: "not-result-capture" }],
    });
    await expect(service.resultDiff(ENV_A, "capture-missing")).rejects.toThrow(/not found/i);
  });

  test("refuses images over the pixel ceiling before decoding", async () => {
    let decoded = 0;
    const service = await diffOptionHarness({
      resultDiffOptions: {
        limits: { maxPixels: 100 },
        decode: async () => {
          decoded += 1;
          throw new Error("must not decode");
        },
      },
    });
    await noteWithRequest(service);
    const { captureId } = await captureResult(service);
    expect(await service.resultDiff(ENV_A, captureId)).toMatchObject({
      status: "incomparable",
      reasons: [{ code: "too-large" }],
    });
    expect(decoded).toBe(0);
  });

  test("a failed decode is a reason, not a misleading diff", async () => {
    const service = await diffOptionHarness({
      resultDiffOptions: {
        decode: async () => {
          throw new Error("corrupt");
        },
      },
    });
    await noteWithRequest(service);
    const { captureId } = await captureResult(service);
    expect(await service.resultDiff(ENV_A, captureId)).toMatchObject({
      status: "incomparable",
      reasons: [{ code: "decode-failed" }],
    });
  });

  test("stops at the deadline and refuses diffs past the concurrency limit", async () => {
    const pending = Promise.withResolvers<WebAnnotationRaster>();
    const service = await diffOptionHarness({
      resultDiffOptions: {
        limits: { timeoutMs: 30, maxConcurrent: 1 },
        decode: () => pending.promise,
      },
    });
    await noteWithRequest(service);
    const { captureId } = await captureResult(service);
    const slow = service.resultDiff(ENV_A, captureId);
    // Let the first diff take its slot before the second asks.
    await Bun.sleep(5);
    expect(await service.resultDiff(ENV_A, captureId)).toMatchObject({
      reasons: [{ code: "busy" }],
    });
    expect(await slow).toMatchObject({ reasons: [{ code: "timeout" }] });
    // The abandoned decode still holds the slot until it actually stops.
    expect(await service.resultDiff(ENV_A, captureId)).toMatchObject({
      reasons: [{ code: "busy" }],
    });
    pending.reject(new Error("stopped"));
    await Bun.sleep(1);
    expect(await service.resultDiff(ENV_A, captureId)).toMatchObject({
      reasons: [{ code: "decode-failed" }],
    });
  });
});

describe("result diff preconditions", () => {
  test("a route or service difference is refused even without recorded differences", async () => {
    const service = await diffOptionHarness();
    await noteWithRequest(service);
    const { captureId, result } = await captureResult(service);
    const capture = await service.capture(ENV_A, captureId);
    const original = await service.capture(
      ENV_A,
      result.observations![0]!.comparison.comparedCaptureId,
    );
    expect(resultDiffPreconditions(original, capture, { before: null, after: null })).toEqual([]);
    const moved = { ...capture, page: { ...capture.page, route: "/elsewhere" } };
    expect(resultDiffPreconditions(original, moved, { before: null, after: null })).toEqual([
      "route",
    ]);
  });
});

describe("the resultDiffs capability", () => {
  test("is advertised by default and gates the command and the agent tool option", async () => {
    const service = await diffOptionHarness();
    expect((await service.capabilities(ENV_A)).operations.resultDiffs).toBe(true);
    expect(service.toolHost().resultDiff).toBeFunction();

    await harness.cleanup();
    const off = await diffOptionHarness({ resultDiffs: false });
    expect((await off.capabilities(ENV_A)).operations.resultDiffs).toBe(false);
    expect(off.toolHost().resultDiff).toBeUndefined();
    await noteWithRequest(off);
    const { captureId } = await captureResult(off);
    await expect(off.resultDiff(ENV_A, captureId)).rejects.toThrow("not available");
  });
});

type ToolResult = { structuredContent: Record<string, unknown>; isError?: boolean };
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function registerTools(service: WebAnnotationService) {
  const handlers = new Map<string, ToolHandler>();
  const descriptions = new Map<string, string>();
  const server = {
    registerTool: (name: string, config: { description: string }, handler: ToolHandler) => {
      handlers.set(name, handler);
      descriptions.set(name, config.description);
    },
  };
  registerWebAnnotationTools(
    server as never,
    service.toolHost(),
    { environmentId: ENV_A, tabId: fixtureDestination.tabId },
    new WebAnnotationToolLimiter(),
  );
  return { handlers, descriptions };
}

describe("the agent's diff option", () => {
  test("returns the advisory diff of the latest after-capture, or says there is none", async () => {
    const service = await diffOptionHarness();
    const { annotationId } = await noteWithRequest(service);
    const { handlers, descriptions } = registerTools(service);
    expect(descriptions.get("get_annotation_evidence")).toContain("diff: true");
    const evidence = handlers.get("get_annotation_evidence")!;

    const before = await evidence({ requestId: "req-1", annotationId, diff: true });
    expect(before.structuredContent).toMatchObject({ ok: true, diff: null });
    expect(String(before.structuredContent.diffNote)).toContain("Capture current result");

    const { captureId } = await captureResult(service, {
      image: png([{ x: 20, y: 10, w: 8, h: 8 }]),
    });
    const after = await evidence({ requestId: "req-1", annotationId, diff: true });
    expect(after.structuredContent).toMatchObject({
      ok: true,
      annotation: { id: annotationId },
      diff: { status: "compared", advisory: true, afterCaptureId: captureId, changedPixels: 64 },
    });

    // Without the option the evidence is exactly what it was.
    const plain = await evidence({ requestId: "req-1", annotationId });
    expect(plain.structuredContent).not.toHaveProperty("diff");

    const foreign = await evidence({
      requestId: "req-1",
      annotationId,
      resultCaptureId: "capture-x",
    });
    expect(foreign.structuredContent).toMatchObject({
      diff: { status: "incomparable", reasons: [{ code: "not-result-capture" }] },
    });
  });

  test("is not offered while the capability is off", async () => {
    const service = await diffOptionHarness({ resultDiffs: false });
    const { descriptions } = registerTools(service);
    expect(descriptions.get("get_annotation_evidence")).not.toContain("diff");
  });
});
