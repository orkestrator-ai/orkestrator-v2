/**
 * The `mcp` domain (plan item 7008): the definitions declare the keys the
 * handlers pass to `McpManagementService`, classify reads as the routing
 * classifier does, refuse nothing the service accepted, keep every field of a
 * record (and `protocolVersion`) through a client's decode, and the client
 * sends the envelope only to a node with the domain.
 */
import { describe, expect, it } from "bun:test";
import * as Result from "effect/Result";
import { isNodeReadCommand } from "../../../command-nodes.js";
import { MCP_MANAGEMENT_PROTOCOL_VERSION } from "../../../mcp-management.js";
import type { NegotiatedDomains } from "../../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { decodeCommandArgs, decodeCommandResult, type AnyCommandDef } from "../../command.js";
import {
  getMcpManagementSnapshotCommand,
  listMcpManagementTargetsCommand,
  MCP_COMMANDS,
  mcpClient,
  mutateMcpDefinitionCommand,
  refreshMcpEnvironmentDefaultsCommand,
  setMcpManagementRolloutCommand,
} from "./index.js";

/** The keys each handler (or the service method it calls) read before (2026-11-07). */
const HANDLER_KEYS: Record<string, readonly string[]> = {
  list_mcp_management_targets: ["environmentId"],
  get_mcp_management_snapshot: ["targetId"],
  get_mcp_definition: ["targetId", "entryId"],
  validate_mcp_mutation: ["mutation"],
  mutate_mcp_definition: ["mutation"],
  apply_mcp_configuration: ["operationId"],
  get_mcp_operation: ["operationId"],
  cancel_mcp_apply: ["operationId"],
  resolve_mcp_environment_overlay: ["resolution"],
  preview_mcp_environment_defaults: ["request"],
  refresh_mcp_environment_defaults: ["request"],
  get_mcp_management_rollout: [],
  set_mcp_management_rollout: ["enabled", "writeProviders", "applyProviders"],
};

const ALL: readonly AnyCommandDef[] = MCP_COMMANDS;

const capability = { supported: true };
const target = {
  targetId: "backend:claude",
  backendId: "bk-1",
  provider: "claude",
  providerLabel: "Claude",
  context: { kind: "backend", location: "backend-host", locationLabel: "This computer" },
  defaultSourceId: "claude:user",
  capabilities: {
    management: capability,
    transports: { stdio: capability, http: capability, sse: capability },
    operations: {
      add: capability,
      update: capability,
      rename: capability,
      remove: capability,
      setEnabled: capability,
    },
    fields: { env: capability, headers: capability, cwd: capability, advanced: [] },
    authentication: { staticHeaders: true, envReferences: true, runtimeSignIn: capability },
    apply: { strategy: "next-query", impact: "session", description: "Next query." },
    terminal: { readsNativeConfig: true, guidance: "" },
    nameRule: { pattern: "^[a-z]+$", description: "letters", maxBytes: 64 },
    newerCapability: { supported: true },
  },
};
const operation = {
  operationId: "op-1",
  requestId: "req-1",
  targetId: "backend:claude",
  provider: "claude",
  kind: "add",
  entryName: "docs",
  sourceId: "claude:user",
  phase: "saved",
  savedRevision: "rev-2",
  applyIntent: "save",
  apply: { state: "not-requested", runtimes: [], omitted: 0, newerApplyField: 1 },
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
};
const snapshot = {
  protocolVersion: MCP_MANAGEMENT_PROTOCOL_VERSION,
  target,
  sources: [
    {
      sourceId: "claude:user",
      scope: "user",
      owner: "provider",
      format: "json",
      label: "User",
      displayPath: "~/.claude.json",
      precedence: 1,
      state: "ok",
      writable: true,
      revision: "rev-2",
      sharedWith: [],
    },
  ],
  definitions: [
    {
      entryId: "e-1",
      sourceId: "claude:user",
      name: "docs",
      transport: "http",
      enabled: null,
      status: "effective",
      shadows: [],
      actions: { edit: capability, rename: capability, remove: capability, setEnabled: capability },
      preservedFields: [],
      secretCount: 0,
    },
  ],
  effective: { docs: "e-1" },
  operations: [operation],
  catalogRevision: 4,
  freshness: "fresh",
  truncated: 0,
  generatedAt: "2026-11-07T00:00:00.000Z",
};

