import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandContext, CommandHandler, InvocationOrigin } from "./commands-context.js";
import {
  parseClientInfo,
  registerUpdateCommands,
  requesterFrom,
} from "./commands-registry-updates.js";
import { UpdateFiles } from "./updates/update-files.js";
import { UpdateService } from "./updates/update-service.js";
import { createFakeFeed, createFakeTimers, manifestFor } from "./updates/update-test-support.js";

const CONTROL: InvocationOrigin = {
  listener: "control",
  remoteAddress: "127.0.0.1",
  tailscaleUser: null,
};
const REMOTE: InvocationOrigin = {
  listener: "browser",
  remoteAddress: "127.0.0.1",
  tailscaleUser: "alice@example.com",
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function setup() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "update-commands-"));
  directories.push(dataDir);
  const feed = createFakeFeed();
  await feed.publish(manifestFor("2.22.0"));
  const service = new UpdateService({
    dataDir,
    currentVersion: "2.21.0",
    platform: "linux",
    arch: "x64",
    feed,
    emit: () => undefined,
    readOwnRequirements: () => manifestFor("2.21.0"),
    readChannel: async () => "stable",
    writeChannel: async () => undefined,
    storageSchemaVersion: () => 3,
    automaticChecks: false,
    files: new UpdateFiles(dataDir),
    timers: createFakeTimers().timers,
    log: { info: () => undefined, warn: () => undefined },
  });
  await service.start();
  const commands = new Map<string, CommandHandler>();
  registerUpdateCommands((name, handler) => commands.set(name, handler));
  const context = { updates: service } as unknown as CommandContext;
  const invoke = async (
    command: string,
    args: Record<string, unknown> = {},
    origin?: InvocationOrigin,
  ) => commands.get(command)!(args, context, origin);
  return { service, invoke, commands };
}

const REGISTRATION = {
  hostKind: "supervisor",
  protocolVersion: 1,
  hostVersion: "2.21.0",
  installKind: "npm-package",
  capabilities: { install: true, rollback: true, restart: ["now"] },
};

describe("update commands", () => {
  test("registers the client and host commands", async () => {
    const { commands } = await setup();
    expect([...commands.keys()].sort()).toEqual([
      "update_acknowledge_notice",
      "update_cancel",
      "update_check",
      "update_get_audit",
      "update_get_status",
      "update_host_outcome",
      "update_host_pending",
      "update_host_register",
      "update_host_report",
      "update_install_now",
      "update_install_on_quit",
      "update_set_channel",
      "update_start",
    ]);
  });

  test("installer commands are refused from remote clients and accepted locally", async () => {
    const { invoke } = await setup();
    await expect(
      invoke("update_host_register", { registration: REGISTRATION }, REMOTE),
    ).rejects.toThrow("UpdateError:forbidden");
    for (const command of ["update_host_pending", "update_host_report", "update_host_outcome"]) {
      await expect(invoke(command, {}, REMOTE)).rejects.toThrow("UpdateError:forbidden");
    }
    const reply = (await invoke(
      "update_host_register",
      { registration: REGISTRATION },
      CONTROL,
    )) as {
      hostSessionId: string;
    };
    expect(reply.hostSessionId).toBeString();
    await expect(
      invoke("update_host_pending", { hostSessionId: reply.hostSessionId }, CONTROL),
    ).resolves.toEqual([]);
    // In-process callers have no origin and are trusted.
    await expect(
      invoke("update_host_register", { registration: REGISTRATION }),
    ).resolves.toBeDefined();
  });

  test("a remote client can drive the update and is audited with its trusted origin", async () => {
    const { invoke, service } = await setup();
    await invoke("update_host_register", { registration: REGISTRATION }, CONTROL);
    const status = (await invoke("update_check", {}, REMOTE)) as {
      available: { version: string; requirementsSha256: string };
    };
    await invoke(
      "update_start",
      {
        targetVersion: status.available.version,
        requirementsSha256: status.available.requirementsSha256,
        approvedConsentIds: [],
        restartPolicy: "immediate",
        client: { kind: "desktop", version: "2.21.0", name: "alice-mbp" },
      },
      REMOTE,
    );
    expect(service.auditLog(1)[0]).toMatchObject({
      action: "start",
      requester: {
        listener: "browser",
        tailscaleUser: "alice@example.com",
        identitySource: "tailscale-serve",
        client: { kind: "desktop", name: "alice-mbp" },
      },
    });
  });

  test.each([
    [{ restartPolicy: "later" }, "restartPolicy"],
    [{ requirementsSha256: "nope" }, "SHA-256"],
    [{ approvedConsentIds: "all" }, "approvedConsentIds"],
    [
      { approvedConsentIds: Array.from({ length: 300 }, (_, index) => `id-${index}`) },
      "at most 256",
    ],
    [{ allowDowngrade: "yes" }, "allowDowngrade"],
    [{ client: { kind: "robot" } }, "client.kind"],
    [{ extra: 1 }, "Unexpected"],
  ])("update_start refuses %j", async (override, message) => {
    const { invoke } = await setup();
    const args = {
      targetVersion: "2.22.0",
      requirementsSha256: "a".repeat(64),
      approvedConsentIds: [],
      restartPolicy: "immediate",
      ...override,
    };
    await expect(invoke("update_start", args, REMOTE)).rejects.toThrow(message);
  });

  test("validates audit limits and host registrations", async () => {
    const { invoke } = await setup();
    await expect(invoke("update_get_audit", { limit: 0 })).rejects.toThrow("limit");
    await expect(invoke("update_get_audit", {})).resolves.toEqual([]);
    await expect(
      invoke(
        "update_host_register",
        { registration: { ...REGISTRATION, hostKind: "remote" } },
        CONTROL,
      ),
    ).rejects.toThrow("hostKind");
    await expect(
      invoke(
        "update_host_register",
        {
          registration: {
            ...REGISTRATION,
            capabilities: { install: true, rollback: true, restart: ["later"] },
          },
        },
        CONTROL,
      ),
    ).rejects.toThrow("capabilities");
  });
});

describe("requesters", () => {
  test("derive identity from the trusted origin, never the body", () => {
    expect(requesterFrom(undefined, null)).toMatchObject({
      listener: "internal",
      identitySource: "local",
    });
    expect(requesterFrom(CONTROL, null)).toMatchObject({
      listener: "control",
      identitySource: "local",
    });
    expect(requesterFrom({ ...REMOTE, tailscaleUser: null }, null)).toMatchObject({
      identitySource: "client-declared",
      tailscaleUser: null,
    });
    expect(requesterFrom(REMOTE, null)).toMatchObject({ identitySource: "tailscale-serve" });
  });

  test("client info is bounded and typed", () => {
    expect(parseClientInfo(undefined)).toBeNull();
    expect(parseClientInfo({ kind: "web", version: "2.21.0" })).toEqual({
      kind: "web",
      version: "2.21.0",
      name: null,
    });
    expect(() => parseClientInfo({ kind: "web", name: "x".repeat(121) })).toThrow("client.name");
  });
});
