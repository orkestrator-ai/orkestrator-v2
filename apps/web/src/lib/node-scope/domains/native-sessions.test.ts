import { describe, expect, mock, test } from "bun:test";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";
import type { BackendClient } from "@/lib/backend/client";
import { createDockerSkillsApi } from "@/lib/backend/docker-skills";
import { createSignal } from "@/lib/node-scope/signal";
import { nativeSessions } from "./native-sessions";

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

const identity = { environmentId: "env-1", agent: "codex", logicalSessionKey: "tab-1" };

describe("native-sessions over a lib/backend client", () => {
  test("a node with the domain gets typed calls with the envelope", async () => {
    const client = fakeClient({ "native-sessions": { min: 1, max: 6 } }, () => ({
      discarded: true,
    }));
    await expect(
      nativeSessions(client).discard_native_agent_dispatch({ ...identity, requestId: "r1" }),
    ).resolves.toEqual({ discarded: true });
    expect(client.invokeRaw).toHaveBeenCalledWith(
      "discard_native_agent_dispatch",
      { ...identity, requestId: "r1" },
      { envelope: { domain: "native-sessions", version: 6 } },
    );
    // Both capability reads are part of the version: nothing is asked.
    await nativeSessions(client).handoffCapabilities();
    await nativeSessions(client).syncCapabilities();
    expect(client.invokeRaw).toHaveBeenCalledTimes(1);
  });

  test("before the hello, a call goes unnegotiated: today's call, answered as sent", async () => {
    const answer = { anything: "as sent" };
    const client = fakeClient(null, () => answer);
    await expect(nativeSessions(client).get_native_agent_session(identity)).resolves.toBe(
      answer as never,
    );
    expect(client.invokeRaw).toHaveBeenLastCalledWith("get_native_agent_session", identity);
    // The capability reads are part of every supported version: nothing is asked.
    await nativeSessions(client).syncCapabilities();
    await nativeSessions(client).handoffCapabilities();
    expect(client.invokeRaw).toHaveBeenCalledTimes(1);
  });

  test("a client that carries no negotiation answers the handoff capabilities itself", async () => {
    const invokeRaw = mock(async () => null);
    const client = { invokeRaw } as unknown as BackendClient;
    await expect(nativeSessions(client).handoffCapabilities()).resolves.toEqual({
      create: true,
      delivery: true,
      pruning: true,
    });
    expect(invokeRaw).not.toHaveBeenCalled();
  });

  test("the DNS check is the domain's call: typed and decoded on a node with it", async () => {
    const answer = [
      { domain: "a.test", valid: true, resolvable: true, ips: ["1.2.3.4"], error: null },
    ];
    const client = fakeClient({ "native-sessions": { min: 1, max: 6 } }, () => answer);
    await expect(createDockerSkillsApi(client).testDomainResolution(["a.test"])).resolves.toEqual(
      answer,
    );
    expect(client.invokeRaw).toHaveBeenCalledWith(
      "test_domain_resolution",
      { domains: ["a.test"] },
      { envelope: { domain: "native-sessions", version: 6 } },
    );
    const bad = fakeClient({ "native-sessions": { min: 1, max: 6 } }, () => [{ domain: 1 }]);
    await expect(createDockerSkillsApi(bad).testDomainResolution(["a.test"])).rejects.toThrow(
      "Invalid result from test_domain_resolution",
    );
  });

  test("the DNS check without negotiation is today's call, answered as sent", async () => {
    const answer = [{ anything: "as sent" }];
    const client = fakeClient(null, () => answer);
    await expect(createDockerSkillsApi(client).testDomainResolution(["a.test"])).resolves.toBe(
      answer as never,
    );
    expect(client.invokeRaw.mock.calls.at(-1)).toEqual([
      "test_domain_resolution",
      { domains: ["a.test"] },
    ]);
  });
});
