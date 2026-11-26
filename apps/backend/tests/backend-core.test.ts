import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "../src/core/index";
import { BackendRuntime } from "../src/core/backend-runtime";
import {
  fromWire,
  incompatibilityIpcMessage,
  UnknownCommandError,
  incompatibility,
} from "@orkestrator/protocol/contract/errors";
import { requestUrl, startGateway } from "./gateway-test-harness.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("OrkestratorBackend", () => {
  test("initializes persistent storage and passes the managed toolchain directory to commands", async () => {
    const root = await createTempDir("ork-backend-core-");
    const dataDir = path.join(root, "data");
    const toolchainBinDir = path.join(root, "toolchains", "bin");
    await mkdir(toolchainBinDir, { recursive: true });
    await writeFile(path.join(toolchainBinDir, "claude"), "managed claude");

    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir,
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
    });

    await backend.init();

    try {
      await expect(backend.invoke("check_claude_cli")).resolves.toBe(true);
      await expect(backend.invoke<{ version: string }>("get_config")).resolves.toMatchObject({
        version: "1.0.0",
      });
      await expect(backend.invoke("unknown-command")).rejects.toThrow(
        "Unknown backend command: unknown-command",
      );
      // Coded (plan item 1005), naming the envelope's domain when it has one.
      const unknown = await backend
        .invoke("get_missing_probe", {}, { domain: "system", version: 1 })
        .catch((error: unknown) => error);
      expect(unknown).toBeInstanceOf(UnknownCommandError);
      expect(incompatibility(unknown, "get_missing_probe")).toEqual({
        code: "unknown-command",
        domain: "system",
        command: "get_missing_probe",
      });
    } finally {
      // Startup work (the design canvas sweep among it) still writes into the
      // data directory; shutting down settles it before the directory goes.
      await backend.shutdown();
    }
  });

  test("shuts down idempotently and rejects later command invocations", async () => {
    const root = await createTempDir("ork-backend-core-shutdown-");
    const runtime = new BackendRuntime({ emit: () => undefined });
    const backend = new OrkestratorBackend({
      dataDir: path.join(root, "data"),
      toolchainBinDir: path.join(root, "toolchains", "bin"),
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
      runtime,
    });
    await backend.init();
    runtime.diffStats.service.track({
      environmentId: "active-during-shutdown",
      kind: "local",
      worktreePath: root,
      comparisonRef: "main",
    });
    expect(runtime.diffStats.service.trackedIds()).toContain("active-during-shutdown");

    await expect(Promise.all([backend.shutdown(), backend.shutdown()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(runtime.diffStats.service.trackedIds()).toEqual([]);
    await expect(backend.invoke("greet", { name: "late" })).rejects.toThrow(
      "Backend is shutting down",
    );
  });

  test("refuses published renderer capability probes before hello without triggering legacy fallback", async () => {
    const root = await createTempDir("ork-backend-core-retired-probes-");
    const backend = new OrkestratorBackend({
      dataDir: path.join(root, "data"),
      toolchainBinDir: path.join(root, "toolchains", "bin"),
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
    });
    await backend.init();
    try {
      const { info } = await startGateway({ backend });
      const domains = (await backend.backendHelloIdentity()).domains;
      for (const [command, domain] of [
        ["get_native_agent_sync_capabilities", "native-sessions"],
        ["get_client_state_capabilities", "config"],
      ] as const) {
        expect(backend.hasCommand(command)).toBe(false);
        // v2.39.14-beta adapter 0 sends a bare invoke while hello is pending.
        // Both of its capability caches only fall back on unknown-command.
        const response = await requestUrl(`${info.url}__orkestrator/invoke`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${info.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ command, args: {} }),
        });
        expect(response.status).toBe(500);
        const error = fromWire(response.json());
        const expected = {
          code: "unsupported-version",
          command,
          domain,
          range: domains[domain],
        } as const;
        expect(incompatibility(error, command)).toEqual(expected);
        expect(error?.message).toContain("Reload this browser tab or update the desktop app");

        // Routed desktop calls carry the same refusal through IPC's message form.
        const ipcMessage = incompatibilityIpcMessage(error);
        expect(incompatibility(ipcMessage, command)).toEqual(expected);
        expect(ipcMessage).toContain("Reload this browser tab or update the desktop app");
      }
    } finally {
      await backend.shutdown();
    }
  });
});
