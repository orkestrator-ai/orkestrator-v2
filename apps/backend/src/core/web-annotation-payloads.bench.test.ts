/**
 * Performance regression fixtures for the worst payloads web annotations allow.
 *
 * Every case drives the real service, storage and brief compiler (only the
 * native dispatch port is faked) at a limit from `WEB_ANNOTATION_LIMITS`, and
 * asserts the structural bound first: bytes, counts, pages, and "nothing is
 * dropped silently". Time and memory budgets are deliberately generous so a
 * busy CI host does not flake; they exist to catch an order-of-magnitude
 * regression (a whole-history load, a quadratic manifest rewrite, an image
 * held twice), not to set an SLA. Reproduce and record measurements with:
 *
 *   WEB_ANNOTATION_BENCH_OUT=/tmp/web-annotation-bench.json \
 *     mise run test:logged -- --name web-annotation-bench -- \
 *     bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
 *     ./src/core/web-annotation-payloads.bench.test.ts --parallel=1
 *
 * All content is synthetic.
 */
import { afterAll, afterEach, describe, expect, jest, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_LIMITS,
  webAnnotationUtf8Bytes,
  type WebAnnotationCaptureInput,
} from "@orkestrator/protocol/web-annotations";
import {
  fixtureAnnotation,
  fixtureCaptureInput,
  fixtureDestination,
} from "@orkestrator/protocol/web-annotations-fixtures";
import { validateWebAnnotationCaptureInput } from "@orkestrator/protocol/web-annotations-validation";
import { PNG_SIGNATURE, crc32 } from "./web-annotation-assets.js";
import {
  compileWebAnnotationBrief,
  composeWebAnnotationDispatchText,
} from "./web-annotation-brief.js";
import { ENV_A, createHarness, type ServiceHarness } from "./web-annotation-test-support.js";
import { rejectionDetail } from "./web-annotation-test-helpers.js";

jest.setTimeout(180_000);

const KiB = 1024;
const MiB = 1024 * KiB;
const L = WEB_ANNOTATION_LIMITS;
const OUTPUT_PATH = process.env.WEB_ANNOTATION_BENCH_OUT;
const measurements: Record<string, Record<string, number>> = {};

let harness: ServiceHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});
afterAll(async () => {
  if (OUTPUT_PATH) await writeFile(OUTPUT_PATH, `${JSON.stringify(measurements, null, 2)}\n`);
});

/** A harness with the production brief compiler and dispatch text. */
function realBriefHarness() {
  return createHarness({
    compileBrief: compileWebAnnotationBrief,
    composeText: composeWebAnnotationDispatchText,
  });
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}

/** Peak RSS growth while `fn` runs, sampled every 5 ms (generous, not exact). */
async function peakRssGrowth<T>(fn: () => Promise<T>): Promise<{ value: T; bytes: number }> {
  Bun.gc(true);
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  try {
    const value = await fn();
    peak = Math.max(peak, process.memoryUsage().rss);
    return { value, bytes: peak - baseline };
  } finally {
    clearInterval(timer);
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.byteLength);
  out.writeUInt32BE(data.byteLength, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.byteLength), 8 + data.byteLength);
  return out;
}

/** A valid RGB PNG of incompressible noise, so its encoded size tracks its pixels. */
function noisePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = 1 + width * 3;
  const rows = randomBytes(height * stride);
  for (let y = 0; y < height; y++) rows[y * stride] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The largest noise PNG within both the byte and dimension limits. */
function largestAllowedPng(): Buffer {
  const width = L.imageMaxDimension;
  // Uncompressed rows plus deflate block overhead must stay under the byte cap.
  const height = Math.min(
    L.imageMaxDimension,
    Math.floor((L.imageBytes - 64 * KiB) / (1 + width * 3)),
  );
  const png = noisePng(width, height);
  expect(png.byteLength).toBeLessThanOrEqual(L.imageBytes);
  expect(png.byteLength).toBeGreaterThan(L.imageBytes - 256 * KiB);
  return png;
}

/**
 * A capture at every per-field evidence bound (text 4,000, HTML 8,000,
 * 32 attributes and 48 styles at their value limits). The field bounds cap
 * it below the 64 KiB metadata limit, so this is the largest valid capture.
 */
