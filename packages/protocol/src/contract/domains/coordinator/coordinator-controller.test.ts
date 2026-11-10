/**
 * The controller part of the `coordinator` domain (plan item 7009): its 36
 * definitions classify reads as the routing classifier does, declare the
 * access and critical keys recorded in the item, keep model records open,
 * and the domain client sends typed, enveloped calls to a node with the
 * domain while a pre-contract node gets today's untyped calls.
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
  COORDINATOR_COMMANDS,
  COORDINATOR_CONTROLLER_COMMANDS,
  coordinatorClient,
  coordinatorDomain,
  getControlMcpSettingsCommand,
  launchControlJobCommand,
  launchMultiReviewCommand,
  launchNativeAgentJobCommand,
  sendCoordinatorNodeMailCommand,
} from "./index.js";

/** The node's own secrets: Settings → MCP. */
const ADMIN = new Set([
  "get_control_mcp_settings",
  "rotate_control_mcp_token",
  "create_control_mcp_credential",
  "rotate_control_mcp_credential",
  "revoke_control_mcp_credential",
]);

/**
 * Not workspace-excluded today: jobs, the renderer's Multi Review button and
 * the launch defaults its configure dialog reads, one coordinator read.
 */
const WORKSPACE = new Set([
  "launch_control_job",
  "launch_native_agent_job",
  "launch_multi_review",
  "get_multi_review_launch_defaults",
]);

const CRITICAL: Record<string, readonly string[]> = {
  create_control_mcp_credential: ["capabilities", "deniedActions"],
  launch_control_job: ["requestId", "attachments", "literal", "conversationMode"],
  launch_native_agent_job: [
    "requestId",
    "attachments",
    "literal",
    "conversationMode",
    "completionAction",
    "autoMergePrUrl",
    "tabReuse",
  ],
  launch_controller_terminal: ["key"],
  open_controller_browser: ["key"],
  create_controller_pr: ["requestId", "targetBranch"],
  resolve_controller_conflicts: ["requestId", "targetBranch"],
  create_controller_environment: ["controlRequestId", "presentation"],
  start_controller_build_pipeline: ["coordinatorLaunchId"],
  launch_controller_multi_review: ["reservedId"],
  launch_multi_review: ["reservedId"],
  controller_multi_review_surface: ["fixModel"],
  start_controller_multi_review: ["reservedId", "buildPipelineId"],
  fork_controller_environment: ["controlRequestId", "delegation"],
  launch_coordinator_node_environment: ["requestId"],
  open_coordinator_node_delegation: ["requestId"],
  send_coordinator_node_mail: ["requestId", "attachments", "deliverNow", "replyToMessageId"],
  start_coordinator_node_build_pipeline: ["requestId"],
  coordinator_node_multi_review_surface: ["requestId", "fixModel"],
  start_coordinator_node_multi_review: ["requestId", "buildPipelineId"],
};

