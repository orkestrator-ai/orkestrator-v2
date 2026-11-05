import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loseBunExitEvents } from "@orkestrator/protocol/testing/lost-exit";
import { runContainerWrite } from "./container-write.js";

let root: string;
let previousPath: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-container-write-"));
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

describe.skipIf(process.platform === "win32")("runContainerWrite", () => {
  test("delivers the payload to the command it names", async () => {
    const log = path.join(root, "log");
    await fakeDocker(`printf '%s\\n' "$*" > '${log}'; cat >> '${log}'`);
    await runContainerWrite("c1", ["node", "-e", "script"], "payload");
    expect(await readFile(log, "utf8")).toBe("exec -i c1 node -e script\npayload");
  });

  test("a failing exit names its status", async () => {
    await fakeDocker("cat >/dev/null; exit 7");
    await expect(runContainerWrite("c1", ["true"], "x")).rejects.toThrow(
      "docker exec exited with 7",
    );
  });

  test("an exit status can carry its own error", async () => {
    await fakeDocker("exit 75");
    await expect(
      runContainerWrite("c1", ["true"], "x", {
        errorForExit: (code) => (code === 75 ? new Error("conflict") : undefined),
      }),
    ).rejects.toThrow("conflict");
  });

  // The command refuses a precondition before it reads anything.
  test("a command exiting before it reads a large payload reports its own status", async () => {
    await fakeDocker("exit 7");
    await expect(runContainerWrite("c1", ["true"], "x".repeat(8 * 1024 * 1024))).rejects.toThrow(
      "docker exec exited with 7",
    );
  });

  test("a wedged exec fails at the deadline", async () => {
    await fakeDocker("exec sleep 30");
    await expect(runContainerWrite("c1", ["true"], "x", { timeoutMs: 100 })).rejects.toThrow(
      "timed out",
    );
  });

  test("a lost completion event fails at the deadline, never as a success", async () => {
    await fakeDocker("cat >/dev/null");
    const restore = loseBunExitEvents();
    try {
      await expect(runContainerWrite("c1", ["true"], "x", { timeoutMs: 200 })).rejects.toThrow(
        "timed out",
      );
    } finally {
      restore();
    }
  });
});

test("missing Docker is reported without a null exit status", async () => {
  process.env.PATH = root;
  await expect(runContainerWrite("c1", ["true"], "")).rejects.toThrow(
    "Docker executable not found",
  );
});

test("an excessive output fails with its cause", async () => {
  await fakeDocker("head -c 53000000 /dev/zero");
  await expect(runContainerWrite("c1", ["true"], "")).rejects.toThrow("output limit exceeded");
});
