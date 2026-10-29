import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContainerHostReachabilityService } from "./container-host-reachability.js";
import { OrkestratorBackend } from "./index.js";

/**
 * The boot host-reachability check creates a Docker probe network. A backend
 * stopped soon after boot must settle it before exiting, and disposable test
 * backends (the CLI tests and scenarios) must be able to skip it, or each run
 * leaves a network under an owner nothing revisits.
 */

const SWITCH = "ORKESTRATOR_HOST_REACHABILITY_CHECK";
const original = process.env[SWITCH];

afterEach(() => {
  if (original === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = original;
});

async function bootAndStop(): Promise<string[]> {
  const calls: string[] = [];
  const service = {
    check: async (trigger: string) => {
      calls.push(`check ${trigger}`);
    },
    dispose: async () => {
      calls.push("dispose");
    },
    containerHostAddress: () => null,
  } as unknown as ContainerHostReachabilityService;
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-reachability-boot-"));
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    containerHostReachability: service,
  });
  try {
    await backend.init();
    calls.push("ready");
    await backend.shutdown();
  } finally {
    await backend.shutdown().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
  return calls;
}

describe("OrkestratorBackend host-reachability boot check", () => {
  test("runs at boot and is settled by shutdown", async () => {
    delete process.env[SWITCH];
    expect(await bootAndStop()).toEqual(["check boot", "ready", "dispose"]);
  });

  test("is skipped when a disposable test backend turns it off, and shutdown still settles", async () => {
    process.env[SWITCH] = "off";
    expect(await bootAndStop()).toEqual(["ready", "dispose"]);
  });
});
