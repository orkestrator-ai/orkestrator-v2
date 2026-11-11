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

  test("an abort that lands after the read has started rejects with its reason, not a corrupt store", async () => {
    // A large asset, so the open, stat and read are all still in flight when
    // the abort lands; whichever of them observes it, the caller gets the
    // signal's reason.
    const large = Buffer.alloc(32 * 1024 * 1024, 7);
    const largeSha = sha256Hex(large);
    const target = store.assetPath(ENVIRONMENT, largeSha);
    writeFileSync(target, large);
    const controller = new AbortController();
    const reason = new Error("load deadline");
    const pending = store
      .readAsset(ENVIRONMENT, largeSha, large.byteLength, { signal: controller.signal })
      .catch((error: unknown) => error);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    // The handle was released: the same asset still reads in full afterwards.
    const again = await store.readAsset(ENVIRONMENT, largeSha, large.byteLength, {
      signal: new AbortController().signal,
    });
    expect(again.equals(large)).toBe(true);
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
