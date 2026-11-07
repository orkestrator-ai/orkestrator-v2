/**
 * The `coordinator` domain's project part (plan item 7009): every command
 * registered from `commands-registry-coordinator.ts` and the registrars it
 * calls is defined once, classifies reads as the routing classifier does,
 * names its access and critical keys as the item's Notes record, keeps model
 * records open, and the domain client sends typed, enveloped calls to a node
 * that advertises the domain while any other node gets today's untyped call.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { isNodeReadCommand } from "../../../command-nodes.js";
import type { NegotiatedDomains } from "../../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { DOMAIN_CLIENTS } from "../../client-adapters.js";
import {
  decodeCommandArgs,
  decodeCommandResult,
  validateCommandResult,
  type AnyCommandDef,
} from "../../command.js";
import { canonicalJsonSchema } from "../../json-schema.js";
import {
  COORDINATOR_COMMANDS,
  COORDINATOR_PROJECT_COMMANDS,
  coordinatorClient,
  coordinatorDomain,
  getProjectCoordinatorCommand,
  sendCoordinatorAgentMailCommand,
  watchCoordinatorPullRequestCommand,
} from "./index.js";
import { CoordinatorSnapshotSchema } from "./schemas-project.js";

/** The 68 commands of the project part. */
const NAMES = [
  "address_coordinator_multi_review_action",
  "adopt_coordinator_workflow",
  "answer_controller_worker_question",
  "answer_project_worker_question",
  "apply_project_root_changes",
  "ask_coordinator_suborks",
  "assert_coordinator_delegation_available",
  "assign_coordinator_conversation_agent",
  "associate_coordinator_workflow",
  "cancel_coordinator_graph_run",
  "clear_coordinator_worker_goal",
  "close_coordinator_conversation",
  "create_coordinator_conversation",
  "create_coordinator_pr",
  "custom_fix_coordinator_multi_review_action",
  "edit_coordinator_worker_tab",
  "ensure_project_coordinator",
  "fetch_project_git",
  "get_coordinator_checkout_turn",
  "get_coordinator_feature_plan",
  "get_coordinator_graph_run",
  "get_coordinator_launch_environment",
  "get_coordinator_worker_goal",
  "get_project_base_branch_tip",
  "get_project_coordinator",
  "get_project_coordinator_view",
  "get_project_git_status",
  "hide_coordinator_work",
  "launch_coordinator_environment",
  "launch_coordinator_feature_plan",
  "launch_coordinator_multi_review_action",
  "launch_coordinator_terminal",
  "list_controller_worker_commands",
  "list_coordinator_activity",
  "list_coordinator_graph_templates",
  "list_coordinator_launch_overrides",
  "list_coordinator_worker_commands",
  "list_project_root_changes",
  "open_coordinator_browser",
  "open_coordinator_delegation",
  "open_coordinator_multi_review",
  "open_coordinator_multi_review_fix",
  "pause_coordinator_worker_goal",
  "pause_project_coordinator",
  "prepare_project_git_branch_switch",
  "request_coordinator_root_changes",
  "request_coordinator_worker_answer",
  "resolve_coordinator_conflicts",
  "restart_controller_build_pipeline_step",
  "restart_coordinator_build_pipeline_step",
  "resume_project_coordinator",
  "retry_coordinator_conversation",
  "run_controller_worker_command",
  "run_coordinator_worker_command",
  "select_coordinator_conversation",
  "send_approved_project_home_message",
  "send_coordinator_agent_mail",
  "set_coordinator_worker_goal",
  "start_coordinator_build_pipeline",
  "start_coordinator_graph_run",
  "start_coordinator_multi_review",
  "stop_controller_worker_turn",
  "stop_coordinator_worker_turn",
  "switch_project_git_branch",
  "sync_project_git",
  "verify_project_launch_base",
  "watch_coordinator_pull_request",
  "write_coordinator_attachment",
];

/**
 * `internal`: what the old grant deny-lists refused (coordinator tool
 * plumbing, `*_controller_*` node-link commands, approval-only steps), and the
 * Control MCP tool steps that trust their caller's scope (plan item 7012).
 */
const INTERNAL = new Set([
  "answer_controller_worker_question",
  "ask_coordinator_suborks",
  "launch_coordinator_environment",
  "open_coordinator_delegation",
  "send_coordinator_agent_mail",
  "start_coordinator_build_pipeline",
  "start_coordinator_graph_run",
  "start_coordinator_multi_review",
  "answer_project_worker_question",
  "apply_project_root_changes",
  "clear_coordinator_worker_goal",
  "create_coordinator_pr",
  "custom_fix_coordinator_multi_review_action",
  "edit_coordinator_worker_tab",
  "get_coordinator_feature_plan",
  "get_coordinator_worker_goal",
  "launch_coordinator_feature_plan",
  "launch_coordinator_terminal",
  "list_controller_worker_commands",
  "list_coordinator_worker_commands",
  "open_coordinator_browser",
  "pause_coordinator_worker_goal",
  "request_coordinator_root_changes",
  "request_coordinator_worker_answer",
  "resolve_coordinator_conflicts",
  "restart_controller_build_pipeline_step",
  "restart_coordinator_build_pipeline_step",
  "run_controller_worker_command",
  "run_coordinator_worker_command",
  "send_approved_project_home_message",
  "set_coordinator_worker_goal",
  "stop_controller_worker_turn",
]);

const CRITICAL: Record<string, readonly string[]> = {
  answer_controller_worker_question: ["revision"],
  answer_project_worker_question: ["revision"],
  launch_coordinator_environment: ["requestId"],
  open_coordinator_delegation: ["requestId"],
  restart_controller_build_pipeline_step: ["requestId", "stepId", "selection"],
  run_controller_worker_command: ["key", "expectedBindingRevision"],
  send_coordinator_agent_mail: ["requestId", "deliverNow", "attachments"],
  start_coordinator_build_pipeline: ["requestId"],
  start_coordinator_graph_run: ["requestId"],
  start_coordinator_multi_review: ["requestId"],
};

