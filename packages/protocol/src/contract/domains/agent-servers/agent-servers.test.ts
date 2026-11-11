/**
 * The `agent-servers` domain (plan item 7009): its definitions classify reads
 * as the routing classifier does, keep model records open, and its client
 * sends typed, enveloped calls to a node with the domain while a pre-contract
 * node gets today's untyped calls.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { isNodeReadCommand } from "../../../command-nodes.js";
import type { NegotiatedDomains } from "../../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { DOMAIN_CLIENTS } from "../../client-adapters.js";
import { canonicalJsonSchema } from "../../json-schema.js";
import { decodeCommandArgs, decodeCommandResult, type AnyCommandDef } from "../../command.js";
import {
  AGENT_SERVERS_COMMANDS,
  AGENT_SERVER_KINDS,
  agentServersClient,
  agentServersDomain,
  awaitBridgeReadyCommand,
  cancelGithubCliLoginCommand,
  getAgentModelCatalogCacheCommand,
  getClaudeModelCatalogCommand,
  getClaudeServerLogCommand,
  getNativeAgentModelCatalogCommand,
  getOpencodeModelCatalogCacheCommand,
  startCodexServerCommand,
} from "./index.js";

/** Only the backend's own native-agent service peeks at a bridge. */
const INTERNAL = new Set(["peek_local_agent_bridge", "peek_container_agent_bridge"]);

/** Argument keys a receiver must not ignore, per command. */
const CRITICAL: Record<string, readonly string[]> = {
  ...Object.fromEntries(AGENT_SERVER_KINDS.map((kind) => [`get_${kind}_server_log`, ["previous"]])),
  cancel_github_cli_login: ["operationId"],
};

describe("agent-servers definitions", () => {
  it("defines the domain's 74 commands once each, since version 1", () => {
    const names = AGENT_SERVERS_COMMANDS.map((def) => def.name);
    expect(names).toHaveLength(74);
    expect(new Set(names).size).toBe(74);
    expect(agentServersDomain).toMatchObject({ name: "agent-servers", version: 2, min: 1 });
    for (const def of AGENT_SERVERS_COMMANDS) {
      expect(def.domain).toBe(agentServersDomain);
      expect(def.since).toBe(1);
      expect(def.encoded).toBe(false);
    }
    for (const kind of AGENT_SERVER_KINDS) {
      for (const name of [
        `start_${kind}_server`,
        `stop_${kind}_server`,
        `get_${kind}_server_status`,
        `get_${kind}_server_log`,
        `start_local_${kind}_server_cmd`,
        `stop_local_${kind}_server_cmd`,
        `get_local_${kind}_server_status`,
      ]) {
        expect(names as readonly string[]).toContain(name);
      }
    }
  });

  it("classifies reads with the routing classifier, access and critical keys as recorded", () => {
    for (const def of AGENT_SERVERS_COMMANDS) {
      expect({ name: def.name, read: def.read }).toEqual({
        name: def.name,
        read: isNodeReadCommand(def.name),
      });
      expect({ name: def.name, access: def.access }).toEqual({
        name: def.name,
        access: INTERNAL.has(def.name) ? "internal" : "workspace",
      });
      expect({ name: def.name, critical: [...def.critical] }).toEqual({
        name: def.name,
        critical: [...(CRITICAL[def.name] ?? [])],
      });
    }
  });

  it("exports every schema as a stable JSON Schema", () => {
    for (const def of AGENT_SERVERS_COMMANDS) {
      const args = canonicalJsonSchema(def.args);
      const result = canonicalJsonSchema(def.result);
      expect(canonicalJsonSchema(def.args)).toEqual(args);
      expect(canonicalJsonSchema(def.result)).toEqual(result);
      expect(() => Schema.toJsonSchemaDocument(def.result)).not.toThrow();
    }
  });

  it("drops unknown argument keys, refuses an unknown critical one, keeps the old texts", () => {
    const decoded = decodeCommandArgs(startCodexServerCommand, {
      containerId: "c1",
      future: true,
    });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).toEqual({ containerId: "c1" });
    expect(
      decodeCommandArgs(
        startCodexServerCommand,
        { containerId: "c1", future: true },
        { critical: ["future"] },
      )._tag,
    ).toBe("Failure");
    // Lenient keys stay lenient: the handler checks them with its own text.
    expect(
      decodeCommandArgs(awaitBridgeReadyCommand, {
        environmentId: "env-1",
        agent: 7,
        timeoutMs: 5_000,
      })._tag,
    ).toBe("Success");
    expect(
      decodeCommandArgs(getClaudeServerLogCommand, { containerId: "c1", previous: "yes" })._tag,
    ).toBe("Success");
    expect(decodeCommandArgs(cancelGithubCliLoginCommand, {})._tag).toBe("Success");
  });

  it("keeps every key of an open record through a tolerant decode", () => {
    const cache = {
      schemaVersion: 1 as const,
      pi: {
        updatedAt: "2026-11-07T00:00:00.000Z",
        models: [{ platform: "pi" as const, id: "m", label: "M", future: { x: 1 } }],
      },
      future: true,
    };
    const decoded = decodeCommandResult(getAgentModelCatalogCacheCommand, cache);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).toEqual(cache);
    expect(decodeCommandResult(getOpencodeModelCatalogCacheCommand, null)._tag).toBe("Success");
    // Both forms of the native catalogue decode; a present field is still checked.
    expect(decodeCommandResult(getNativeAgentModelCatalogCommand, [])._tag).toBe("Success");
    expect(
      decodeCommandResult(getNativeAgentModelCatalogCommand, { models: [], status: "ready" })._tag,
    ).toBe("Success");
    expect(
      decodeCommandResult(getNativeAgentModelCatalogCommand, [{ platform: "pi", id: 1 }])._tag,
    ).toBe("Failure");
  });

  it("reads the catalogues' vocabularies as the models' literals (plan item 7010)", () => {
    const catalog = (levels: string[], source = "sdk") => ({
      environmentId: "e1",
      models: [{ id: "opus", name: "Opus", supportedEffortLevels: levels }],
      source,
      fetchedAt: "2026-11-07T00:00:00.000Z",
      stale: false,
    });
    expect(decodeCommandResult(getClaudeModelCatalogCommand, catalog(["low", "max"]))._tag).toBe(
      "Success",
    );
    expect(decodeCommandResult(getClaudeModelCatalogCommand, catalog(["turbo"]))._tag).toBe(
      "Failure",
    );
    expect(decodeCommandResult(getClaudeModelCatalogCommand, catalog([], "cache"))._tag).toBe(
      "Failure",
    );
    expect(decodeCommandResult(getAgentModelCatalogCacheCommand, { schemaVersion: 2 })._tag).toBe(
      "Failure",
    );
  });

  it("lists its client in DOMAIN_CLIENTS with adapters 2, 1 and 0", () => {
    expect(DOMAIN_CLIENTS).toContain(agentServersClient);
    expect(agentServersClient.versions).toEqual([2, 1, 0]);
  });
});