function heavyCapture(index: number): WebAnnotationCaptureInput {
  const base = fixtureCaptureInput("element");
  const fill = (seed: string, length: number) =>
    seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
  const capture: WebAnnotationCaptureInput = {
    ...base,
    evidence: {
      ...base.evidence!,
      text: fill(`Synthetic evidence ${index} `, 4_000),
      html: fill(`<span data-synthetic="${index}">cell</span>`, 8_000),
      attributes: Object.fromEntries(
        Array.from({ length: 32 }, (_, key) => [`data-a${key}`, fill(`v${index}-`, 500)]),
      ),
      styles: Object.fromEntries(
        Array.from({ length: 48 }, (_, key) => [`--s${key}`, fill(`${index}px `, 300)]),
      ),
    },
  };
  const validation = validateWebAnnotationCaptureInput(capture);
  expect(validation.ok ? "ok" : validation.error).toBe("ok");
  expect(webAnnotationUtf8Bytes(JSON.stringify(capture))).toBeGreaterThan(40 * KiB);
  return capture;
}

async function createMany(count: number, body: (index: number) => string, assetIds?: string[]) {
  const service = harness!.service;
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const receipt = await service.create({
      environmentId: ENV_A,
      operationId: `op-bench-${index}`,
      capture: { ...heavyCapture(index), assetIds: assetIds?.[index] ? [assetIds[index]!] : [] },
      body: body(index),
    });
    ids.push(receipt.annotationId);
  }
  return ids;
}

async function selections(ids: string[], desiredOutcome: string | null = null) {
  const out = [];
  for (const annotationId of ids) {
    const { annotation } = await harness!.service.get(ENV_A, annotationId);
    out.push({
      annotationId,
      expectedContentRevision: annotation.contentRevision,
      expectedCaptureId: annotation.currentCaptureId,
      desiredOutcome,
    });
  }
  return out;
}

describe("worst-case request briefs", () => {
  test("the maximum annotation count compiles within the brief budget and sends once", async () => {
    harness = await realBriefHarness();
    const ids = await createMany(L.briefAnnotations, (index) =>
      `Note ${index}: ${"tighten spacing and align the label. ".repeat(40)}`.slice(0, 1_500),
    );
    const annotations = await selections(ids, "Match the approved spacing scale.");
    const { value: preparation, ms } = await timed(() =>
      harness!.service.prepare({
        environmentId: ENV_A,
        operation: "implement",
        destination: fixtureDestination,
        annotations,
        instruction: "Apply every note. ".repeat(400).slice(0, L.instructionChars),
      }),
    );
    measurements.maxCountBrief = { ms, briefBytes: preparation.briefBytes };
    expect(preparation.sendable).toBe(true);
    expect(preparation.briefBytes).toBeLessThanOrEqual(L.briefBytes);
    expect(webAnnotationUtf8Bytes(preparation.briefPreview)).toBe(preparation.briefBytes);
    // Every selected annotation is present; overflow is recorded, never silent.
    expect(preparation.selections.map((selection) => selection.annotationId)).toEqual(ids);
    expect(preparation.evidence.items.map((item) => item.annotationId)).toEqual(ids);
    for (const item of preparation.evidence.items) expect(item.included).toContain("intent");
    const omitted = preparation.evidence.items.reduce((sum, item) => sum + item.omitted.length, 0);
    expect(omitted).toBeGreaterThan(0);
    expect(ms).toBeLessThan(10_000);

    const { value: sent, ms: sendMs } = await timed(() =>
      harness!.service.send({
        environmentId: ENV_A,
        preparationId: preparation.preparationId,
        requestId: "req-bench-max-count",
        bodyHash: preparation.bodyHash,
      }),
    );
    measurements.maxCountSend = { ms: sendMs };
    expect(sent.request.selections).toHaveLength(L.briefAnnotations);
    expect(harness.dispatch.published).toHaveLength(1);
    expect(webAnnotationUtf8Bytes(harness.dispatch.published[0]!.text)).toBeLessThanOrEqual(
      L.briefBytes + 1 * KiB,
    );
    for (const id of ids) {
      expect((await harness.service.get(ENV_A, id)).annotation.activeRequestId).toBe(
        "req-bench-max-count",
      );
    }
    expect(sendMs).toBeLessThan(10_000);
  });

  test("maximum text at maximum count is refused as over capacity and reserves nothing", async () => {
    harness = await realBriefHarness();
    const ids = await createMany(L.briefAnnotations, (index) =>
      `${index} ${"All synthetic intent text that must not be dropped. ".repeat(200)}`.slice(
        0,
        L.entryChars,
      ),
    );
    const annotations = await selections(ids, "d".repeat(L.desiredOutcomeChars));
    const { value: preparation, ms } = await timed(() =>
      harness!.service.prepare({
        environmentId: ENV_A,
        operation: "implement",
        destination: fixtureDestination,
        annotations,
        instruction: "i".repeat(L.instructionChars),
      }),
    );
    measurements.maxTextBrief = { ms, briefBytes: preparation.briefBytes };
    // 20 × 8,000-character intents cannot fit in 64 KiB: essentials never get
    // truncated to make room, so the request is blocked instead.
    expect(preparation.sendable).toBe(false);
    expect(preparation.issues.some((issue) => issue.severity === "blocker")).toBe(true);
    await expect(
      harness.service.send({
        environmentId: ENV_A,
        preparationId: preparation.preparationId,
        requestId: "req-bench-over",
        bodyHash: preparation.bodyHash,
      }),
    ).rejects.toThrow();
    for (const id of ids) {
      expect((await harness.service.get(ENV_A, id)).annotation.activeRequestId).toBeNull();
    }
    expect(harness.dispatch.published).toHaveLength(0);
    expect(ms).toBeLessThan(10_000);
  });
});

