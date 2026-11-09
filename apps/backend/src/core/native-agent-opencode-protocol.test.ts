import { describe, expect, test } from "bun:test";
import {
  newOpenCodeSessionProtocol,
  newOpenCodeWorkflowSessionProtocol,
  openCodeRoutingDependencies,
  openCodeWorkflowRoutingDependencies,
  persistedOpenCodeProtocol,
  selectNewOpenCodeSessionProtocol,
  sessionTakesAgentTools,
} from "./native-agent-opencode-protocol.js";
import type { PersistedNativeAgentSession } from "./models.js";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";

const local = { environmentType: "local" as const };

describe("newOpenCodeSessionProtocol", () => {
  test("an interactive OpenCode tab in a local environment takes 2.x when the setting asks", () => {
    expect(newOpenCodeSessionProtocol({ agent: "opencode" }, local, "v2", true)).toBe("v2");
    expect(
      newOpenCodeSessionProtocol(
        {
          agent: "opencode",
          origin: "interactive-native",
          owner: { kind: "environment", projectId: "p", environmentId: "e" },
        },
        local,
        "v2",
        true,
      ),
    ).toBe("v2");
  });

  test("everything else stays on 1.x", () => {
    expect(newOpenCodeSessionProtocol({ agent: "opencode" }, local, "legacy", true)).toBe(
      undefined,
    );
    expect(newOpenCodeSessionProtocol({ agent: "opencode" }, local, undefined, true)).toBe(
      undefined,
    );
    expect(newOpenCodeSessionProtocol({ agent: "opencode" }, local, "nonsense", true)).toBe(
      undefined,
    );
    expect(newOpenCodeSessionProtocol({ agent: "opencode" }, local, "v2", false)).toBe(undefined);
    expect(newOpenCodeSessionProtocol({ agent: "claude" }, local, "v2", true)).toBe(undefined);
    for (const origin of ["build-pipeline", "automated-review", "coordinator"] as const) {
      expect(newOpenCodeSessionProtocol({ agent: "opencode", origin }, local, "v2", true)).toBe(
        undefined,
      );
    }
    expect(
      newOpenCodeSessionProtocol(
        { agent: "opencode", owner: { kind: "coordinator", projectId: "p", coordinatorId: "c" } },
        local,
        "v2",
        true,
      ),
    ).toBe(undefined);
    expect(
      newOpenCodeSessionProtocol(
        { agent: "opencode", executionPolicy: "coordinator-read-only" },
        local,
        "v2",
        true,
      ),
    ).toBe(undefined);
    expect(
      newOpenCodeSessionProtocol(
        { agent: "opencode" },
        { environmentType: "containerized" as never },
        "v2",
        true,
      ),
    ).toBe(undefined);
    expect(newOpenCodeSessionProtocol({ agent: "opencode" }, null, "v2", true)).toBe(undefined);
  });

  test("a container environment takes 2.x only when its image runs it", () => {
    const container = { environmentType: "containerized" as const };
    expect(newOpenCodeSessionProtocol({ agent: "opencode" }, container, "v2", true, true)).toBe(
      "v2",
    );
    expect(newOpenCodeSessionProtocol({ agent: "opencode" }, container, "v2", true, false)).toBe(
      undefined,
    );
    expect(
      newOpenCodeSessionProtocol(
        { agent: "opencode", origin: "build-pipeline" },
        container,
        "v2",
        true,
        true,
      ),
    ).toBe(undefined);
  });
});