function fakeNode(domains: NegotiatedDomains | undefined, answer: (command: string) => unknown) {
  const sent: Array<{ command: string; args: unknown; envelope?: ContractEnvelopeFields }> = [];
  const invoked: Array<{ command: string; args: unknown }> = [];
  const usage: Array<[string, number]> = [];
  const options = {
    call: async (def: AnyCommandDef, args: unknown, envelope?: ContractEnvelopeFields) => {
      sent.push({ command: def.name, args, envelope });
      return answer(def.name);
    },
    invoke: async (command: string, args?: Readonly<Record<string, unknown>>) => {
      invoked.push({ command, args });
      return answer(command);
    },
    domains,
    usage: (domain: string, version: number) => usage.push([domain, version]),
  };
  return { sent, invoked, usage, options };
}

describe("agent-servers client", () => {
  it("version 2: typed calls carry the envelope and its critical keys, results decode", async () => {
    const node = fakeNode({ "agent-servers": { min: 1, max: 2 } }, (command) =>
      command === "get_claude_server_log" ? "tail" : { running: true, hostPort: 4000, extra: 1 },
    );
    const client = createDomainClient(agentServersClient, node.options);
    expect(client.version()).toBe(2);
    const api = client.api();
    await expect(api.get_claude_server_log({ containerId: "c1", previous: true })).resolves.toBe(
      "tail",
    );
    expect(node.sent[0]).toEqual({
      command: "get_claude_server_log",
      args: { containerId: "c1", previous: true },
      envelope: { domain: "agent-servers", version: 2, critical: ["previous"] },
    });
    await expect(api.get_codex_server_status({ containerId: "c1" })).resolves.toEqual<unknown>({
      running: true,
      hostPort: 4000,
      extra: 1,
    });
    expect(node.invoked).toEqual([]);
    expect(node.usage).toEqual([]);
  });

  it("version 1: a result that does not match its schema is refused", async () => {
    const node = fakeNode({ "agent-servers": { min: 1, max: 1 } }, () => ({ running: "yes" }));
    const api = createDomainClient(agentServersClient, node.options).api();
    await expect(api.get_pi_server_status({ containerId: "c1" })).rejects.toThrow(
      "Invalid result from get_pi_server_status",
    );
  });

  it("version 0: today's untyped call, no envelope, the answer as sent, counted", async () => {
    const legacy = { running: "older shape" };
    const node = fakeNode(undefined, () => legacy);
    const client = createDomainClient(agentServersClient, node.options);
    expect(client.version()).toBe(0);
    await expect(client.api().get_pi_server_status({ containerId: "c1" })).resolves.toBe(
      legacy as never,
    );
    expect(node.invoked).toEqual([
      { command: "get_pi_server_status", args: { containerId: "c1" } },
    ]);
    expect(node.sent).toEqual([]);
    expect(node.usage).toEqual([["agent-servers", 0]]);
  });
});
