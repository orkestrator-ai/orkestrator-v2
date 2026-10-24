import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { WebAnnotationRegionTarget } from "@orkestrator/protocol/web-annotations";
import { fixtureCaptureInput } from "@orkestrator/protocol/testing/web-annotations-fixtures";
import { regionCropRelation } from "./web-annotation-service-threads.js";
import {
  ENV_A,
  createHarness,
  makePng,
  type ServiceHarness,
} from "./web-annotation-test-support.js";

let harness: ServiceHarness;
afterEach(async () => {
  await harness?.cleanup();
});

async function stage(width: number, height: number, seed: number) {
  const png = makePng(width, height, seed);
  const staged = await harness.service.stageAsset({
    environmentId: ENV_A,
    operationId: `op-asset-${width}x${height}-${seed}`,
    mediaType: "image/png",
    data: png.toString("base64"),
  });
  return { id: staged.asset.id, bytes: png.byteLength, digest: sha256(png) };
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("region crop relation", () => {
  const region = fixtureCaptureInput("region").target as WebAnnotationRegionTarget;

  test("records a crop whose size matches the target's image rectangle", () => {
    expect(
      regionCropRelation(region, [
        { id: "full", width: 1280, height: 800 },
        { id: "crop", width: 320, height: 120 },
      ]),
    ).toEqual({
      assetId: "crop",
      sourceAssetId: "full",
      sourceRect: { x: 20, y: 40, width: 320, height: 120 },
    });
  });

  test("clamps to the source like the desktop crop, within one pixel", () => {
    const edge = { ...region, imageRect: { x: 1100, y: 700, width: 320.4, height: 120 } };
    expect(
      regionCropRelation(edge, [
        { id: "full", width: 1280, height: 800 },
        { id: "crop", width: 181, height: 100 },
      ]),
    ).not.toBeNull();
  });

  test("records nothing for other shapes", () => {
    const full = { id: "full", width: 1280, height: 800 };
    expect(regionCropRelation(region, [full])).toBeNull();
    expect(regionCropRelation(region, [full, { id: "crop", width: 300, height: 120 }])).toBeNull();
    expect(regionCropRelation({ ...region, imageRect: null }, [full, full])).toBeNull();
    expect(
      regionCropRelation(fixtureCaptureInput("element").target, [
        full,
        { id: "crop", width: 320, height: 120 },
      ]),
    ).toBeNull();
  });
});

describe("backend-assigned capture fields", () => {
  test("a region capture gets its crop relation and a client-declared producer", async () => {
    harness = await createHarness();
    const full = await stage(1280, 800, 1);
    const crop = await stage(320, 120, 2);
    const receipt = await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-region",
      capture: { ...fixtureCaptureInput("region"), assetIds: [full.id, crop.id] },
      body: "This card is cramped.",
    });
    const capture = await harness.service.capture(ENV_A, receipt.captureId!);
    expect(capture.regionCrop).toEqual({
      assetId: crop.id,
      sourceAssetId: full.id,
      sourceRect: { x: 20, y: 40, width: 320, height: 120 },
    });
    expect(capture.producer).toBe("desktop-native");
    expect(capture.producerSource).toBe("client-declared");

    // Summaries carry the exact stored sizes the batch tray counts.
    const listed = await harness.service.list({ environmentId: ENV_A });
    expect(listed.items[0]!.currentCaptureAssets).toEqual([
      { assetId: full.id, digest: full.digest, bytes: full.bytes },
      { assetId: crop.id, digest: crop.digest, bytes: crop.bytes },
    ]);
  });

  test("a second image that is not the target's crop carries no relation", async () => {
    harness = await createHarness();
    const full = await stage(1280, 800, 1);
    const other = await stage(64, 64, 3);
    const receipt = await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-region-mismatch",
      capture: { ...fixtureCaptureInput("region"), assetIds: [full.id, other.id] },
      body: "Mismatched crop.",
    });
    const capture = await harness.service.capture(ENV_A, receipt.captureId!);
    expect(capture.regionCrop).toBeUndefined();
  });

  test("a payload naming a relation or a producer basis is refused", async () => {
    harness = await createHarness();
    const base = fixtureCaptureInput("region");
    for (const capture of [
      { ...base, regionCrop: { assetId: "a", sourceAssetId: "b", sourceRect: base.target } },
      { ...base, producerSource: "backend" },
      { ...base, target: { ...base.target, parentCaptureId: "capture-forged" } },
    ]) {
      await expect(
        harness.service.create({
          environmentId: ENV_A,
          operationId: `op-forged-${Math.random().toString(36).slice(2)}`,
          capture: capture as never,
          body: "Forged.",
        }),
      ).rejects.toThrow("assigned by the receiver");
    }
  });
});