describe("mcp definitions", () => {
  it("cover the 13 commands once, each in version 1 of the domain", () => {
    expect(ALL).toHaveLength(13);
    expect(ALL.map((def) => def.name).sort()).toEqual(Object.keys(HANDLER_KEYS).sort());
    for (const def of ALL) {
      expect({ name: def.name, since: def.since, domain: def.domain.name }).toEqual({
        name: def.name,
        since: 1,
        domain: "mcp",
      });
    }
  });

  it("declare exactly the keys each handler reads, none critical", () => {
    for (const def of ALL) {
      expect({ name: def.name, keys: Object.keys(def.args.fields).sort() }).toEqual({
        name: def.name,
        keys: [...HANDLER_KEYS[def.name]!].sort(),
      });
      expect({ name: def.name, critical: def.critical }).toEqual({ name: def.name, critical: [] });
    }
  });

  it("classify reads as the routing classifier does; only the rollout gate is admin", () => {
    for (const def of ALL) {
      expect({ name: def.name, read: def.read }).toEqual({
        name: def.name,
        read: isNodeReadCommand(def.name),
      });
      expect({ name: def.name, access: def.access }).toEqual({
        name: def.name,
        access: def.name.endsWith("_mcp_management_rollout") ? "admin" : "workspace",
      });
    }
  });

  it("refuse nothing the service checked itself, and drop unknown keys", () => {
    // The service answers these with its own `invalid-request`/`unknown-target`.
    for (const args of [
      { targetId: 7 },
      { targetId: "../../etc", entryId: null },
      { mutation: "not a mutation" },
    ]) {
      expect(Result.isSuccess(decodeCommandArgs(getMcpManagementSnapshotCommand, args))).toBe(true);
      expect(Result.isSuccess(decodeCommandArgs(mutateMcpDefinitionCommand, args))).toBe(true);
    }
    expect(
      Result.isSuccess(decodeCommandArgs(setMcpManagementRolloutCommand, { enabled: "yes" })),
    ).toBe(true);
    const decoded = decodeCommandArgs(listMcpManagementTargetsCommand, {
      environmentId: "env-1",
      newerOption: true,
    });
    expect(Result.isSuccess(decoded) && decoded.success).toEqual({ environmentId: "env-1" });
  });

  it("decode a snapshot whole: protocolVersion and undeclared fields survive", () => {
    const decoded = decodeCommandResult(getMcpManagementSnapshotCommand, snapshot);
    expect(Result.isSuccess(decoded) && (decoded.success as unknown)).toEqual(snapshot);
    const list = decodeCommandResult(listMcpManagementTargetsCommand, {
      protocolVersion: MCP_MANAGEMENT_PROTOCOL_VERSION,
      backendId: "bk-1",
      targets: [target],
      newerListField: "kept",
    });
    expect(Result.isSuccess(list) && list.success).toMatchObject({
      protocolVersion: MCP_MANAGEMENT_PROTOCOL_VERSION,
      newerListField: "kept",
      targets: [{ capabilities: { newerCapability: { supported: true } } }],
    });
    // A snapshot without its protocol version, or an operation without its id, is refused.
    const { protocolVersion: _version, ...unversioned } = snapshot;
    expect(
      Result.isFailure(decodeCommandResult(getMcpManagementSnapshotCommand, unversioned)),
    ).toBe(true);
    const { operationId: _id, ...anonymous } = operation;
    expect(
      Result.isFailure(
        decodeCommandResult(mutateMcpDefinitionCommand, {
          operation: anonymous,
          replayed: false,
          savedRevision: "rev-2",
          entryId: "e-1",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        decodeCommandResult(refreshMcpEnvironmentDefaultsCommand, {
          sourceRevision: null,
          overlay: null,
          stagedCopy: "not-needed",
        }),
      ),
    ).toBe(true);
  });
});

function fakeTransport(domains: NegotiatedDomains | null) {
  const calls: Array<{
    command: string;
    args: unknown;
    envelope: ContractEnvelopeFields | undefined;
  }> = [];
  const invoked: Array<{ command: string; args: unknown }> = [];
  const answer = (command: string): unknown =>
    command === "get_mcp_management_snapshot" ? snapshot : { olderShape: true };
  const client = createDomainClient(mcpClient, {
    call: async (def, args, envelope) => {
      calls.push({ command: def.name, args, envelope });
      return answer(def.name);
    },
    domains: () => domains,
    invoke: async (command, args) => {
      invoked.push({ command, args });
      return answer(command);
    },
  });
  return { client, calls, invoked };
}

describe("mcp client", () => {
  it("version 1 sends the envelope and decodes the snapshot", async () => {
    const { client, calls, invoked } = fakeTransport({ mcp: { min: 1, max: 1 } });
    expect(client.version()).toBe(1);
    const read = await client.api().get_mcp_management_snapshot({ targetId: "backend:claude" });
    expect(read.protocolVersion).toBe(MCP_MANAGEMENT_PROTOCOL_VERSION);
    expect(read.definitions[0]?.entryId).toBe("e-1");
    expect(calls).toEqual([
      {
        command: "get_mcp_management_snapshot",
        args: { targetId: "backend:claude" },
        envelope: { domain: "mcp", version: 1 },
      },
    ]);
    expect(invoked).toEqual([]);
  });

  it("version 0 sends today's call without an envelope and returns the answer as sent", async () => {
    const { client, calls, invoked } = fakeTransport(null);
    expect(client.version()).toBe(0);
    const answer = await client.api().get_mcp_operation({ operationId: "op-1" });
    expect(answer as unknown).toEqual({ olderShape: true });
    expect(invoked).toEqual([{ command: "get_mcp_operation", args: { operationId: "op-1" } }]);
    expect(calls).toEqual([]);
  });
});
