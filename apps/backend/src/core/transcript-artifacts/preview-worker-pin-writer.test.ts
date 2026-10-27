/**
 * docker/artifact-preview-worker/write-pin.ts, which the publish workflow and
 * publish.sh use to record a published image: it writes only pins the
 * backend accepts and leaves an identical pin untouched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPublishedWorkerImage } from "./preview-worker-prepare.js";

const root = join(import.meta.dir, "../../../../..");
const script = join(root, "docker/artifact-preview-worker/write-pin.ts");
const checkedIn = join(root, "docker/artifact-preview-worker/published-image.json");
const MANIFEST = `sha256:${"a".repeat(64)}`;
const CONTEXT = `sha256:${"b".repeat(64)}`;
const IMAGE = "ghcr.io/orkestrator-ai/orkestrator-v2/artifact-preview-worker";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pinCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "ork-write-pin-"));
  dirs.push(dir);
  const file = join(dir, "published-image.json");
  copyFileSync(checkedIn, file);
  return file;
}

function writePin(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString().trim() };
}

describe("published preview worker pin writer", () => {
  test("writes a pin the backend accepts, then reports an identical pin unchanged", () => {
    const file = pinCopy();
    const before = JSON.parse(readFileSync(checkedIn, "utf8")) as { $comment: string };
    expect(writePin(IMAGE, "ctx-b", MANIFEST, CONTEXT, file)).toEqual({
      code: 0,
      stdout: "changed",
    });
    const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect(written).toMatchObject({
      $comment: before.$comment,
      image: IMAGE,
      tag: "ctx-b",
      digest: MANIFEST,
      contextDigest: CONTEXT,
    });
    expect(written.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(readPublishedWorkerImage(file)).toEqual({
      reference: `${IMAGE}@${MANIFEST}`,
      repository: IMAGE,
      digest: MANIFEST,
      contextDigest: CONTEXT,
    });
    const bytes = readFileSync(file, "utf8");
    expect(writePin(IMAGE, "ctx-b", MANIFEST, CONTEXT, file)).toEqual({
      code: 0,
      stdout: "unchanged",
    });
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  test("refuses anything the backend would reject, leaving the pin untouched", () => {
    const file = pinCopy();
    const bytes = readFileSync(file, "utf8");
    for (const args of [
      [`${IMAGE}:latest`, "ctx-b", MANIFEST, CONTEXT],
      [IMAGE, "bad tag", MANIFEST, CONTEXT],
      [IMAGE, "ctx-b", "sha256:short", CONTEXT],
      [IMAGE, "ctx-b", MANIFEST, "latest"],
      [IMAGE, "ctx-b", MANIFEST, ""],
    ])
      expect(writePin(...args, file).code).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });
});
