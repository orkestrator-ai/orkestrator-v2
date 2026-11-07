/**
 * The `nodes` domain (plan item 7009): its 51 definitions classify reads as
 * the routing classifier does and access as recorded, decode arguments
 * tolerantly (the handlers were strict), keep model records open, and its
 * client sends typed, enveloped calls to a node with the domain while a
 * pre-contract node (or the portal's un-negotiated client) gets today's
 * untyped calls.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { isNodeReadCommand } from "../../../command-nodes.js";
import type { NegotiatedDomains } from "../../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { DOMAIN_CLIENTS } from "../../client-adapters.js";
import { decodeCommandArgs, decodeCommandResult, type AnyCommandDef } from "../../command.js";
import { canonicalJsonSchema } from "../../json-schema.js";
import {
  NODES_COMMANDS,
  RoutedResultSchema,
  forgetNodeCommand,
  invokeOnNodeCommand,
  listNodesCommand,
  nodesClient,
  nodesDomain,
} from "./index.js";

/** Reached by a workspace grant or the relay (`access: "workspace"`). */
const WORKSPACE = new Set([
  "dismiss_node_outcome",
  "get_backend_profile",
  "get_node_status",
  "list_node_outcomes",
  "read_environment_details",
]);

/** Called by another backend over the link, or by a coordinator tool in process. */
const INTERNAL = new Set([
  "accept_command_handover",
  "apply_env_keys",
  "attach_controller",
  "create_client_grant",
  "detach_controller",
  "fingerprint_project_files",
  "get_project_seed_files",
  "read_env_values",
  "renew_client_grant",
  "revoke_client_grant",
  "run_granted_agent_account_switch",
  "run_timer_agent_account_switch",
  "sync_controller_settings",
]);

const CRITICAL: Record<string, readonly string[]> = {
  accept_command_handover: ["handoverId"],
  forget_node: ["withoutDetach"],
  hand_over_command: ["nodeIds", "includeSelf", "entries"],
  invoke_on_node: ["requestKey"],
};

describe("nodes definitions", () => {
  it("defines the domain's 51 commands once each, at version 1", () => {
    const names = NODES_COMMANDS.map((def) => def.name);
    expect(names).toHaveLength(51);
    expect(new Set(names).size).toBe(51);
    expect(nodesDomain).toMatchObject({ name: "nodes", version: 1, min: 1 });
    for (const def of NODES_COMMANDS) {
      expect(def.domain).toBe(nodesDomain);
      expect(def.since).toBe(1);
    }
  });

  it("classifies reads with the routing classifier, and access and critical keys as recorded", () => {
    for (const def of NODES_COMMANDS) {
      expect({ name: def.name, read: def.read }).toEqual({
        name: def.name,
        read: isNodeReadCommand(def.name),
      });
      const access = WORKSPACE.has(def.name)
        ? "workspace"
        : INTERNAL.has(def.name)
          ? "internal"
          : "admin";
      expect({ name: def.name, access: def.access }).toEqual({ name: def.name, access });
      expect({ name: def.name, critical: def.critical }).toEqual({
        name: def.name,
        critical: CRITICAL[def.name] ?? [],
      });
    }
  });

  it("exports every schema as JSON Schema, the same each time", () => {
    for (const def of NODES_COMMANDS) {
      expect(canonicalJsonSchema(def.args)).toEqual(canonicalJsonSchema(def.args));
      expect(canonicalJsonSchema(def.result)).toEqual(canonicalJsonSchema(def.result));
      expect(() => Schema.toJsonSchemaDocument(def.result)).not.toThrow();
    }
  });

  it("drops unknown argument keys and refuses an unknown critical one", () => {
    const args = { nodeId: "bk_a", withoutDetach: true, future: 1 };
    const decoded = decodeCommandArgs(forgetNodeCommand, args);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") {
      expect(decoded.success).toEqual({ nodeId: "bk_a", withoutDetach: true });
    }
    expect(decodeCommandArgs(forgetNodeCommand, args, { critical: ["future"] })._tag).toBe(
      "Failure",
    );
    // A declared critical key is understood.
    expect(decodeCommandArgs(forgetNodeCommand, args, { critical: ["withoutDetach"] })._tag).toBe(
      "Success",
    );
  });

  it("passes a routed command's arguments and answer through unchanged", () => {
    const routed = {
      nodeId: "bk_a",
      command: "get_projects",
      args: { deep: { nested: [1, { x: true }] } },
      requestKey: "k",
    };
    const decoded = decodeCommandArgs(invokeOnNodeCommand, routed);
    expect(decoded._tag === "Success" && decoded.success).toEqual(routed);
    const ok = { outcome: "ok", result: [{ id: "p1", extra: true }] };
    expect<unknown>(Schema.decodeUnknownSync(RoutedResultSchema)(ok)).toEqual(ok);
    const unknown = { outcome: "unknown", requestKey: "k", outcomeId: "o" };
    expect<unknown>(Schema.decodeUnknownSync(RoutedResultSchema)(unknown)).toEqual(unknown);
  });

  it("keeps every key of an open record through a tolerant decode", () => {
    const list = {
      revision: 3,
      mode: "command",
      suspended: false,
      pendingDetaches: [],
      nodes: [
        {
          nodeId: "bk_a",
          enabled: true,
          displayName: "Mini",
          fallbackName: "mini",
          hasCredential: true,
          routes: [{ id: "r1", kind: "https", enabled: true, origin: "https://mini" }],
          routeOrder: ["r1"],
          attachment: { status: "attached" },
          connection: { state: "connected", epoch: 2 },
          addedAt: "2026-11-07T00:00:00.000Z",
          source: "portal",
          futureField: { kept: true },
        },
      ],
    };
    const decoded = decodeCommandResult(listNodesCommand, list);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect<unknown>(decoded.success).toEqual(list);
    expect(decodeCommandResult(listNodesCommand, { ...list, revision: "3" })._tag).toBe("Failure");
  });

  it("lists its client in DOMAIN_CLIENTS with adapters 1 and 0", () => {
    expect(DOMAIN_CLIENTS).toContain(nodesClient);
    expect(nodesClient.versions).toEqual([1, 0]);
  });
});

