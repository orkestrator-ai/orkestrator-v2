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

describe("workflow sessions", () => {
  test("follow the same switch, except where 2.x cannot serve them yet", () => {
    const policy = { id: "host-default", approvals: "auto-approve" } as never;
    expect(newOpenCodeWorkflowSessionProtocol({ policy }, local, "v2", true)).toBe("v2");
    // Without a policy the agent's defaults ask, and nobody would answer.
    expect(newOpenCodeWorkflowSessionProtocol({}, local, "v2", true)).toBe(undefined);
    expect(newOpenCodeWorkflowSessionProtocol({ policy }, local, "legacy", true)).toBe(undefined);
    expect(
      newOpenCodeWorkflowSessionProtocol({ policy }, { environmentType: "container" }, "v2", true),
    ).toBe(undefined);
    // No unattended answer surface on 2.x yet: a policy that asks stays on 1.x.
    expect(
      newOpenCodeWorkflowSessionProtocol(
        { policy: { id: "x", approvals: "ask" } as never },
        local,
        "v2",
        true,
      ),
    ).toBe(undefined);
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
      getEnvironment: async () => local,
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

  test("an OpenCode 2.x session takes the per-tab tools credential; a 1.x one does not", () => {
    expect(sessionTakesAgentTools("opencode", "v2")).toBe(true);
    expect(sessionTakesAgentTools("opencode", undefined)).toBe(false);
    expect(sessionTakesAgentTools("claude", undefined)).toBe(true);
  });
});