describe("selectNewOpenCodeSessionProtocol", () => {
  const storage = (environmentType: "local" | "containerized", setting = "v2") => ({
    getEnvironment: async () => ({ environmentType, containerId: "c-1" }),
    loadConfig: async () => ({ global: { openCodeProtocol: setting } }),
  });
  const input = { agent: "opencode", environmentId: "env" };

  test("asks about the container's image only when everything else says 2.x", async () => {
    const asked: string[] = [];
    const openCode2InContainer = async (environment: { containerId?: string | null }) => {
      asked.push(environment.containerId ?? "");
      return true;
    };
    const host = async () => undefined;
    expect(
      await selectNewOpenCodeSessionProtocol(
        storage("containerized"),
        { openCode2HostServer: host, openCode2InContainer },
        input,
      ),
    ).toBe("v2");
    expect(asked).toEqual(["c-1"]);
    expect(
      await selectNewOpenCodeSessionProtocol(
        storage("containerized", "legacy"),
        { openCode2HostServer: host, openCode2InContainer },
        input,
      ),
    ).toBe(undefined);
    expect(
      await selectNewOpenCodeSessionProtocol(
        storage("local"),
        { openCode2HostServer: host, openCode2InContainer },
        input,
      ),
    ).toBe("v2");
    expect(asked).toEqual(["c-1"]);
    // Without the check a container stays on 1.x.
    expect(
      await selectNewOpenCodeSessionProtocol(
        storage("containerized"),
        { openCode2HostServer: host },
        input,
      ),
    ).toBe(undefined);
  });

  test("a trusted coordinator session takes 2.x under the switch, without an environment record", async () => {
    const runtime = coordinatorRuntimeId("c1", "conv-1");
    const coordinator = {
      agent: "opencode",
      environmentId: runtime,
      origin: "coordinator" as const,
      owner: { kind: "coordinator" as const, projectId: "p", coordinatorId: "c1" },
      executionPolicy: "coordinator-read-only",
    };
    const host = async () => undefined;
    const noEnvironment = (setting: string) => ({
      getEnvironment: async () => null,
      loadConfig: async () => ({ global: { openCodeProtocol: setting } }),
    });
    expect(
      await selectNewOpenCodeSessionProtocol(
        noEnvironment("v2"),
        { openCode2HostServer: host },
        coordinator,
      ),
    ).toBe("v2");
    expect(
      await selectNewOpenCodeSessionProtocol(
        noEnvironment("legacy"),
        { openCode2HostServer: host },
        coordinator,
      ),
    ).toBe(undefined);
    // No 2.x host, or not the trusted shape: 1.x.
    expect(await selectNewOpenCodeSessionProtocol(noEnvironment("v2"), {}, coordinator)).toBe(
      undefined,
    );
    expect(
      await selectNewOpenCodeSessionProtocol(
        noEnvironment("v2"),
        { openCode2HostServer: host },
        { ...coordinator, origin: "interactive-native" },
      ),
    ).toBe(undefined);
  });
});