function fakeNode(domains: NegotiatedDomains | undefined, answer: () => unknown) {
  const sent: Array<{ command: string; args: unknown; envelope?: ContractEnvelopeFields }> = [];
  const invoked: Array<{ command: string; args: unknown }> = [];
  const usage: Array<[string, number]> = [];
  const options = {
    call: async (def: AnyCommandDef, args: unknown, envelope?: ContractEnvelopeFields) => {
      sent.push({ command: def.name, args, envelope });
      return answer();
    },
    invoke: async (command: string, args?: Readonly<Record<string, unknown>>) => {
      invoked.push({ command, args });
      return answer();
    },
    domains,
    usage: (domain: string, version: number) => usage.push([domain, version]),
  };
  return { sent, invoked, usage, options };
}

describe("nodes client", () => {
  it("version 1: typed calls carry the envelope and its critical keys, results decode", async () => {
    const node = fakeNode({ nodes: { min: 1, max: 1 } }, () => ({
      forgotten: true,
      detached: false,
    }));
    const client = createDomainClient(nodesClient, node.options);
    expect(client.version()).toBe(1);
    await expect(
      client.api().forget_node({ nodeId: "bk_a", withoutDetach: true }),
    ).resolves.toEqual({ forgotten: true, detached: false });
    expect(node.sent).toEqual([
      {
        command: "forget_node",
        args: { nodeId: "bk_a", withoutDetach: true },
        envelope: { domain: "nodes", version: 1, critical: ["withoutDetach"] },
      },
    ]);
    expect(node.invoked).toEqual([]);
    expect(node.usage).toEqual([]);
  });

  it("version 1: a result that does not match its schema is refused", async () => {
    const node = fakeNode({ nodes: { min: 1, max: 1 } }, () => ({ forgotten: "yes" }));
    await expect(
      createDomainClient(nodesClient, node.options).api().forget_node({ nodeId: "bk_a" }),
    ).rejects.toThrow("Invalid result from forget_node");
  });

  it("version 0: today's untyped call, no envelope, the answer as sent, counted", async () => {
    const older = { revision: 1, nodes: [], olderShape: true };
    const node = fakeNode(undefined, () => older);
    const client = createDomainClient(nodesClient, node.options);
    expect(client.version()).toBe(0);
    await expect<unknown>(client.api().list_nodes(undefined as never)).resolves.toBe(older);
    expect(node.invoked).toEqual([{ command: "list_nodes", args: undefined }]);
    expect(node.sent).toEqual([]);
    expect(node.usage).toEqual([["nodes", 0]]);
  });
});
