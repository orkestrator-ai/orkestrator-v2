/**
 * The `docker` domain (plan item 7003): every command defined, classified as
 * the routing and grant lists classify it, decoding tolerantly; the client
 * sends the envelope to a node with the domain and today's body to one
 * without, and decodes results with the commands' schemas.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { isNodeReadCommand } from "../../../command-nodes.js";
import { initialContainerHostReachability } from "../../../container-host-reachability.js";
import type { NegotiatedDomains } from "../../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { DOMAIN_CLIENTS } from "../../client-adapters.js";
import { decodeCommandArgs, decodeCommandResult } from "../../command.js";
import { DOCKER_COMMANDS, dockerClient } from "./index.js";

/** The 29 commands `contract-domain-map.ts` listed under `docker` (2026-11-07). */
const DOCKER_COMMAND_NAMES = [
  "check_base_image",
  "check_container_host_reachability",
  "check_docker",
  "cleanup_orphaned_containers",
  "close_container_logs",
  "docker_cleanup_execute",
  "docker_cleanup_preview",
  "docker_container_status",
  "docker_remove_container",
  "docker_start_container",
  "docker_stop_container",
  "docker_system_prune",
  "docker_version",
  "get_container_host_port",
  "get_container_host_reachability",
  "get_container_logs",
  "get_container_usage",
  "get_docker_capacity",
  "get_docker_image_status",
  "get_docker_system_stats",
  "get_docker_topology",
  "get_orkestrator_containers",
  "list_docker_containers",
  "open_container_logs",
  "propagate_github_token_to_containers",
  "provision_environment",
  "read_container_logs",
  "reattach_container",
  "stream_container_logs",
];

const WORKSPACE_EXCLUDED = new Set(["docker_cleanup_execute", "docker_cleanup_preview"]);

const operationId = "01890a5d-ac96-774b-bcce-b302099a8057";

function fakeNode(domains: NegotiatedDomains | null, answers: Record<string, unknown>) {
  const sent: Array<{
    command: string;
    args: unknown;
    envelope: ContractEnvelopeFields | undefined;
  }> = [];
  return {
    sent,
    options: {
      domains,
      call: async (def: { name: string }, args: unknown, envelope?: ContractEnvelopeFields) => {
        sent.push({ command: def.name, args, envelope });
        return answers[def.name];
      },
    },
  };
}

describe("docker commands", () => {
  it("defines every docker command once, at version 1", () => {
    expect(DOCKER_COMMANDS.map((def) => def.name as string).sort()).toEqual(DOCKER_COMMAND_NAMES);
    for (const def of DOCKER_COMMANDS) {
      expect(def.domain.name).toBe("docker");
      expect(def.since).toBe(1);
    }
  });

  it("classifies reads as routing does and the cleanup pair as admin", () => {
    for (const def of DOCKER_COMMANDS) {
      expect({ name: def.name, read: def.read }).toEqual({
        name: def.name,
        read: isNodeReadCommand(def.name),
      });
      expect({ name: def.name, access: def.access }).toEqual({
        name: def.name,
        access: WORKSPACE_EXCLUDED.has(def.name) ? "admin" : "workspace",
      });
    }
  });

  it("marks the lifecycle identity and the reviewed selection critical", () => {
    const critical = Object.fromEntries(
      DOCKER_COMMANDS.filter((def) => def.critical.length > 0).map((def) => [
        def.name,
        def.critical,
      ]),
    );
    expect(critical).toEqual({
      provision_environment: ["operationId", "expectedRevision"],
      docker_cleanup_execute: ["selectionToken"],
    });
  });

  it("strips unknown keys and leaves lenient values to the handler", () => {
    const provision = DOCKER_COMMANDS.find((def) => def.name === "provision_environment")!;
    const decoded = decodeCommandArgs(provision, {
      environmentId: "env-1",
      expectedRevision: "not checked here",
      futureFlag: true,
    });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") {
      expect(decoded.success).toEqual({
        environmentId: "env-1",
        expectedRevision: "not checked here",
      });
    }
    const missing = decodeCommandArgs(provision, {});
    expect(missing._tag).toBe("Failure");
  });

  it("exports every schema as JSON Schema", () => {
    for (const def of DOCKER_COMMANDS) {
      expect(() => Schema.toJsonSchemaDocument(def.args)).not.toThrow();
      expect(() => Schema.toJsonSchemaDocument(def.result as never)).not.toThrow();
    }
  });

  it("decodes the real shapes the backend answers", () => {
    const reachability = DOCKER_COMMANDS.find(
      (def) => def.name === "get_container_host_reachability",
    )!;
    expect(decodeCommandResult(reachability, initialContainerHostReachability())._tag).toBe(
      "Success",
    );
    const check = DOCKER_COMMANDS.find((def) => def.name === "check_docker")!;
    expect(decodeCommandResult(check, { available: true, reason: null })._tag).toBe("Success");
    expect(decodeCommandResult(check, { available: false, reason: "timed-out" })._tag).toBe(
      "Success",
    );
    expect(decodeCommandResult(check, { available: false, reason: null })._tag).toBe("Failure");
    // A void command answers whatever the transport turns `undefined` into.
    const close = DOCKER_COMMANDS.find((def) => def.name === "close_container_logs")!;
    expect(decodeCommandResult(close, null)._tag).toBe("Success");
    expect(decodeCommandResult(close, undefined)._tag).toBe("Success");
  });
});

