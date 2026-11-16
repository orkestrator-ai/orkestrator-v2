import { describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { probeExecutable } from "./executable-checks.js";
import type { ToolchainArtifact } from "./manifest.js";

const artifact = { name: "codex", version: "1.2.3" } as ToolchainArtifact;

/**
 * A child whose process has exited before its last output is read, which is
 * the order a loaded host can produce: `exit` first, then the data, then
 * `close` once both streams have ended.
 */
function lateOutputSpawn(output: string): typeof spawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.emit("exit", 0, null);
      child.stdout.write(output);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  }) as unknown as typeof spawn;
}

describe("probeExecutable", () => {
  test("reads output that arrives after the process has exited", async () => {
    await expect(
      probeExecutable("/unused", artifact, 60_000, lateOutputSpawn("codex 1.2.3\n")),
    ).resolves.toBeUndefined();
  });

  test("still rejects a version it did not print", async () => {
    await expect(
      probeExecutable("/unused", artifact, 60_000, lateOutputSpawn("codex 9.9.9\n")),
    ).rejects.toThrow("reported an unexpected version: codex 9.9.9");
  });
});
