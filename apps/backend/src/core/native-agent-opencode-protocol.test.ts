import { describe, expect, test } from "bun:test";
import {
  newOpenCodeSessionProtocol,
  openCodeRoutingDependencies,
  persistedOpenCodeProtocol,
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
