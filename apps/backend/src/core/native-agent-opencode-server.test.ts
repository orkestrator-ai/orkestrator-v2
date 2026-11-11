import { describe, expect, test } from "bun:test";
import {
  openCodeEnvironmentDependencies,
  openCodeWorkflowDependencies,
  sessionTakesAgentTools,
} from "./native-agent-opencode-server.js";
import type { OpenCode2ServerConnection } from "./opencode2/environment-provider.js";

const server: OpenCode2ServerConnection = {
  baseUrl: "http://127.0.0.1:1",
  password: "secret",
  directory: "/work",
  generation: "1",
};

describe("openCodeEnvironmentDependencies", () => {
  test("needs a server host; without one there is no OpenCode server to reach", () => {
    expect(openCodeEnvironmentDependencies(undefined, {}, "env")).toBeUndefined();
  });

  test("asks the host for this environment's server, starting it only when told to", async () => {
    const calls: Array<[string, boolean]> = [];
    const deps = openCodeEnvironmentDependencies(
      async (environmentId, options) => {
        calls.push([environmentId, options.start]);
        return options.start ? server : undefined;
      },
      {},
      "env-1",
    )!;
    expect(await deps.connection({ start: false })).toBeUndefined();
    expect(await deps.connection({ start: true })).toBe(server);
    expect(calls).toEqual([
      ["env-1", false],
      ["env-1", true],
    ]);
  });

  test("reads the model provider allowlist per call, so a settings edit applies at once", async () => {
    let providers: unknown = ["openai"];
    const deps = openCodeEnvironmentDependencies(
      async () => undefined,
      { loadConfig: async () => ({ global: { openCodeModelProviders: providers } }) },
      "env",
    )!;
    expect(await deps.allowedModelProviders!()).toEqual(["openai"]);
    providers = ["anthropic", "opencode"];
    expect(await deps.allowedModelProviders!()).toEqual(["anthropic", "opencode"]);
  });
});

describe("openCodeWorkflowDependencies", () => {
  test("hand a worker mailbox resolver to the provider only when given one", () => {
    const host = async () => undefined;
    const workerMailbox = async () => undefined;
    expect(openCodeWorkflowDependencies(host, {}, "env", { workerMailbox })!.workerMailbox).toBe(
      workerMailbox,
    );
    expect(openCodeWorkflowDependencies(host, {}, "env")!.workerMailbox).toBeUndefined();
  });
});

test("an OpenCode session takes the per-tab tools credential, as Claude's does", () => {
  expect(sessionTakesAgentTools("opencode")).toBe(true);
  expect(sessionTakesAgentTools("claude")).toBe(true);
});