function session(overrides: Partial<PersistedNativeAgentSession>): PersistedNativeAgentSession {
  return {
    version: 1,
    key: "k",
    environmentId: "env",
    agent: "opencode",
    logicalSessionKey: "tab",
    providerSessionId: "ses_1",
    origin: "interactive-native",
    interactionPolicy: { mode: "interactive" } as never,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("persistedOpenCodeProtocol", () => {
  test("matches environment, agent and provider session", async () => {
    const storage = {
      readNativeAgentSessionsSnapshot: async () => [
        session({ providerSessionId: "ses_v2", openCodeProtocol: "v2" }),
        session({ providerSessionId: "ses_old" }),
        session({
          environmentId: "other",
          providerSessionId: "ses_elsewhere",
          openCodeProtocol: "v2",
        }),
      ],
    };
    expect(await persistedOpenCodeProtocol(storage, "env", "ses_v2")).toBe("v2");
    expect(await persistedOpenCodeProtocol(storage, "env", "ses_old")).toBe(undefined);
    expect(await persistedOpenCodeProtocol(storage, "env", "ses_elsewhere")).toBe(undefined);
    expect(await persistedOpenCodeProtocol(storage, "env", "ses_none")).toBe(undefined);
  });

  test("routing needs a 2.x host; without one there is nothing to route", () => {
    expect(openCodeRoutingDependencies({}, {}, "env")).toBeUndefined();
    const deps = openCodeRoutingDependencies(
      { openCode2HostServer: async () => undefined },
      {},
      "env",
    );
    expect(deps).toBeDefined();
  });
});

describe("whether new tabs here take 2.x (lists and pickers)", () => {
  const storageWith = (setting: string, environment: unknown) => ({
    loadConfig: async () => ({ global: { openCodeProtocol: setting } }),
    getEnvironment: async () => environment as never,
  });
  const host = { openCode2HostServer: async () => undefined };

  test("the setting and an environment that can serve 2.x", async () => {
    const local = { environmentType: "local" };
    const container = { environmentType: "containerized", containerId: "c-1" };
    const use = (
      setting: string,
      environment: unknown,
      inContainer?: boolean,
    ): Promise<boolean | undefined> =>
      openCodeRoutingDependencies(
        {
          ...host,
          ...(inContainer === undefined ? {} : { openCode2InContainer: async () => inContainer }),
        },
        storageWith(setting, environment),
        "env",
      )!.newSessionsUseV2!();
    expect(await use("v2", local)).toBe(true);
    expect(await use("legacy", local)).toBe(false);
    expect(await use("v2", container, true)).toBe(true);
    expect(await use("v2", container, false)).toBe(false);
    expect(await use("v2", container)).toBe(false);
  });
});

describe("workflow sessions", () => {
  test("follow the same switch, except where 2.x cannot serve them yet", () => {
    const policy = { id: "host-default", approvals: "auto-approve" } as never;
    expect(newOpenCodeWorkflowSessionProtocol({ policy }, local, "v2", true)).toBe("v2");
    // Without a policy the agent's defaults ask; the workflow's cards answer them.
    expect(newOpenCodeWorkflowSessionProtocol({}, local, "v2", true)).toBe("v2");
    expect(newOpenCodeWorkflowSessionProtocol({ policy }, local, "legacy", true)).toBe(undefined);
    // A container takes 2.x only when its image runs it; an older image stays on 1.x.
    const container = { environmentType: "containerized" as const };
    expect(newOpenCodeWorkflowSessionProtocol({ policy }, container, "v2", true)).toBe(undefined);
    expect(newOpenCodeWorkflowSessionProtocol({ policy }, container, "v2", true, false)).toBe(
      undefined,
    );
    expect(newOpenCodeWorkflowSessionProtocol({ policy }, container, "v2", true, true)).toBe("v2");
    expect(newOpenCodeWorkflowSessionProtocol({ policy }, container, "legacy", true, true)).toBe(
      undefined,
    );
    expect(newOpenCodeWorkflowSessionProtocol({ policy }, container, "v2", false, true)).toBe(
      undefined,
    );
    expect(newOpenCodeWorkflowSessionProtocol({ policy }, null, "v2", true, true)).toBe(undefined);
    // A policy that asks is served: its approvals reach the workflow's cards.
    expect(
      newOpenCodeWorkflowSessionProtocol(
        { policy: { id: "x", approvals: "ask" } as never },
        local,
        "v2",
        true,
      ),
    ).toBe("v2");
    expect(
      newOpenCodeWorkflowSessionProtocol(
        { policy: { id: "coordinator-read-only", approvals: "deny" } as never },
        local,
        "v2",
        true,
      ),
    ).toBe(undefined);
    expect(newOpenCodeWorkflowSessionProtocol({ policy }, local, "v2", false)).toBe(undefined);
  });

  test("record their line, which every later lookup reads", async () => {
    const recorded = new Set<string>();
    const storage = {
      getEnvironment: async () => ({ ...local, containerId: null }),
      loadConfig: async () => ({ global: { openCodeProtocol: "v2" } }),
      openCode2Sessions: {
        isOpenCode2Session: (_env: string, id: string) => recorded.has(id),
        hasOpenCode2SessionCapacity: () => true,
        recordOpenCode2Session: (_env: string, id: string) => void recorded.add(id),
      },
    };
    const deps = openCodeWorkflowRoutingDependencies(async () => undefined, storage, "env")!;
    expect(
      await deps.newSessionProtocol!({
        policy: { id: "host-default", approvals: "auto-approve" } as never,
      }),
    ).toBe("v2");
    expect(await deps.persistedProtocol("ses_w")).toBe(undefined);
    await deps.recordSession!("ses_w");
    expect(await deps.persistedProtocol("ses_w")).toBe("v2");
    // An interactive lookup sees a workflow's 2.x session too (a tab may open it).
    expect(await persistedOpenCodeProtocol(storage, "env", "ses_w")).toBe("v2");
    expect(openCodeWorkflowRoutingDependencies(undefined, storage, "env")).toBeUndefined();
  });

  test("in a container, take 2.x only when its image runs it, reading the image last", async () => {
    const recorded = new Set<string>();
    const container = { environmentType: "containerized" as const, containerId: "c-1" };
    let setting = "v2";
    let capacity = true;
    const storage = {
      getEnvironment: async () => container,
      loadConfig: async () => ({ global: { openCodeProtocol: setting } }),
      openCode2Sessions: {
        isOpenCode2Session: (_env: string, id: string) => recorded.has(id),
        hasOpenCode2SessionCapacity: () => capacity,
        recordOpenCode2Session: (_env: string, id: string) => void recorded.add(id),
      },
    };
    const policy = { id: "host-default", approvals: "auto-approve" } as never;
    const imageReads: unknown[] = [];
    const select = (runsV2: boolean | "throws" | undefined) =>
      openCodeWorkflowRoutingDependencies(
        async () => undefined,
        storage,
        "env",
        runsV2 === undefined
          ? {}
          : {
              inContainer: async (environment) => {
                imageReads.push(environment);
                if (runsV2 === "throws") throw new Error("docker is down");
                return runsV2;
              },
            },
      )!.newSessionProtocol!({ policy });
    expect(await select(true)).toBe("v2");
    expect(imageReads).toEqual([container]);
    expect(await select(false)).toBe(undefined);
    // Unreadable or unknown: the older line, never an error.
    expect(await select("throws")).toBe(undefined);
    expect(await select(undefined)).toBe(undefined);
    // A 1.x answer never reads Docker.
    imageReads.length = 0;
    setting = "legacy";
    expect(await select(true)).toBe(undefined);
    setting = "v2";
    capacity = false;
    expect(await select(true)).toBe(undefined);
    expect(
      await openCodeWorkflowRoutingDependencies(async () => undefined, storage, "env", {
        inContainer: async (environment) => {
          imageReads.push(environment);
          return true;
        },
      })!.newSessionProtocol!({
        policy: { id: "coordinator-read-only", approvals: "deny" } as never,
      }),
    ).toBe(undefined);
    expect(imageReads).toEqual([]);
  });

  test("hand a worker mailbox resolver to the 2.x provider only when given one", () => {
    const storage = {
      getEnvironment: async () => ({ ...local, containerId: null }),
      loadConfig: async () => ({ global: { openCodeProtocol: "v2" } }),
      openCode2Sessions: {
        isOpenCode2Session: () => false,
        hasOpenCode2SessionCapacity: () => true,
        recordOpenCode2Session: () => undefined,
      },
    };
    const workerMailbox = async () => undefined;
    expect(
      openCodeWorkflowRoutingDependencies(async () => undefined, storage, "env", { workerMailbox })!
        .workerMailbox,
    ).toBe(workerMailbox);
    expect(
      openCodeWorkflowRoutingDependencies(async () => undefined, storage, "env")!.workerMailbox,
    ).toBeUndefined();
  });

  test("an OpenCode 2.x session takes the per-tab tools credential; a 1.x one does not", () => {
    expect(sessionTakesAgentTools("opencode", "v2")).toBe(true);
    expect(sessionTakesAgentTools("opencode", undefined)).toBe(false);
    expect(sessionTakesAgentTools("claude", undefined)).toBe(true);
  });
});
