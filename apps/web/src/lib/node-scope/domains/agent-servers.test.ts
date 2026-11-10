import { describe, expect, mock, test } from "bun:test";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";
import type { BackendClient } from "@/lib/backend/client";
import { createDockerSkillsApi } from "@/lib/backend/docker-skills";
import { createSignal } from "@/lib/node-scope/signal";
import { agentServersApi } from "./agent-servers";

function fakeClient(
  domains: NegotiatedDomains | null,
  answer: (command: string) => unknown = () => null,
): BackendClient & { invokeRaw: ReturnType<typeof mock> } {
  return {
    invokeRaw: mock(async (command: string) => answer(command)) as never,
    domains: createSignal<NegotiatedDomains | null>(domains),
    capabilities: createSignal<ReadonlySet<string> | null>(null),
  };
}

const AGENT_SERVERS = { "agent-servers": { min: 1, max: 1 } };

describe("agent-servers over a lib/backend client", () => {
  test("a node with the domain gets typed calls with the envelope and its critical keys", async () => {
    const client = fakeClient(AGENT_SERVERS, () => "tail");
    await expect(
      createDockerSkillsApi(client).getContainerServerLog("codex", "c1", { previous: true }),
    ).resolves.toBe("tail");
    expect(client.invokeRaw).toHaveBeenCalledWith(
      "get_codex_server_log",
      { containerId: "c1", previous: true },
      { envelope: { domain: "agent-servers", version: 1, critical: ["previous"] } },
    );
  });

  test("a node with the domain has its results decoded", async () => {
    const client = fakeClient(AGENT_SERVERS, () => ({ running: "yes" }));
    await expect(
      agentServersApi(client).get_local_pi_server_status({ environmentId: "env-1" }),
    ).rejects.toThrow("Invalid result from get_local_pi_server_status");
  });

  test("a pre-contract node gets today's calls, answered as sent", async () => {
    const answer = { anything: "as sent" };
    const client = fakeClient(null, () => answer);
    const api = createDockerSkillsApi(client);
    await expect(api.getGitHubCliStatus()).resolves.toBe(answer as never);
    await api.getGitHubCliStatus();
    // The machine-aware functions always sent an arguments object.
    expect(client.invokeRaw.mock.calls.at(-1)).toEqual(["get_github_cli_status", {}]);
    await api.listEnvironmentAgentSkills("env-1", "codex");
    expect(client.invokeRaw.mock.calls.at(-1)).toEqual([
      "list_environment_agent_skills",
      { environmentId: "env-1", provider: "codex" },
    ]);
  });
});
