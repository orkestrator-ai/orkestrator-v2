import { describe, expect, test } from "bun:test";
import { listRunningBridgeTargets } from "./log-policy-bridges.js";
import type { CommandContext } from "./commands-context.js";

/** Only the storage and runtime surfaces the metadata discovery reads. */
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

const token = "a".repeat(43);

test("running container discovery validates tokens, de-duplicates shared runtimes and isolates failures", async () => {
  const reads: string[] = [];
  const targets = await listRunningBridgeTargets(
    context({
      processes: {},
      environments: [
        { id: "one", status: "running", containerId: "shared" },
        { id: "two", status: "running", containerId: "shared" },
      ],
    }),
    undefined,
    {
      getHostPort: async (_id, port) => port + 1000,
      dockerExec: async (id, command) => {
        reads.push(`${id}:${command}`);
        if (command.includes("claude")) return ` ${token}\n`;
        if (command.includes("codex")) return "invalid token";
        if (command.includes("cursor")) throw new Error("unreadable");
        return "";
      },
    },
  );
  expect(reads).toHaveLength(5);
  expect(targets).toEqual([
    { agent: "claude", baseUrl: "http://127.0.0.1:5097", authToken: token },
  ]);
});

test("local and healthy Docker targets are emitted while another token read awaits its deadline", async () => {
  const reached = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<string>();
  const emitted: string[] = [];
  const requests: number[] = [];
  const discovery = listRunningBridgeTargets(
    context({
      processes: { "claude:local": "local-token" },
      environments: [
        { id: "local", environmentType: "local", localClaudePort: 4101 },
        { id: "docker", status: "running", containerId: "container" },
      ],
    }),
    (target) => emitted.push(target.baseUrl),
    {
      getHostPort: async (_id, port) => port + 1000,
      dockerExec: async (_id, command, timeoutMs, _redact, signal) => {
        requests.push(timeoutMs!);
        expect(signal).toBeDefined();
        expect(timeoutMs).toBe(3000);
        if (command.includes("claude")) {
          // Emulate the command runner rejecting on the passed deadline.
          signal!.addEventListener("abort", () => failed.reject(signal!.reason), { once: true });
          reached.resolve();
          return failed.promise;
        }
        return token;
      },
    },
  );
  await reached.promise;
  // Flush the other discovery workers without waiting for the blocked lookup.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(emitted).toContain("http://127.0.0.1:4101");
  expect(emitted).toContain("http://127.0.0.1:5099");
  // Token subprocesses receive a short timeout and the whole lookup's signal.
  failed.reject(new Error("deadline"));
  const targets = await discovery;
  expect(targets).toHaveLength(5);
  expect(requests).toHaveLength(5);
});
