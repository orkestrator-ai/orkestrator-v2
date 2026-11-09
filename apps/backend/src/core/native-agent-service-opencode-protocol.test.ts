import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderCreateSessionOptions } from "./agent-provider-contract.js";
import { NativeAgentService } from "./native-agent-service.js";
import { OPENCODE2_CAPABILITY_LIMITS } from "./opencode2/routing-provider.js";
import {
  addEnvironment,
  createProviderStub,
  createStorage,
  refusingInvoke,
} from "./native-agent-service-projection-test-support.js";

const identity = {
  environmentId: "env-1",
  agent: "opencode" as const,
  logicalSessionKey: "env-env-1:tab-opencode-protocol",
};

async function withService(
  options: {
    setting?: "legacy" | "v2";
    environmentType?: "local" | "containerized";
    host?: boolean;
    origin?: "interactive-native" | "build-pipeline";
    /** What `openCode2InContainer` answers; absent leaves the option out. */
    inContainer?: boolean;
  },
  run: (input: {
    service: NativeAgentService;
    created: ProviderCreateSessionOptions[];
    storage: Awaited<ReturnType<typeof createStorage>>;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "ork-opencode-protocol-"));
  const storage = await createStorage(root);
  await addEnvironment(storage, {
    environmentType: options.environmentType ?? "local",
    ...(options.environmentType === "containerized" ? { containerId: "c-1" } : {}),
  });
  if (options.setting) {
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({ ...config.global, openCodeProtocol: options.setting });
  }
  const created: ProviderCreateSessionOptions[] = [];
  const { provider } = createProviderStub("opencode", {
    createSession: async (_phase, _label, createOptions = {}) => {
      created.push(createOptions);
      return `ses_${created.length}`;
    },
  });
  const service = new NativeAgentService(storage, refusingInvoke, {
    provider: async () => provider,
    ...(options.host === false ? {} : { openCode2HostServer: async () => undefined }),
    ...(options.inContainer === undefined
      ? {}
      : { openCode2InContainer: async () => options.inContainer === true }),
  });
  try {
    await run({ service, created, storage });
  } finally {
    await service.shutdown();
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe("OpenCode line of a new native session", () => {
  test("the setting puts a new interactive local tab on 2.x, on the record and the create", async () => {
    await withService({ setting: "v2" }, async ({ service, created, storage }) => {
      const session = await service.ensureSession(identity);
      expect(session.openCodeProtocol).toBe("v2");
      expect(created[0]?.openCodeProtocol).toBe("v2");
      expect((await storage.getNativeAgentSession(session.key))?.openCodeProtocol).toBe("v2");
      // An existing session keeps its line whatever the setting says now.
      const config = await storage.loadConfig();
      await storage.updateGlobalConfig({ ...config.global, openCodeProtocol: "legacy" });
      expect((await service.ensureSession(identity)).openCodeProtocol).toBe("v2");
      expect(created).toHaveLength(1);
    });
  });

  test("legacy, workflows, containers and hosts without a 2.x server stay on 1.x", async () => {
    const cases = [
      { setting: "legacy" as const },
      {},
      { setting: "v2" as const, origin: "build-pipeline" as const },
      { setting: "v2" as const, environmentType: "containerized" as const },
      { setting: "v2" as const, environmentType: "containerized" as const, inContainer: false },
      { setting: "legacy" as const, environmentType: "containerized" as const, inContainer: true },
      { setting: "v2" as const, host: false },
    ];
    for (const options of cases) {
      await withService(options, async ({ service, created }) => {
        const session = await service.ensureSession({
          ...identity,
          ...(options.origin ? { origin: options.origin } : {}),
        });
        expect(session.openCodeProtocol).toBeUndefined();
        expect(created[0]?.openCodeProtocol).toBeUndefined();
      });
    }
  });
});

describe("OpenCode line of a new container session", () => {
  test("a container whose image runs 2.x takes it, like a local tab", async () => {
    await withService(
      { setting: "v2", environmentType: "containerized", inContainer: true },
      async ({ service, created }) => {
        const session = await service.ensureSession(identity);
        expect(session.openCodeProtocol).toBe("v2");
        expect(created[0]?.openCodeProtocol).toBe("v2");
      },
    );
  });
});

describe("projection of an OpenCode 2.x session", () => {
  for (const supported of [true, false]) {
    test(`narrows the platform's capabilities by the session's limits (steer ${supported ? "supported" : "refused"})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "ork-opencode2-projection-"));
      const storage = await createStorage(root);
      await addEnvironment(storage);
      const { provider } = createProviderStub("opencode", {
        createSession: async () => "ses_v2",
        steerSupported: async () => supported,
        interactiveSnapshot: async () => ({
          status: "idle",
          messages: [],
          capabilityLimits: OPENCODE2_CAPABILITY_LIMITS,
        }),
      });
      const service = new NativeAgentService(storage, refusingInvoke, {
        provider: async () => provider,
      });
      try {
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.capabilities.actions).toMatchObject({
          compact: false,
          undo: false,
          redo: false,
          steer: supported,
        });
        expect(projection?.capabilities.attachments).toEqual({ files: false, images: false });
        expect(projection?.capabilities.slashCommands).toBe(false);
        expect(projection?.capabilities.fork).toBe(false);
      } finally {
        await service.shutdown();
        storage.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
