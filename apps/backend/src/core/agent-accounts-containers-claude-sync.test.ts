import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  syncContainerClaudeLogin,
  type ClaudeLoginHandover,
  type ClaudeLoginPassSnapshot,
  type ContainerRunners,
} from "./agent-accounts-containers.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import type { Environment } from "./models.js";
import { createEnvironment, StorageService } from "./storage.js";

/**
 * The login keeper's per-container sync compares the login it would hand over
 * with what it last pushed before it reads the container's account marker,
 * and takes the pass's configuration and environments from the keeper.
 */
const MARKER = "/tmp/orkestrator-claude-account";
const LIVE = Date.now() + 8 * 60 * 60_000;

function hostLogin(accessToken: string): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: "HOST-SINGLE-USE", expiresAt: LIVE },
  });
}

function fakeRunners() {
  const markers = new Map<string, string>();
  const calls: Array<{ kind: "exec" | "pipe"; command: string }> = [];
  const runners: ContainerRunners = {
    exec: async (_id, command) => {
      calls.push({ kind: "exec", command });
      const read = command.match(/^cat (\S+) /);
      return read ? (markers.get(read[1]!) ?? "") : "";
    },
    pipe: async (_id, command) => {
      calls.push({ kind: "pipe", command });
    },
    label: async () => null,
  };
  return { runners, markers, calls };
}

let root: string;
let environment: Environment;
let reads: { config: number; environments: number; environment: number };
let optedOut: boolean;
let context: CommandContext;
let runtime: BackendRuntime;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "ork-claude-sync-"));
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  environment = { ...createEnvironment("project-1"), containerId: "container-1" };
  reads = { config: 0, environments: 0, environment: 0 };
  optedOut = false;
  runtime = new BackendRuntime({ emit: () => undefined });
  context = {
    storage: Object.assign(Object.create(storage), {
      loadConfig: async () => {
        reads.config += 1;
        return {
          global: {
            enabledAgentPlatforms: ["claude"],
            ...(optedOut ? { useHostClaudeCredentials: false } : {}),
          },
        };
      },
      loadEnvironments: async () => {
        reads.environments += 1;
        return [structuredClone(environment)];
      },
      getEnvironment: async () => {
        reads.environment += 1;
        return structuredClone(environment);
      },
    }),
    runtimeFlavor: "agent-test",
    credentialSources: new Set(["claude"]),
    runtime,
  } as unknown as CommandContext;
});

afterEach(async () => {
  runtime.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

const handover = (accessToken: string): ClaudeLoginHandover => ({
  account: { accountId: "default" },
  credentials: hostLogin(accessToken),
});
const markerReads = (calls: Array<{ command: string }>) =>
  calls.filter((call) => call.command.startsWith(`cat ${MARKER}`)).length;
const snapshot = (): ClaudeLoginPassSnapshot => ({
  global: { enabledAgentPlatforms: ["claude"] } as ClaudeLoginPassSnapshot["global"],
  environments: [structuredClone(environment)],
});

describe("keeper Claude login sync", () => {
  test("a container already holding the login is left alone without reading its marker", async () => {
    const fake = fakeRunners();
    const sync = (read: ClaudeLoginHandover) =>
      syncContainerClaudeLogin(context, "container-1", { runners: fake.runners, handover: read });

    expect(await sync(handover("first"))).toBe(true);
    expect(markerReads(fake.calls)).toBe(1);

    fake.calls.length = 0;
    expect(await sync(handover("first"))).toBe(false);
    expect(fake.calls).toEqual([]);

    // A renewed login is delivered exactly as before: marker, then pipe.
    expect(await sync(handover("renewed"))).toBe(true);
    expect(markerReads(fake.calls)).toBe(1);
    expect(fake.calls.filter((call) => call.kind === "pipe")).toHaveLength(1);
  });

  test("a container on another account is still checked by its marker every pass", async () => {
    const fake = fakeRunners();
    fake.markers.set(MARKER, "another-account");
    for (let pass = 0; pass < 3; pass += 1) {
      expect(
        await syncContainerClaudeLogin(context, "container-1", {
          runners: fake.runners,
          handover: handover("first"),
        }),
      ).toBe(false);
    }
    expect(markerReads(fake.calls)).toBe(3);
    expect(fake.calls.some((call) => call.kind === "pipe")).toBe(false);
  });

  test("a pass snapshot replaces the first reads, and a write still re-reads its fences", async () => {
    const fake = fakeRunners();
    const sync = (read: ClaudeLoginHandover) =>
      syncContainerClaudeLogin(context, "container-1", {
        runners: fake.runners,
        handover: read,
        snapshot: snapshot(),
      });

    expect(await sync(handover("first"))).toBe(true);
    // Only the fence after host I/O read storage.
    expect(reads).toEqual({ config: 1, environments: 0, environment: 1 });

    reads = { config: 0, environments: 0, environment: 0 };
    expect(await sync(handover("first"))).toBe(false);
    expect(reads).toEqual({ config: 0, environments: 0, environment: 0 });

    // Opted out after the pass read its snapshot: the fence still refuses.
    optedOut = true;
    fake.calls.length = 0;
    expect(await sync(handover("renewed"))).toBe(false);
    expect(fake.calls.some((call) => call.kind === "pipe")).toBe(false);
  });

  test("without a snapshot each sync reads configuration and environments itself, as before", async () => {
    const fake = fakeRunners();
    expect(
      await syncContainerClaudeLogin(context, "container-1", {
        runners: fake.runners,
        handover: handover("first"),
      }),
    ).toBe(true);
    expect(reads.config).toBe(2);
    expect(reads.environments).toBe(2);
  });
});
