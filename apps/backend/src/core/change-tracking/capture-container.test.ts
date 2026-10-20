import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWorktree,
  ContainerCaptureExecutor,
  displayPath,
  HostCaptureExecutor,
} from "./capture.js";
import { ObjectStore } from "./object-store.js";
import { compareManifests } from "./snapshot-diff.js";
import { containerConditionalWrite } from "./restore.js";
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
