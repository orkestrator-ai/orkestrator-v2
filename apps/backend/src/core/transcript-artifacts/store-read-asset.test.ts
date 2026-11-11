/**
 * `TranscriptArtifactStore.readAsset` under a caller's signal: the artifact
 * content server aborts a slow load at its deadline, and that must stop the
 * read without being reported as corrupt storage.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { sha256Hex } from "./dependency-manifest.js";
import { ArtifactFailure } from "@orkestrator/protocol/transcript-artifacts";
import { TranscriptArtifactStore } from "./store.js";

const ENVIRONMENT = "env-read-asset";
const BYTES = Buffer.from("<!doctype html><p>prepared</p>");
const SHA = sha256Hex(BYTES);

let dataDir: string;
let store: TranscriptArtifactStore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "artifact-read-asset-"));
  store = new TranscriptArtifactStore({ dataDir });
  const target = store.assetPath(ENVIRONMENT, SHA);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, BYTES);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("readAsset", () => {
  test("reads and verifies the bytes with a live signal", async () => {
    const signal = new AbortController().signal;
    const bytes = await store.readAsset(ENVIRONMENT, SHA, BYTES.byteLength, { signal });
    expect(Buffer.from(bytes).equals(BYTES)).toBe(true);
  });

  test("an aborted read rejects with the signal's reason, not a corrupt store", async () => {
    const controller = new AbortController();
    const reason = new Error("load deadline");
    controller.abort(reason);
    const outcome = await store
      .readAsset(ENVIRONMENT, SHA, BYTES.byteLength, { signal: controller.signal })
      .catch((error: unknown) => error);
    expect(outcome).toBe(reason);
  });

  test("a missing asset is still storage_corrupt", async () => {
    const outcome = await store
      .readAsset(ENVIRONMENT, "0".repeat(64), BYTES.byteLength, {
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(ArtifactFailure);
    expect((outcome as ArtifactFailure).error.code).toBe("storage_corrupt");
  });
});