describe("worst-case images", () => {
  test("the largest allowed image stages within budget; one byte or pixel more is refused before staging", async () => {
    harness = await createHarness();
    const png = largestAllowedPng();
    const data = png.toString("base64");
    const { value: staged, bytes } = await peakRssGrowth(() =>
      timed(() =>
        harness!.service.stageAsset({
          environmentId: ENV_A,
          operationId: "op-bench-max-image",
          mediaType: "image/png",
          data,
        }),
      ),
    );
    measurements.maxImageStage = { ms: staged.ms, pngBytes: png.byteLength, peakRssGrowth: bytes };
    expect(staged.value.asset.bytes).toBe(png.byteLength);
    expect(staged.ms).toBeLessThan(15_000);
    // A handful of copies of an 8 MiB image is expected; hundreds of MiB is a leak.
    expect(bytes).toBeLessThan(512 * MiB);

    const tooWide = noisePng(L.imageMaxDimension + 1, 4).toString("base64");
    await expect(
      harness.service.stageAsset({
        environmentId: ENV_A,
        operationId: "op-bench-too-wide",
        mediaType: "image/png",
        data: tooWide,
      }),
    ).rejects.toThrow();
    const oversized = Buffer.concat([png, Buffer.alloc(L.imageBytes - png.byteLength + 1)]);
    await expect(
      harness.service.stageAsset({
        environmentId: ENV_A,
        operationId: "op-bench-too-large",
        mediaType: "image/png",
        data: oversized.toString("base64"),
      }),
    ).rejects.toThrow();
  });

  test("attachments stop at the per-request image budget and record what was left out", async () => {
    harness = await realBriefHarness();
    // 20 distinct ~1 MiB images: 20 MiB selected against a 16 MiB request budget.
    const assetIds: string[] = [];
    for (let index = 0; index < L.briefAttachments; index++) {
      const staged = await harness.service.stageAsset({
        environmentId: ENV_A,
        operationId: `op-bench-asset-${index}`,
        mediaType: "image/png",
        data: noisePng(600, 580).toString("base64"),
      });
      assetIds.push(staged.asset.id);
    }
    const ids = await createMany(L.briefAnnotations, (index) => `Image note ${index}`, assetIds);
    const { value: preparation, ms } = await timed(async () =>
      harness!.service.prepare({
        environmentId: ENV_A,
        operation: "implement",
        destination: fixtureDestination,
        annotations: await selections(ids),
        instruction: "",
      }),
    );
    const attachedBytes = preparation.attachments.reduce((sum, item) => sum + item.bytes, 0);
    measurements.attachmentBudget = {
      ms,
      attachments: preparation.attachments.length,
      attachedBytes,
    };
    expect(preparation.attachments.length).toBeLessThanOrEqual(L.briefAttachments);
    expect(attachedBytes).toBeLessThanOrEqual(L.briefAttachmentBytes);
    expect(preparation.attachments.length).toBeLessThan(L.briefAttachments);
    const withoutImage = preparation.evidence.items.filter(
      (item) => !item.included.includes("image"),
    );
    expect(withoutImage.length).toBe(L.briefAnnotations - preparation.attachments.length);
    for (const item of withoutImage) {
      expect([...item.omitted, ...item.unavailable]).toContain("image");
    }
    expect(preparation.evidence.imageBytes).toBe(attachedBytes);
    expect(ms).toBeLessThan(15_000);
  });
});