describe("coordinator project definitions", () => {
  it("defines each command of the project part once, at version 1, in the domain list", () => {
    const names = COORDINATOR_PROJECT_COMMANDS.map((def) => def.name);
    expect<unknown>([...names].sort()).toEqual(NAMES);
    expect(new Set(names).size).toBe(NAMES.length);
    expect(coordinatorDomain).toMatchObject({ name: "coordinator", version: 1, min: 1 });
    const domainNames = new Set(COORDINATOR_COMMANDS.map((def) => def.name));
    for (const def of COORDINATOR_PROJECT_COMMANDS) {
      expect(def.domain).toBe(coordinatorDomain);
      expect(def.since).toBe(1);
      expect(domainNames.has(def.name)).toBe(true);
    }
  });

  it("classifies reads as the routing classifier does", () => {
    for (const def of COORDINATOR_PROJECT_COMMANDS) {
      expect({ name: def.name, read: def.read }).toEqual({
        name: def.name,
        read: isNodeReadCommand(def.name),
      });
    }
  });

  it("names its access and critical keys", () => {
    for (const def of COORDINATOR_PROJECT_COMMANDS) {
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

  it("exports stable JSON Schemas for every argument and result schema", () => {
    for (const def of COORDINATOR_PROJECT_COMMANDS) {
      for (const schema of [def.args, def.result] as Schema.Top[]) {
        const once = JSON.stringify(canonicalJsonSchema(schema));
        expect(JSON.stringify(canonicalJsonSchema(schema))).toBe(once);
      }
    }
  });

  it("drops unknown argument keys, so the formerly strict handlers are tolerant", () => {
    const decoded = decodeCommandArgs(watchCoordinatorPullRequestCommand, {
      projectId: "p1",
      owner: "acme",
      repo: "app",
      number: 12,
      source: "rendered",
      extra: true,
    });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect("extra" in decoded.success).toBe(false);
  });

  it("keeps every key a coordinator snapshot carries", () => {
    const snapshot = {
      workspace: {
        id: "c1",
        projectId: "p1",
        lifecycleState: "ready",
        conversations: [{ id: "conv", tabId: "tab", newerField: 1 }],
        selectedConversationId: null,
        futureField: "kept",
      },
      projectPath: "/p",
      providerAvailability: {},
      controlMcp: { enabled: true, running: true, error: null },
      workflows: [],
    };
    const decoded = decodeCommandResult(getProjectCoordinatorCommand, snapshot);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect<unknown>(decoded.success).toEqual(snapshot);
    expect(validateCommandResult(getProjectCoordinatorCommand, null)._tag).toBe("Success");
    expect(Schema.decodeUnknownResult(CoordinatorSnapshotSchema)({ workspace: {} })._tag).toBe(
      "Failure",
    );
  });
});

interface Sent {
  command: string;
  args: unknown;
  envelope: ContractEnvelopeFields | undefined;
}

function fakeNode(
  domains: NegotiatedDomains | undefined,
  answer: (command: string) => unknown = () => ({}),
) {
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

const mail = {
  projectId: "p1",
  coordinatorId: "c1",
  conversationId: "conv",
  requestId: "r1",
  toEnvironmentId: "env-1",
  body: "Report back",
  deliverNow: true,
};

describe("coordinator client", () => {
  it("is listed with adapters 1 and 0", () => {
    expect(DOMAIN_CLIENTS).toContain(coordinatorClient);
  });

  it("version 1: typed calls carry the envelope and its critical keys, results decode", async () => {
    const node = fakeNode(COORDINATOR_V1, (command) =>
      command === sendCoordinatorAgentMailCommand.name
        ? { id: "m1", placement: "inbox", extra: "kept" }
        : null,
    );
    const client = createDomainClient(coordinatorClient, node.options);
    expect(client.version()).toBe(1);
    const api = client.api();
    await expect<unknown>(api.send_coordinator_agent_mail(mail)).resolves.toEqual({
      id: "m1",
      placement: "inbox",
      extra: "kept",
    });
    expect(node.sent[0]).toEqual({
      command: "send_coordinator_agent_mail",
      args: mail,
      envelope: { domain: "coordinator", version: 1, critical: ["requestId", "deliverNow"] },
    });
    await expect(api.get_project_coordinator({ projectId: "p1" })).resolves.toBeNull();
    expect(node.invoked).toEqual([]);
    expect(node.usage).toEqual([]);
  });

  it("version 1: a result that does not match its schema is refused", async () => {
    const node = fakeNode(COORDINATOR_V1, () => ({ workspace: 7 }));
    const api = createDomainClient(coordinatorClient, node.options).api();
    await expect(api.get_project_coordinator({ projectId: "p1" })).rejects.toThrow(
      "Invalid result from get_project_coordinator",
    );
  });

  it("version 0: today's untyped call, no envelope, the answer as sent, counted", async () => {
    const legacyAnswer = { workspace: 7, older: true };
    const node = fakeNode(undefined, () => legacyAnswer);
    const client = createDomainClient(coordinatorClient, node.options);
    expect(client.version()).toBe(0);
    await expect<unknown>(client.api().get_project_coordinator({ projectId: "p1" })).resolves.toBe(
      legacyAnswer,
    );
    expect(node.invoked).toEqual([
      { command: "get_project_coordinator", args: { projectId: "p1" } },
    ]);
    expect(node.sent).toEqual([]);
    expect(node.usage).toEqual([["coordinator", 0]]);
  });
});
