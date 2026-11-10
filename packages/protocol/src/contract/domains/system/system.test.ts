/**
 * The `system` domain (plan item 7009): its definitions classify reads as the
 * routing classifier does and access as recorded, model records keep every
 * key the backend sends, and its client sends typed, enveloped calls to a
 * node with the domain while a pre-contract node gets today's untyped calls.
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
  SYSTEM_COMMANDS,
  createScheduledJobCommand,
  getHostMaintenanceCommand,
  listScheduledJobsCommand,
  requestHostUpdateCommand,
  systemClient,
  systemDomain,
} from "./index.js";

/**
 * `admin`: the machine's own administration, which the old grant deny-lists
 * refused to workspace clients (the machine's administration and the
 * command node's fleet policy), and machine-wide diagnostics no workspace
 * client reads. Every other command is `workspace`.
 */
const ADMIN = new Set([
  "record_domain_adapter_usage",
  "get_self_improvement_status",
  "run_self_improvement",
  "get_fleet_update_policy",
  "set_fleet_update_policy",
  "record_renderer_errors",
  "get_database_stats",
  "plan_diagnostics_bundle",
  "plan_diagnostics_bundle_with_container_logs",
  "read_diagnostics_bundle",
  "request_host_update_check",
  "request_host_update",
  "cancel_host_update",
  "start_host_toolchain_repair",
  "start_host_image_update",
  "set_host_update_channel",
  "set_host_gh_channel",
  "update_worktree_locations",
  // Machine-wide diagnostics without a workspace caller.
  "get_compatibility_path_usage",
  "get_recurring_work_diagnostics",
  "get_progressive_read_metrics",
  "get_artifact_metrics",
  "reconcile_workflow_scheduling",
]);

const CRITICAL: Record<string, readonly string[]> = {
  request_host_update: ["version", "drain"],
  cancel_host_update: ["jobId"],
  file_bug_report: ["via"],
  create_scheduled_job: ["requestId"],
  update_scheduled_job: ["expectedRevision"],
  run_self_improvement: ["dryRun"],
};

describe("system definitions", () => {
  it("defines the domain's 52 commands once each, since version 1", () => {
    const names = SYSTEM_COMMANDS.map((def) => def.name);
    expect(names).toHaveLength(52);
    expect(new Set(names).size).toBe(52);
    expect(systemDomain).toMatchObject({ name: "system", version: 2, min: 1 });
    for (const def of SYSTEM_COMMANDS) {
      expect(def.domain).toBe(systemDomain);
      expect(def.since).toBe(1);
      expect(def.encoded).toBe(false);
    }
  });

  it("classifies reads with the routing classifier, and access and critical keys as recorded", () => {
    for (const def of SYSTEM_COMMANDS) {
      expect({ name: def.name, read: def.read }).toEqual({
        name: def.name,
        read: isNodeReadCommand(def.name),
      });
      expect({ name: def.name, access: def.access }).toEqual({
        name: def.name,
        access: ADMIN.has(def.name) ? "admin" : "workspace",
      });
      expect({ name: def.name, critical: [...def.critical] }).toEqual({
        name: def.name,
        critical: [...(CRITICAL[def.name] ?? [])],
      });
    }
  });

  it("exports every schema as a stable JSON Schema", () => {
    for (const def of SYSTEM_COMMANDS) {
      const args = canonicalJsonSchema(def.args);
      expect(canonicalJsonSchema(def.args)).toEqual(args);
      expect(() => Schema.toJsonSchemaDocument(def.result)).not.toThrow();
    }
  });

  it("drops unknown argument keys and refuses an unknown critical one", () => {
    const decoded = decodeCommandArgs(getHostMaintenanceCommand, { detail: true, future: 1 });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).toEqual({ detail: true });
    const refused = decodeCommandArgs(
      getHostMaintenanceCommand,
      { detail: true, future: 1 },
      { critical: ["future"] },
    );
    expect(refused._tag).toBe("Failure");
    // A declared critical key is understood.
    const understood = decodeCommandArgs(
      requestHostUpdateCommand,
      { drain: "when-idle" },
      { critical: ["drain"] },
    );
    expect(understood._tag).toBe("Success");
  });

  it("keeps every key of a model record and still checks the declared ones", () => {
    const listed = {
      schedules: [
        {
          id: "s1",
          name: "Nightly",
          ownerKey: "operator",
          state: "active",
          nextFireAt: null,
          fireCount: 0,
          revision: 1,
          createdAt: "2026-11-07T00:00:00.000Z",
          updatedAt: "2026-11-07T00:00:00.000Z",
          lastFire: null,
          activeFire: null,
          trigger: { kind: "cron", expression: "0 3 * * *" },
          action: { kind: "action", action: "x", input: {} },
        },
      ],
      scheduler: { firing: false, reason: "another-backend" },
      revision: 5,
    };
    const decoded = decodeCommandResult(listScheduledJobsCommand, listed);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect<unknown>(decoded.success).toEqual(listed);
    const wrong = decodeCommandResult(listScheduledJobsCommand, {
      schedules: [{ ...listed.schedules[0], revision: "1" }],
    });
    expect(wrong._tag).toBe("Failure");
  });

  it("lists its client in DOMAIN_CLIENTS with adapters 2, 1 and 0", () => {
    expect(DOMAIN_CLIENTS).toContain(systemClient);
    expect(systemClient.versions).toEqual([2, 1, 0]);
  });
});