describe("large collections", () => {
  test("a full environment pages in bounded pages without loading whole history", async () => {
    harness = await createHarness();
    const store = await harness.service.storage.environment(ENV_A);
    await store.mutate((tx) => {
      tx.markEssential();
      for (let index = 0; index < L.environmentAnnotations; index++) {
        const id = `annotation-bench-${String(index).padStart(4, "0")}`;
        tx.manifest.annotations[id] = fixtureAnnotation({
          id,
          environmentId: ENV_A,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
          latestIntent: `Synthetic intent ${index} `.repeat(20),
        });
      }
      tx.markDirty();
    });

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let slowestPageMs = 0;
    let largestPageBytes = 0;
    const started = performance.now();
    do {
      const { value: page, ms } = await timed(() =>
        harness!.service.list({
          environmentId: ENV_A,
          filter: { state: "all" },
          limit: L.listPageItems,
          ...(cursor ? { cursor } : {}),
        }),
      );
      pages++;
      slowestPageMs = Math.max(slowestPageMs, ms);
      largestPageBytes = Math.max(largestPageBytes, webAnnotationUtf8Bytes(JSON.stringify(page)));
      expect(page.items.length).toBeLessThanOrEqual(L.listPageItems);
      expect(page.total).toBe(L.environmentAnnotations);
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.nextCursor ?? undefined;
      expect(pages).toBeLessThanOrEqual(L.environmentAnnotations / L.listPageItems + 1);
    } while (cursor);
    const totalMs = performance.now() - started;
    measurements.fullCollectionPaging = { pages, slowestPageMs, largestPageBytes, totalMs };
    expect(seen.size).toBe(L.environmentAnnotations);
    expect(largestPageBytes).toBeLessThanOrEqual(L.listPageBytes);
    expect(slowestPageMs).toBeLessThan(2_000);
    expect(totalMs).toBeLessThan(30_000);

    // The next annotation is refused with usage totals, not accepted or evicted.
    const refused = await rejectionDetail(
      harness.service.create({
        environmentId: ENV_A,
        operationId: "op-bench-over",
        capture: fixtureCaptureInput("element"),
        body: "One too many",
      }),
    );
    expect(refused.message).toContain(WEB_ANNOTATION_CAPACITY);
    expect(refused.detail).toMatchObject({ resource: "annotations" });
  });

  test("creation cost stays flat as the collection grows (no whole-history rewrite)", async () => {
    harness = await createHarness();
    const batch = 60;
    const batchMs: number[] = [];
    for (let round = 0; round < 3; round++) {
      const { ms } = await timed(async () => {
        for (let index = 0; index < batch; index++) {
          await harness!.service.create({
            environmentId: ENV_A,
            operationId: `op-growth-${round}-${index}`,
            capture: fixtureCaptureInput("element"),
            body: `Growth note ${round}-${index}`,
          });
        }
      });
      batchMs.push(ms);
    }
    measurements.creationGrowth = { first: batchMs[0]!, second: batchMs[1]!, third: batchMs[2]! };
    // Quadratic manifest growth would make the third batch several times slower.
    expect(batchMs[2]!).toBeLessThan(Math.max(batchMs[0]! * 4, 2_000));
    expect(batchMs.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(60_000);
  });
});