describe("docker client", () => {
  it("is listed with adapters 1 and 0", () => {
    expect(DOMAIN_CLIENTS).toContain(dockerClient);
    expect(dockerClient.versions).toEqual([1, 0]);
  });

  it("sends the envelope to a node with the domain, critical keys included", async () => {
    const node = fakeNode(
      { docker: { min: 1, max: 1 } },
      {
        provision_environment: "container-1",
        get_docker_topology: {
          kind: "local-engine",
          rootless: false,
          osType: "linux",
          architecture: "arm64",
          serverVersion: "27.0.0",
          supportsLocalResources: true,
          remediation: null,
          addedLater: "dropped",
        },
      },
    );
    const client = createDomainClient(dockerClient, node.options);
    expect(client.version()).toBe(1);
    const docker = client.api();
    await expect(
      docker.provisionEnvironment({ environmentId: "env-1", operationId }),
    ).resolves.toBe("container-1");
    const topology = await docker.topology({ refresh: true });
    expect(topology).not.toHaveProperty("addedLater");
    expect(node.sent).toEqual([
      {
        command: "provision_environment",
        args: { environmentId: "env-1", operationId },
        envelope: { domain: "docker", version: 1, critical: ["operationId"] },
      },
      {
        command: "get_docker_topology",
        args: { refresh: true },
        envelope: { domain: "docker", version: 1 },
      },
    ]);
  });

  it("sends today's body to a node without the domain and answers as it was sent", async () => {
    const invoked: Array<{ command: string; args: unknown }> = [];
    const answers: Record<string, unknown> = {
      docker_cleanup_execute: { removed: 1, extra: "kept" },
      check_docker: { available: true },
    };
    const node = fakeNode(null, {});
    const client = createDomainClient(dockerClient, {
      ...node.options,
      invoke: async (command, args) => {
        invoked.push({ command, args });
        return answers[command];
      },
    });
    expect(client.version()).toBe(0);
    const docker = client.api();
    const result = await docker.cleanupExecute({
      selectionToken: "token",
      containerIds: ["c1"],
      volumeNames: [],
    });
    // A pre-contract node's answer is the shape its callers already handle.
    expect(result).toEqual({ removed: 1, extra: "kept" } as never);
    expect(invoked[0]).toEqual({
      command: "docker_cleanup_execute",
      args: { selectionToken: "token", containerIds: ["c1"], volumeNames: [] },
    });
    expect(node.sent).toEqual([]);
  });
});
