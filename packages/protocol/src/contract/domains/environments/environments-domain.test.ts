/**
 * The `environments` domain (plan item 7003): every command defined once and
 * classified as routing and the grant deny-lists classify it, arguments
 * decoded tolerantly with the handlers' own error text kept, critical fields
 * pinned, schemas exportable, and the client's two adapters against fakes:
 * version 1 sends the envelope and decodes, version 0 sends today's body and
 * answers as sent.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { isNodeReadCommand } from "../../../command-nodes.js";
import type { NegotiatedDomains } from "../../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { DOMAIN_CLIENTS } from "../../client-adapters.js";
import { decodeCommandArgs, decodeCommandResult } from "../../command.js";
import {
  ClientEnvironmentSchema,
  ENVIRONMENTS_COMMANDS,
  environmentsClient,
  EnvironmentSnapshotRowSchema,
} from "./index.js";

/** The 63 commands `contract-domain-map.ts` listed under `environments` (2026-11-07). */
const ENVIRONMENTS_COMMAND_NAMES = [
  "acknowledge_startup_agent_session",
  "apply_environment_allowed_domains",
  "approve_environment_setup",
  "approve_project_setup_commands",
  "await_environment_setup_session",
  "cancel_container_operation",
  "cleanup_logs",
  "clear_environment_pr",
  "create_environment",
  "delete_environment",
  "discard_recovery_copy",
  "ensure_environment_setup",
  "ensure_project_home_environment",
  "fork_environment",
  "get_claude_terminal_state",
  "get_container_lifecycle_snapshot",
  "get_environment",
  "get_environment_extensions",
  "get_environment_inputs",
  "get_environment_network_policy",
  "get_environment_pr_health",
  "get_environment_pr_url",
  "get_environment_resources",
  "get_environment_setup_approval",
  "get_environment_snapshot",
  "get_environment_snapshots",
  "get_environment_status",
  "get_environments",
  "get_log_directory",
  "get_log_storage_stats",
  "get_rebuild_preview",
  "list_recovery_copies",
  "move_environment",
  "override_environment_setup",
  "prepare_environment_first_prompt",
  "reconcile_orphaned_tab_resources",
  "reconcile_pending_environment_renames",
  "reconcile_tab_teardowns",
  "recreate_environment",
  "remove_environment_domains",
  "rename_environment",
  "rename_environment_from_prompt",
  "reorder_environments",
  "resolve_container_operation",
  "restore_provider_credentials",
  "restore_recovery_copy",
  "revoke_provider_credentials",
  "run_environment_setup",
  "set_container_resource_limits",
  "set_environment_pr",
  "start_environment",
  "start_environment_background",
  "stop_environment",
  "sync_all_environments_with_docker",
  "sync_environment_status",
  "teardown_tab",
  "update_environment_agent_settings",
  "update_environment_allowed_domains",
  "update_environment_resources",
  "update_port_mappings",
];

/** What the old grant deny-lists refused in this domain (plan item 7012). */
const ADMIN = new Set(["cleanup_logs", "set_container_resource_limits"]);
const INTERNAL = new Set(["approve_project_setup_commands"]);

const def = (name: string) => ENVIRONMENTS_COMMANDS.find((command) => command.name === name)!;

const environment = {
  id: "env-1",
  projectId: "project-1",
  name: "feature",
  branch: "feature",
  containerId: null,
  status: "stopped",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-11-07T00:00:00.000Z",
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "containerized",
} as const;

function fakeNode(domains: NegotiatedDomains | null, answers: Record<string, unknown>) {
  const sent: Array<{ command: string; args: unknown; envelope?: ContractEnvelopeFields }> = [];
  return {
    sent,
    options: {
      domains,
      call: async (command: { name: string }, args: unknown, envelope?: ContractEnvelopeFields) => {
        sent.push({ command: command.name, args, ...(envelope ? { envelope } : {}) });
        return answers[command.name];
      },
    },
  };
}

