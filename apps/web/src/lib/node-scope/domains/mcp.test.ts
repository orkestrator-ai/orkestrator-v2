/**
 * The `mcp` domain client over a `lib/backend` factory client (plan item
 * 7008), against fake nodes: the client's own node takes version 1 when it
 * advertises the domain (envelope, decoded snapshot with its
 * `protocolVersion`) and version 0 otherwise (today's call, with the
 * arguments object `machineInvoke` always sent); another machine is always
 * version 0.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MCP_MANAGEMENT_PROTOCOL_VERSION } from "@orkestrator/protocol/mcp-management";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";
import type { BackendClient } from "@/lib/backend/client";
import { invoke } from "@/lib/native/backend";
import { createMcpManagementApi } from "@/lib/backend/mcp-management";
import { createSignal } from "@/lib/node-scope/signal";
import { mcpOn } from "./mcp";

const operation = {
  operationId: "op-1",
  requestId: "req-1",
  targetId: "backend:pi",
  provider: "pi",
  kind: "apply",
  entryName: "docs",
  sourceId: "pi:user",
  phase: "saved",
  applyIntent: "save-and-apply",
  apply: { state: "queued", runtimes: [], omitted: 0 },
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
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

/** The window's command node: its own transport, which suites mock. */
const portal = invoke as unknown as ReturnType<typeof mock>;
beforeEach(() => {
  portal.mockReset();
  portal.mockImplementation(async () => ({ outcome: "ok", result: operation }));
});
afterEach(() => {
  portal.mockReset();
  portal.mockResolvedValue(undefined);
});

describe("mcp domain client", () => {
  test("a node with the domain gets the envelope and a decoded operation, newer fields kept", async () => {
    const { client, invokeRaw } = fakeClient(operation, { mcp: { min: 1, max: 1 } });
    const read = await createMcpManagementApi(client).applyMcpConfiguration("op-1");
    expect(read).toEqual(operation as never);
    expect(invokeRaw.mock.calls).toEqual([
      [
        "apply_mcp_configuration",
        { operationId: "op-1" },
        { envelope: { domain: "mcp", version: 1 } },
      ],
    ] as never);
  });

  test("version 1 refuses a snapshot without its protocol version", async () => {
    const { client } = fakeClient({ target: {} }, { mcp: { min: 1, max: 1 } });
    await expect(createMcpManagementApi(client).getMcpManagementSnapshot("t")).rejects.toThrow();
    const { client: versioned } = fakeClient(
      { protocolVersion: MCP_MANAGEMENT_PROTOCOL_VERSION },
      { mcp: { min: 1, max: 1 } },
    );
    // Still refused: the snapshot's target, sources and rows are declared.
    await expect(createMcpManagementApi(versioned).getMcpManagementSnapshot("t")).rejects.toThrow();
  });

  test("a pre-contract node, or a client without negotiation, gets today's call", async () => {
    for (const domains of [null, undefined]) {
      const { client, invokeRaw } = fakeClient({ older: "shape" }, domains);
      expect(await createMcpManagementApi(client).listMcpManagementTargets()).toEqual({
        older: "shape",
      } as never);
      expect(invokeRaw.mock.calls).toEqual([["list_mcp_management_targets", {}]] as never);
    }
  });

  test("another machine goes through the command node, version 0, whatever this node speaks", async () => {
    const { client, invokeRaw } = fakeClient(operation, { mcp: { min: 1, max: 1 } });
    await mcpOn(client)("leaf").get_mcp_operation({ operationId: "op-1" });
    await mcpOn(client)(null).cancel_mcp_apply({ operationId: "op-1" });
    expect(invokeRaw).not.toHaveBeenCalled();
    expect(portal.mock.calls.map(([command, args]) => [command, args])).toEqual([
      [
        "invoke_on_node",
        expect.objectContaining({
          nodeId: "leaf",
          command: "get_mcp_operation",
          args: { operationId: "op-1" },
        }),
      ],
      ["cancel_mcp_apply", { operationId: "op-1" }],
    ]);
  });
});
