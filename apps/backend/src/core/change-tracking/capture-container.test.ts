import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  symlinkSync,
  statSync,
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWorktree,
  DEFAULT_CAPTURE_LIMITS,
  ContainerCaptureExecutor,
  displayPath,
  HostCaptureExecutor,
} from "./capture.js";
import { ObjectStore } from "./object-store.js";
import { compareManifests } from "./snapshot-diff.js";
import { hostConditionalWrite, containerConditionalWrite } from "./restore.js";
import { objectId } from "./object-store.js";

/**
 * The container executor drives `docker exec <id> node -e <helper> -- …`.
 * A PATH shim stands in for docker: it drops `exec`, `-i` and the container
 * id and runs the same helper with the local node, against a real repository.
 * That exercises the helper script, its framing and the batching end to end;
 * a real container is covered by the Docker agent suite.
 */

const directories: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temp(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function installDockerShim(): void {
  const bin = temp("ork-docker-shim-");
  const shim = join(bin, "docker");
  writeFileSync(
    shim,
    `#!/bin/sh\n# exec [-i] <container> <command...>\nshift\nif [ "$1" = "-i" ]; then shift; fi\nshift\nexec "$@"\n`,
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
}

function repo(): string {
  const root = temp("ork-container-repo-");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
      },
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return root;
}

describe("container capture executor", () => {
  test("V14: the container path captures the same manifest as the host path", async () => {
    installDockerShim();
    const root = repo();
    writeFileSync(join(root, "untracked.txt"), "u\n");
    writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2]));
    const store = new ObjectStore({ root: temp("ork-store-"), durable: false });
    const viaContainer = await captureWorktree({
      executor: new ContainerCaptureExecutor("fake", root),
      store,
    });
    const viaHost = await captureWorktree({ executor: new HostCaptureExecutor(root), store });
    if (viaContainer.kind !== "captured" || viaHost.kind !== "captured")
      throw new Error("capture failed");
    expect(viaContainer.manifest.entries.map((e) => [displayPath(e.p), e.o, e.m])).toEqual(
      viaHost.manifest.entries.map((e) => [displayPath(e.p), e.o, e.m]),
    );
    // Bytes crossed only for blobs the store lacked.
    expect(viaHost.coverage.newObjects).toBe(1); // only the host manifest differs (root label)
    const comparison = await compareManifests(store, viaHost.manifest, viaContainer.manifest);
    expect(comparison.changedFiles).toBe(0);
  });

  test("the container restore helper checks and writes at the executor", async () => {
    installDockerShim();
    const root = repo();
    const current = new TextEncoder().encode("one\n");
    const replacement = new TextEncoder().encode("restored\n");
    const action = {
      pathId: "u:a.txt",
      expectedOid: objectId("blob", current),
      targetBlob: "x",
      mode: "100644",
    };
    expect(await containerConditionalWrite("fake", root, action, replacement)).toBe("applied");
    // The destination moved on: the precondition now fails and nothing is written.
    expect(await containerConditionalWrite("fake", root, action, current)).toBe(
      "precondition-failed",
    );
    expect(
      await containerConditionalWrite("fake", root, { ...action, pathId: "u:../escape" }, current),
    ).toBe("failed");
  });
});

test("container reads reject encoded traversal and symlink ancestors in live reads and capture", async () => {
  installDockerShim();
  const root = repo();
  const outside = temp("ork-outside-");
  writeFileSync(join(outside, "secret"), "outside sentinel");
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested", "secret"), "inside");
  execFileSync("git", ["add", "nested/secret"], { cwd: root });
  rmSync(join(root, "nested"), { recursive: true });
  symlinkSync(outside, join(root, "nested"));
  const executor = new ContainerCaptureExecutor("fake", root);
  for (const id of [
    "u:../secret",
    `b:${Buffer.from("../secret").toString("base64")}`,
    "u:.git/config",
    "u:nested/secret",
  ]) {
    expect(
      (await executor.fetch([id], DEFAULT_CAPTURE_LIMITS, new AbortController().signal))[0]?.kind,
    ).toBe("omitted");
  }
  const result = await captureWorktree({
    executor,
    store: new ObjectStore({ root: temp("ork-store-"), durable: false }),
  });
  expect(result.kind).toBe("captured");
  if (result.kind === "captured")
    expect(result.manifest.entries.some((e) => e.p === "u:nested/secret")).toBe(false);
});

for (const executor of ["host", "container"] as const)
  test(`${executor} conditional restore protects modes and catches filesystem errors`, async () => {
    installDockerShim();
    const root = repo();
    const write = (action: Parameters<typeof hostConditionalWrite>[1], bytes: Uint8Array) =>
      executor === "host"
        ? hostConditionalWrite(root, action, bytes)
        : containerConditionalWrite("fake", root, action, bytes);
    const bytes = new TextEncoder().encode("one\n");
    const action = {
      pathId: "u:a.txt",
      expectedOid: objectId("blob", bytes),
      expectedMode: "100644",
      targetBlob: "x",
      mode: "100644",
    };
    chmodSync(join(root, "a.txt"), 0o755);
    expect(await write(action, new TextEncoder().encode("restored\n"))).toBe("precondition-failed");
    expect((statSync(join(root, "a.txt")).mode & 0o111) !== 0).toBe(true);
    expect(
      await write(
        { ...action, pathId: "u:a.txt/child", expectedOid: null, expectedMode: null },
        bytes,
      ),
    ).toBe("failed");
  });