describe("environments commands", () => {
  it("defines every environments command once, since version 1", () => {
    expect(ENVIRONMENTS_COMMANDS.map((command) => command.name as string).sort()).toEqual(
      ENVIRONMENTS_COMMAND_NAMES,
    );
    for (const command of ENVIRONMENTS_COMMANDS) {
      expect(command.domain.name).toBe("environments");
      expect(command.since).toBe(1);
    }
  });

  it("classifies reads as routing does and access as the workspace deny-list does", () => {
    for (const command of ENVIRONMENTS_COMMANDS) {
      expect({ name: command.name, read: command.read }).toEqual({
        name: command.name,
        read: isNodeReadCommand(command.name),
      });
      const access = ADMIN.has(command.name)
        ? "admin"
        : INTERNAL.has(command.name)
          ? "internal"
          : "workspace";
      expect({ name: command.name, access: command.access }).toEqual({
        name: command.name,
        access,
      });
    }
  });

  it("marks the idempotency keys and reviewed-state fences critical", () => {
    const critical = Object.fromEntries(
      ENVIRONMENTS_COMMANDS.filter((command) => command.critical.length > 0).map((command) => [
        command.name,
        [...command.critical].sort(),
      ]),
    );
    expect(critical).toEqual({
      create_environment: [
        "controlRequestFingerprint",
        "controlRequestId",
        "delegationBaseBranch",
        "delegationBaseCommit",
      ],
      discard_recovery_copy: ["expectedRevision", "operationId"],
      recreate_environment: [
        "expectedContainerId",
        "expectedRevision",
        "keepRecoveryCopy",
        "operationId",
      ],
      restore_recovery_copy: ["expectedContainerId", "expectedRevision", "operationId"],
      start_environment: ["expectedRevision", "operationId"],
      start_environment_background: ["expectedRevision", "operationId"],
      stop_environment: ["expectedRevision", "operationId"],
    });
  });

  it("strips unknown keys, keeps lenient values for the handler, and keeps asString's text", () => {
    const decoded = decodeCommandArgs(def("recreate_environment"), {
      environmentId: 7,
      intent: "discard",
      futureFlag: true,
    });
    // The lifecycle parser checks environmentId itself, with its own message.
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") {
      expect(decoded.success).toEqual({ environmentId: 7, intent: "discard" });
    }
    const formerlyStrict = decodeCommandArgs(def("get_rebuild_preview"), {
      environmentId: "env-1",
      extra: true,
    });
    expect(formerlyStrict._tag).toBe("Success");
    if (formerlyStrict._tag === "Success") {
      expect(formerlyStrict.success).toEqual({ environmentId: "env-1" });
    }
    const missing = decodeCommandArgs(def("get_environments"), {});
    expect(missing._tag).toBe("Failure");
    if (missing._tag === "Failure") {
      expect(missing.failure.message).toContain("projectId");
    }
  });

  it("exports every schema as JSON Schema", () => {
    for (const command of ENVIRONMENTS_COMMANDS) {
      expect(() => Schema.toJsonSchemaDocument(command.args)).not.toThrow();
      expect(() => Schema.toJsonSchemaDocument(command.result as never)).not.toThrow();
    }
  });

  it("decodes the records handlers return: explicit undefined, cleared ports, extra fields", () => {
    const record = {
      ...environment,
      buildPipelineId: undefined,
      entryPort: null,
      lifecycleError: null,
      somethingNewer: "dropped",
    };
    const decoded = Schema.decodeUnknownResult(ClientEnvironmentSchema)(record);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).not.toHaveProperty("somethingNewer");
    expect(
      Schema.decodeUnknownResult(ClientEnvironmentSchema)({ ...environment, branch: undefined })
        ._tag,
    ).toBe("Failure");
    const row = Schema.decodeUnknownResult(EnvironmentSnapshotRowSchema)({
      ...environment,
      dockerAvailable: true,
      prMonitorConfirmed: true,
      agentMailUnread: 2,
    });
    expect(row._tag).toBe("Success");
  });

  it("answers get_environment as the record, the final PR, or null", () => {
    const get = def("get_environment");
    expect(decodeCommandResult(get, { ...environment, initialConversationMode: "plan" })._tag).toBe(
      "Success",
    );
    expect(
      decodeCommandResult(get, {
        id: "env-1",
        projectId: "project-1",
        name: "feature",
        prUrl: "https://github.com/o/r/pull/1",
        prState: "merged",
        finalPrState: true,
      })._tag,
    ).toBe("Success");
    expect(decodeCommandResult(get, null)._tag).toBe("Success");
  });

  it("accepts every transport's empty answer for a void command", () => {
    for (const name of ["delete_environment", "stop_environment", "clear_environment_pr"]) {
      expect(decodeCommandResult(def(name), undefined)._tag).toBe("Success");
      expect(decodeCommandResult(def(name), null)._tag).toBe("Success");
    }
  });
});

describe("environments client", () => {
  it("is listed with adapters 2, 1 and 0", () => {
    expect(DOMAIN_CLIENTS).toContain(environmentsClient);
    expect(environmentsClient.versions).toEqual([2, 1, 0]);
  });

  it("sends the envelope with the carried critical keys to a node with the domain", async () => {
    const node = fakeNode(
      { environments: { min: 1, max: 1 } },
      { start_environment: { setupStarted: false, environment } },
    );
    const client = createDomainClient(environmentsClient, node.options);
    expect(client.version()).toBe(1);
    const result = await client.api().startEnvironment({
      environmentId: "env-1",
      operationId: "01890a5d-ac96-774b-bcce-b302099a8057",
    });
    expect(result.environment.id).toBe("env-1");
    expect(node.sent).toEqual([
      {
        command: "start_environment",
        args: { environmentId: "env-1", operationId: "01890a5d-ac96-774b-bcce-b302099a8057" },
        envelope: { domain: "environments", version: 1, critical: ["operationId"] },
      },
    ]);
  });

  it("sends today's body to a pre-contract node and answers as it was sent", async () => {
    const node = fakeNode(null, {});
    const invoked: Array<{ command: string; args: unknown }> = [];
    const client = createDomainClient(environmentsClient, {
      ...node.options,
      invoke: async (command, args) => {
        invoked.push({ command, args });
        return [{ ...environment, extra: "kept" }];
      },
    });
    expect(client.version()).toBe(0);
    const environments = await client.api().getEnvironments({ projectId: "project-1" });
    expect(environments[0]).toHaveProperty("extra", "kept");
    expect(invoked).toEqual([{ command: "get_environments", args: { projectId: "project-1" } }]);
    expect(node.sent).toEqual([]);
  });

  it("refuses an answer that is not an environment from a node with the domain", async () => {
    const node = fakeNode(
      { environments: { min: 1, max: 1 } },
      { create_environment: { id: "env-1" } },
    );
    const client = createDomainClient(environmentsClient, node.options);
    await expect(client.api().createEnvironment({ projectId: "project-1" })).rejects.toThrow(
      "Invalid result from create_environment",
    );
  });
});
