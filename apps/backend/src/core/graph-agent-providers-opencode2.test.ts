/**
 * Graph describe, goal verifier and subork sessions build their providers
 * through `GraphAgentProviders`; given `openCode2Workflow` (as `index.ts`
 * now passes), their OpenCode sessions follow the 2.x preview switch like
 * every other workflow.
 */
import { describe, expect, test } from "bun:test";
import { OpenCodeMessageIdCoordinator } from "@orkestrator/protocol/opencode-message-id";
import { openCodeFake } from "./agent-provider-test-support.js";
import { GraphAgentProviders } from "./graph-agent-providers.js";
import type { Environment } from "./models.js";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import { FakeOpenCode2Server } from "./opencode2/fake-server.test-support.js";
import { OpenCode2Provider } from "./opencode2/provider.js";

function providers(line: "v2" | undefined) {
  const server = new FakeOpenCode2Server();
  const fake = openCodeFake();
  const recorded: string[] = [];
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
      openCodeClient: fake.client,
      openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
      openCode2Workflow: (environmentId) => {
        asked.push(environmentId);
        return {
          connection: async () => ({
            baseUrl: "http://127.0.0.1:1",
            password: "pw",
            directory: "/work",
            generation: environmentId,
          }),
          persistedProtocol: async (id) => (recorded.includes(id) ? "v2" : undefined),
          newSessionProtocol: async () => line,
          recordSession: async (id) => void recorded.push(id),
          createProvider: () => new OpenCode2Provider(server.client(), { monitorEvents: false }),
        };
      },
    },
  });
  return { server, fake, recorded, asked, graphProviders };
}

const POLICY = resolveNativeAgentExecutionPolicy(
  { environmentType: "local", networkAccessMode: "full" },
  "automated-review",
);
const environment = { id: "env-7", environmentType: "local" } as Environment;

describe("GraphAgentProviders with the OpenCode 2.x workflow routing", () => {
  test("a session created while the switch says 2.x runs there and is recorded first", async () => {
    const { server, fake, recorded, asked, graphProviders } = providers("v2");
    try {
      const provider = await graphProviders.get(environment, "opencode", "subork-1");
      const id = await provider.createSession("review", "Subork · codex", {
        reviewerSession: true,
        policy: POLICY,
      });
      expect(asked).toEqual(["env-7"]);
      expect(server.sessions.has(id)).toBe(true);
      expect(recorded).toEqual([id]);
      expect(fake.createCalls).toHaveLength(0);
    } finally {
      graphProviders.shutdown();
      server.stop();
    }
  });

  test("a session the switch keeps on 1.x stays there", async () => {
    const { server, fake, recorded, graphProviders } = providers(undefined);
    try {
      const provider = await graphProviders.get(environment, "opencode", "verifier-1");
      await provider.createSession("review", "Goal · Verifier", {
        reviewerSession: true,
        policy: POLICY,
      });
      expect(fake.createCalls).toHaveLength(1);
      expect(server.sessions.size).toBe(0);
      expect(recorded).toEqual([]);
    } finally {
      graphProviders.shutdown();
      server.stop();
    }
  });
});
