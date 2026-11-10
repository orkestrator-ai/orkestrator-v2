/**
 * The `agent-mail` domain client over a `lib/backend` factory client (plan
 * item 7008), against fake nodes: a node that advertises the domain takes
 * version 1 (envelope, critical keys, decoded results); a pre-contract node or
 * a client without negotiation takes version 0, whose calls are today's.
 */
import { describe, expect, mock, test } from "bun:test";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";
import type { BackendClient } from "@/lib/backend/client";
import { createAgentMailApi } from "@/lib/backend/agent-mail";
import { createSignal } from "@/lib/node-scope/signal";

const message = {
  version: 1,
  id: "m-1",
  threadId: "m-1",
  requestId: "req-1",
  createdAt: "2026-11-07T00:00:00.000Z",
  from: { kind: "user" },
  toEnvironmentId: "env-1",
  toTabId: "tab-1",
  toIncarnationId: "inc-1",
  body: "hello",
  bodyBytes: 5,
  trust: "user",
  injectDepth: 0,
  threadDepth: 0,
  placement: "pending-inject",
  revision: 3,
  newerField: "kept",
};

function fakeClient(answer: unknown, domains?: NegotiatedDomains | null) {
  const invokeRaw = mock(async (_command: string, _args?: unknown, _options?: unknown) => answer);
  const client: BackendClient = {
    invokeRaw: invokeRaw as unknown as BackendClient["invokeRaw"],
    ...(domains === undefined
      ? {}
      : {
          domains: createSignal<NegotiatedDomains | null>(domains),
          capabilities: createSignal<ReadonlySet<string> | null>(null),
        }),
  };
  return { client, invokeRaw };
}

describe("agent-mail domain client", () => {
  test("a node with the domain gets the envelope, its critical key and a decoded message", async () => {
    const { client, invokeRaw } = fakeClient(message, { "agent-mail": { min: 1, max: 1 } });
    const delivered = await createAgentMailApi(client).deliverAgentMailNow("env-1", "tab-1", "m-1");
    expect(delivered).toEqual(message as never);
    expect(invokeRaw.mock.calls).toEqual([
      [
        "retry_agent_mail_inject",
        { environmentId: "env-1", tabId: "tab-1", messageId: "m-1", now: true },
        { envelope: { domain: "agent-mail", version: 1, critical: ["now"] } },
      ],
    ] as never);
  });

  test("a pre-contract node, or a client without negotiation, gets today's call", async () => {
    for (const domains of [null, undefined]) {
      const { client, invokeRaw } = fakeClient({ older: "shape" }, domains);
      const api = createAgentMailApi(client);
      expect(await api.getAgentMailSummary()).toEqual({ older: "shape" } as never);
      await api.sendAgentMail({
        requestId: "req-1",
        toEnvironmentId: "env-1",
        toTabId: "tab-1",
        body: "hello",
      });
      expect(invokeRaw.mock.calls).toEqual([
        ["get_agent_mail_summary"],
        [
          "send_agent_mail",
          { requestId: "req-1", toEnvironmentId: "env-1", toTabId: "tab-1", body: "hello" },
        ],
      ] as never);
    }
  });
});
