import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loseBunExitEvents } from "@orkestrator/protocol/testing/lost-exit";
import { copyOutBounded } from "./docker-copy-out.js";

let root: string;
let previousPath: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-copy-out-"));
  previousPath = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
});

afterEach(async () => {
  process.env.PATH = previousPath;
  await rm(root, { recursive: true, force: true });
});

async function fakeDocker(body: string): Promise<void> {
  const file = path.join(root, "docker");
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
}

describe.skipIf(process.platform === "win32")("copyOutBounded", () => {
  test("returns the exact bytes", async () => {
    await fakeDocker(`printf '\\377\\000tar'`);
    expect(await copyOutBounded("c1", "/f", 16)).toEqual({
      kind: "bytes",
      tar: Buffer.from([0xff, 0x00, 0x74, 0x61, 0x72]),
    });
  });

  test("a stream exactly at the limit is whole; one byte more is oversized", async () => {
    await fakeDocker(`head -c ${1 + 4096} /dev/zero`);
    const fits = await copyOutBounded("c1", "/f", 1);
    expect(fits.kind === "bytes" && fits.tar.length).toBe(1 + 4096);
    expect(await copyOutBounded("c1", "/f", 0)).toEqual({ kind: "oversized" });
  });

  test("a writer still running past the limit is stopped", async () => {
    await fakeDocker("head -c 8192 /dev/zero; exec sleep 30");
    const started = Date.now();
    expect(await copyOutBounded("c1", "/f", 16)).toEqual({ kind: "oversized" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("names a missing path and an unreachable daemon, and nothing else", async () => {
    await fakeDocker(
      `echo 'Error response from daemon: Could not find the file /f in container c1' >&2; exit 1`,
    );
    expect(await copyOutBounded("c1", "/f", 16)).toEqual({ kind: "absent" });
    await fakeDocker(`echo 'Cannot connect to the Docker daemon at unix:///x.' >&2; exit 1`);
    expect(await copyOutBounded("c1", "/f", 16)).toEqual({ kind: "daemon-unavailable" });
    await fakeDocker(
      `echo 'Error response from daemon: remount-ro /d/rootfs/overlayfs/1/ro, flags: 0x1021: operation not permitted' >&2; exit 1`,
    );
    expect(await copyOutBounded("c1", "/f", 16)).toEqual({ kind: "refused" });
    await fakeDocker(`echo 'something else' >&2; exit 1`);
    expect(await copyOutBounded("c1", "/f", 16)).toEqual({ kind: "failed" });
  });

  test("a timeout is a failure whatever the command said", async () => {
    await fakeDocker(
      `echo 'Error response from daemon: Could not find the file /f in container c1' >&2; exec sleep 30`,
    );
    expect(await copyOutBounded("c1", "/f", 16, 100)).toEqual({ kind: "failed" });
  });

  test("a background child holding the output does not delay the result", async () => {
    await fakeDocker("printf tar; sleep 5 & exit 0");
    const started = Date.now();
    expect(await copyOutBounded("c1", "/f", 16)).toEqual({
      kind: "bytes",
      tar: Buffer.from("tar"),
    });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("a lost completion event is a failure, never bytes that may be incomplete", async () => {
    await fakeDocker("printf tar");
    const restore = loseBunExitEvents();
    try {
      expect(await copyOutBounded("c1", "/f", 16, 200)).toEqual({ kind: "failed" });
    } finally {
      restore();
    }
  });
});
