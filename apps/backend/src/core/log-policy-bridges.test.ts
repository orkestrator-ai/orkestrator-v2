import { describe, expect, test } from "bun:test";
import { listRunningBridgeTargets } from "./log-policy-bridges.js";
import type { CommandContext } from "./commands-context.js";

/** Only what the listing reads; the Docker half has its own coverage through `getHostPort`. */
function context(options: {
  processes: Record<string, string | undefined>;
  environments: Array<Record<string, unknown>>;
}): CommandContext {
  return {
    runtime: {
      localServers: {
        processKeys: () => Object.keys(options.processes),
        bridgeToken: (kind: string, environmentId: string) =>
          options.processes[`${kind}:${environmentId}`],
      },
    },
    storage: {
      loadEnvironments: async () => options.environments,
      getEnvironment: async (id: string) =>
        options.environments.find((environment) => environment.id === id) ?? null,
    },
  } as unknown as CommandContext;
}

describe("listRunningBridgeTargets", () => {
  test("lists each running local bridge with its own port and token", async () => {
    const targets = await listRunningBridgeTargets(
      context({
        processes: { "claude:env-1": "token-claude", "codex:env-1": "token-codex" },
        environments: [
          { id: "env-1", environmentType: "local", localClaudePort: 4101, localCodexPort: 4102 },
        ],
      }),
    );
    expect(targets).toEqual([
      { agent: "claude", baseUrl: "http://127.0.0.1:4101", authToken: "token-claude" },
      { agent: "codex", baseUrl: "http://127.0.0.1:4102", authToken: "token-codex" },
    ]);
  });

  test("leaves out OpenCode, which has no bridge of ours, and anything half started", async () => {
    const targets = await listRunningBridgeTargets(
      context({
        processes: {
          "opencode:env-1": "token-opencode",
          "pi:env-1": undefined,
          "cursor:gone": "token-cursor",
          "claude:env-1": "token-claude",
        },
        environments: [
          {
            id: "env-1",
            environmentType: "local",
            localOpencodePort: 4103,
            localPiPort: 4104,
            localClaudePort: 4105,
          },
        ],
      }),
    );
    // The one that cannot be resolved does not cost the others their update.
    expect(targets).toEqual([
      { agent: "claude", baseUrl: "http://127.0.0.1:4105", authToken: "token-claude" },
    ]);
  });

  test("does not look inside a container that is not running", async () => {
    const targets = await listRunningBridgeTargets(
      context({
        processes: {},
        environments: [
          { id: "env-2", environmentType: "containerized", status: "stopped", containerId: "c" },
        ],
      }),
    );
    expect(targets).toEqual([]);
  });
});
