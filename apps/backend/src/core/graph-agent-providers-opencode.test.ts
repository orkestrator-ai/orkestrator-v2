/**
 * Graph describe, goal verifier and subork sessions build their providers
 * through `GraphAgentProviders`; given `openCodeWorkflow` (as `index.ts`
 * passes), their OpenCode sessions run on the environment's OpenCode server.
 */
import { describe, expect, test } from "bun:test";
import { GraphAgentProviders } from "./graph-agent-providers.js";
import type { Environment } from "./models.js";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import { FakeOpenCode2Server } from "./opencode2/fake-server.test-support.js";
import { OpenCode2Provider } from "./opencode2/provider.js";

function providers() {
  const server = new FakeOpenCode2Server();
  const asked: string[] = [];
  const graphProviders = new GraphAgentProviders({
    connection: async (environment, agent) => ({
      agent,
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: `/work/${environment.id}`,
      model: "fixture/fixture",
    }),
    dependencies: {
      openCodeWorkflow: (environmentId) => {
        asked.push(environmentId);
        return {
          connection: async () => ({
            baseUrl: "http://127.0.0.1:1",
            password: "pw",
            directory: "/work",
            generation: environmentId,
          }),
          createProvider: () => new OpenCode2Provider(server.client(), { monitorEvents: false }),
        };
      },
    },
  });
  return { server, asked, graphProviders };
}

const POLICY = resolveNativeAgentExecutionPolicy(
  { environmentType: "local", networkAccessMode: "full" },
  "automated-review",
);
const environment = { id: "env-7", environmentType: "local" } as Environment;

describe("GraphAgentProviders with OpenCode", () => {
  test("a session runs on the environment's OpenCode server", async () => {
    const { server, asked, graphProviders } = providers();
    try {
      const provider = await graphProviders.get(environment, "opencode", "subork-1");
      const id = await provider.createSession("review", "Subork · codex", {
        reviewerSession: true,
        policy: POLICY,
      });
      expect(asked).toEqual(["env-7"]);
      expect(server.sessions.has(id)).toBe(true);
    } finally {
      graphProviders.shutdown();
      server.stop();
    }
  });
});
