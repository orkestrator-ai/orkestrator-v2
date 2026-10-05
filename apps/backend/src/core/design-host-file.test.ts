import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESIGN_MAX_DOCUMENT_BYTES } from "@orkestrator/protocol/design-canvas";
import { readDesignHostFile } from "./design-host-file.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ork-host-import-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("growth after handle stat is rejected with a bounded read and the handle is closed", async () => {
  const path = join(dir, "grow.orkdes");
  await writeFile(path, "original");
  const handle = await open(path, "r");
  const stat = handle.stat.bind(handle);
  handle.stat = (async () => {
    const info = await stat();
    await appendFile(path, Buffer.alloc(DESIGN_MAX_DOCUMENT_BYTES + 1));
    return info;
  }) as typeof handle.stat;
  let requested = 0;
  const read = handle.read.bind(handle);
  handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
    requested += length;
    return read(buffer, offset, length, position);
  }) as typeof handle.read;
  await expect(readDesignHostFile(path, async () => handle)).rejects.toThrow("changed during read");
  expect(requested).toBe(9);
  await expect(handle.stat()).rejects.toThrow();
});

test("pathname replacement after stat keeps reading the originally opened file", async () => {
  const path = join(dir, "replace.orkdes");
  await writeFile(path, "original");
  const handle = await open(path, "r");
  const stat = handle.stat.bind(handle);
  handle.stat = (async () => {
    const info = await stat();
    await rename(path, join(dir, "original.orkdes"));
    await writeFile(path, Buffer.alloc(DESIGN_MAX_DOCUMENT_BYTES + 1));
    return info;
  }) as typeof handle.stat;
  expect(await readDesignHostFile(path, async () => handle)).toBe("original");
});

test("short reads are continued until EOF without truncating the document", async () => {
  const path = join(dir, "short.orkdes");
  await writeFile(path, "original");
  const handle = await open(path, "r");
  const read = handle.read.bind(handle);
  handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) =>
    read(buffer, offset, Math.min(length, 2), position)) as typeof handle.read;
  expect(await readDesignHostFile(path, async () => handle)).toBe("original");
});