describe("coordinator controller definitions", () => {
  it("defines 36 commands once each, at version 1, all in the domain's list", () => {
    const names = COORDINATOR_CONTROLLER_COMMANDS.map((def) => def.name);
    expect(names).toHaveLength(36);
    expect(new Set(names).size).toBe(36);
    expect(coordinatorDomain).toMatchObject({ name: "coordinator", version: 1, min: 1 });
    for (const def of COORDINATOR_CONTROLLER_COMMANDS) {
      expect(def.domain).toBe(coordinatorDomain);
      expect(def.since).toBe(1);
      expect(COORDINATOR_COMMANDS).toContain(def);
    }
  });

  it("classifies reads with the routing classifier, access and critical keys as recorded", () => {
    for (const def of COORDINATOR_CONTROLLER_COMMANDS) {
      expect({ name: def.name, read: def.read }).toEqual({
        name: def.name,
        read: isNodeReadCommand(def.name),
      });
      const access = ADMIN.has(def.name)
        ? "admin"
        : WORKSPACE.has(def.name)
          ? "workspace"
          : "internal";
      expect({ name: def.name, access: def.access }).toEqual({ name: def.name, access });
      expect({ name: def.name, critical: [...def.critical].sort() }).toEqual({
        name: def.name,
        critical: [...(CRITICAL[def.name] ?? [])].sort(),
      });
    }
  });

  it("exports every schema as stable JSON Schema", () => {
    for (const def of COORDINATOR_CONTROLLER_COMMANDS) {
      const args = canonicalJsonSchema(def.args);
      expect(canonicalJsonSchema(def.args)).toEqual(args);
      expect(() => Schema.toJsonSchemaDocument(def.result)).not.toThrow();
    }
  });

  it("keeps every argument value as sent, drops unknown keys, refuses an unknown critical one", () => {
    const args = { environmentId: " env-1 ", requestId: 7, prompt: "", future: true };
    const decoded = decodeCommandArgs(launchControlJobCommand, args);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") {
      // The handler checks every key itself, with its own text.
      expect(decoded.success).toEqual({ environmentId: " env-1 ", requestId: 7, prompt: "" });
    }
    expect(decodeCommandArgs(launchControlJobCommand, args, { critical: ["future"] })._tag).toBe(
      "Failure",
    );
  });

  it("keeps every key of an open record and type-checks the listed ones", () => {
    const settings = {
      enabled: true,
      running: true,
      url: "http://127.0.0.1:1/mcp",
      token: "t",
      error: null,
      credentials: [
        {
          id: "default",
          label: "Default",
          profile: "operator",
          capabilities: [],
          deniedActions: [],
          token: "t",
          createdAt: "2026-11-07T00:00:00.000Z",
          lastUsedAt: null,
          later: 1,
        },
      ],
      newer: "kept",
    };
    const decoded = decodeCommandResult(getControlMcpSettingsCommand, settings);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).toEqual(settings);
    expect(
      decodeCommandResult(getControlMcpSettingsCommand, { ...settings, running: "y" })._tag,
    ).toBe("Failure");
    const job = { status: "accepted", jobId: "j", tabId: "t", reused: true, queued: false };
    const launched = decodeCommandResult(launchNativeAgentJobCommand, job);
    expect(launched._tag === "Success" && launched.success).toEqual(job);
  });

  it("lists the domain client in DOMAIN_CLIENTS with adapters 1 and 0", () => {
    expect(DOMAIN_CLIENTS).toContain(coordinatorClient);
    expect(coordinatorClient.versions).toEqual([1, 0]);
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

const COORDINATOR_V1 = { coordinator: { min: 1, max: 1 } };
const review = {
  workflow: { id: "w1", environmentId: "env-1", phase: "reviewing", extra: true },
  outcome: "opened",
  reused: false,
  ui: { status: "opened", tabId: "t1" },
};

describe("coordinator client, controller commands", () => {
  it("version 1: typed calls carry the envelope and the critical keys they send", async () => {
    const node = fakeNode(COORDINATOR_V1, () => review);
    const client = createDomainClient(coordinatorClient, node.options);
    expect(client.version()).toBe(1);
    const args = { input: { environmentId: "env-1", requestId: "r1" }, reservedId: "r1" };
    await expect(client.api().launch_multi_review(args)).resolves.toEqual(review);
    expect(node.sent).toEqual([
      {
        command: launchMultiReviewCommand.name,
        args,
        envelope: { domain: "coordinator", version: 1, critical: ["reservedId"] },
      },
    ]);
    expect(node.invoked).toEqual([]);
    expect(node.usage).toEqual([]);
  });

  it("version 1: a result that does not match its schema is refused", async () => {
    const node = fakeNode(COORDINATOR_V1, () => ({ nodeId: 7 }));
    await expect(
      createDomainClient(coordinatorClient, node.options)
        .api()
        .send_coordinator_node_mail({ body: "hi" }),
    ).rejects.toThrow(`Invalid result from ${sendCoordinatorNodeMailCommand.name}`);
  });

  it("version 0: today's untyped call, no envelope, the answer as sent, counted", async () => {
    const legacy = { outcome: 7, older: true };
    const node = fakeNode(undefined, () => legacy);
    const client = createDomainClient(coordinatorClient, node.options);
    expect(client.version()).toBe(0);
    const answer: unknown = await client.api().get_control_mcp_settings(undefined as never);
    expect(answer).toBe(legacy);
    expect(node.invoked).toEqual([{ command: "get_control_mcp_settings", args: undefined }]);
    expect(node.sent).toEqual([]);
    expect(node.usage).toEqual([["coordinator", 0]]);
  });
});