interface Sent {
  command: string;
  args: unknown;
  envelope: ContractEnvelopeFields | undefined;
}

function fakeNode(domains: NegotiatedDomains | undefined, answer: (command: string) => unknown) {
  const sent: Sent[] = [];
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

const SYSTEM_V1 = { system: { min: 1, max: 1 } };
const SYSTEM_CURRENT = { system: { min: 1, max: 2 } };
const created = {
  schedule: {
    id: "s1",
    name: "Nightly",
    ownerKey: "operator",
    state: "active",
    nextFireAt: "2026-11-08T03:00:00.000Z",
    fireCount: 0,
    revision: 1,
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    fires: [],
    extra: "kept",
  },
  replayed: false,
};
const createArgs = { requestId: "r1", cron: "0 3 * * *", action: { kind: "action" } };

describe("system client", () => {
  it("version 2: typed calls carry the envelope and its critical keys, results decode", async () => {
    const node = fakeNode(SYSTEM_CURRENT, () => created);
    const client = createDomainClient(systemClient, node.options);
    expect(client.version()).toBe(2);
    await expect<unknown>(client.api().create_scheduled_job(createArgs)).resolves.toEqual(created);
    expect(node.sent).toEqual([
      {
        command: createScheduledJobCommand.name,
        args: createArgs,
        envelope: { domain: "system", version: 2, critical: ["requestId"] },
      },
    ]);
    expect(node.invoked).toEqual([]);
    expect(node.usage).toEqual([]);
  });

  it("version 1: the same typed calls, counted as the version-1 adapter", async () => {
    const node = fakeNode(SYSTEM_V1, () => created);
    const client = createDomainClient(systemClient, node.options);
    expect(client.version()).toBe(1);
    await expect<unknown>(client.api().create_scheduled_job(createArgs)).resolves.toEqual(created);
    expect(node.sent).toEqual([
      {
        command: createScheduledJobCommand.name,
        args: createArgs,
        envelope: { domain: "system", version: 1, critical: ["requestId"] },
      },
    ]);
    expect(node.usage).toEqual([["system", 1]]);
  });

  it("version 2: a result that does not match its schema is refused", async () => {
    const node = fakeNode(SYSTEM_CURRENT, () => ({ schedule: { id: 1 }, replayed: false }));
    await expect(
      createDomainClient(systemClient, node.options).api().create_scheduled_job(createArgs),
    ).rejects.toThrow("Invalid result from create_scheduled_job");
  });

  it("version 0: today's untyped call, no envelope, the answer as sent, counted", async () => {
    const legacy = { older: true };
    const node = fakeNode(undefined, () => legacy);
    const client = createDomainClient(systemClient, node.options);
    expect(client.version()).toBe(0);
    await expect<unknown>(client.api().create_scheduled_job(createArgs)).resolves.toBe(legacy);
    expect(node.invoked).toEqual([{ command: "create_scheduled_job", args: createArgs }]);
    expect(node.sent).toEqual([]);
    expect(node.usage).toEqual([["system", 0]]);
  });
});
