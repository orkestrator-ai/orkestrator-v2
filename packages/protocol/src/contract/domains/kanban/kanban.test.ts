/**
 * The `kanban` domain (plan item 7008): the definitions declare every key the
 * handlers read, classify reads as the routing classifier does, decode
 * tolerantly with the handlers' wording, keep every key of a record a newer
 * backend sends, and the client sends the envelope only to a node with the
 * domain.
 */
import { describe, expect, it } from "bun:test";
import * as Result from "effect/Result";
import { isNodeReadCommand } from "../../../command-nodes.js";
import type { NegotiatedDomains } from "../../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { decodeCommandArgs, decodeCommandResult, type AnyCommandDef } from "../../command.js";
import {
  addKanbanCommentCommand,
  addKanbanTaskCommand,
  getFeaturePlansCommand,
  getKanbanTasksCommand,
  KANBAN_COMMANDS,
  kanbanClient,
  startFeaturePlanningCommand,
  updateKanbanTaskCommand,
} from "./index.js";

/** The keys each handler read before (2026-11-07), strict or lenient. */
const HANDLER_KEYS: Record<string, readonly string[]> = {
  get_kanban_tasks: ["projectId", "knownManifestGeneration", "knownResourceRevision"],
  add_kanban_task: [
    "requestId",
    "kind",
    "markdown",
    "sections",
    "acceptanceCriteria",
    "status",
    "projectId",
    "title",
    "description",
    "labels",
  ],
  update_kanban_task: [
    "taskId",
    "kind",
    "markdown",
    "sections",
    "title",
    "description",
    "acceptanceCriteria",
    "status",
    "environmentId",
    "buildPipelineId",
    "prUrl",
    "prState",
    "prMergeCommented",
    "labels",
    "preserveDoneStatus",
  ],
  record_kanban_criteria_checks: ["taskId", "checks"],
  close_kanban_task_for_merged_pr: ["taskId", "prUrl"],
  get_kanban_labels: ["projectId"],
  create_kanban_label: ["projectId", "name", "color", "description"],
  set_kanban_task_label: ["taskId", "name", "present", "projectId"],
  delete_kanban_task: ["taskId"],
  add_kanban_comment: ["requestId", "taskId", "text", "projectId"],
  delete_kanban_comment: ["taskId", "commentId"],
  add_kanban_image: ["taskId", "filename", "data"],
  delete_kanban_image: ["taskId", "imageId"],
  get_kanban_image_data: ["imageId"],
  get_project_notes: ["projectId", "knownManifestGeneration", "knownResourceRevision"],
  save_project_notes: ["projectId", "content"],
  get_feature_plans: ["projectId", "knownManifestGeneration", "knownResourceRevision"],
  create_feature_plan: ["projectId"],
  update_feature_plan: ["featureId", "updates"],
  claim_feature_plan_build: ["featureId", "taskId"],
  append_feature_plan_message: ["featureId", "role", "content", "stateApplication", "modelId"],
  append_feature_story_message: [
    "featureId",
    "storyId",
    "role",
    "content",
    "stateApplication",
    "modelId",
  ],
  start_feature_planning: ["operationId", "featureId", "kind", "storyId", "userMessage"],
  retry_feature_planning: ["featureId"],
  cancel_feature_planning: ["featureId"],
  get_linear_connection: [],
  connect_linear: ["apiKey"],
  disconnect_linear: [],
  get_linear_issues: ["projectId"],
  get_linear_issue: ["issueId", "projectId"],
  post_linear_issue_comment: ["issueId", "body", "projectId"],
  post_linear_completion_comment: ["pipelineId", "issueId", "body"],
  // Linear boards (domain version 2).
  get_linear_teams: [],
  get_linear_board_link: ["projectId"],
  set_linear_board_link: ["projectId", "teamId", "linearProjectId"],
  clear_linear_board_link: ["projectId"],
  get_linear_board_options: ["projectId"],
  create_linear_issue: [
    "projectId",
    "requestKey",
    "title",
    "description",
    "priority",
    "stateId",
    "assigneeId",
    "labelIds",
    "estimate",
  ],
  update_linear_issue: [
    "projectId",
    "issueId",
    "title",
    "description",
    "priority",
    "stateId",
    "assigneeId",
    "addedLabelIds",
    "removedLabelIds",
    "estimate",
  ],
  get_linear_node_connections: [],
  copy_linear_connection_from_node: ["nodeId"],
};

/** The Linear board commands, new in domain version 2. */
const SINCE_2 = new Set([
  "get_linear_teams",
  "get_linear_board_link",
  "set_linear_board_link",
  "clear_linear_board_link",
  "get_linear_board_options",
  "create_linear_issue",
  "update_linear_issue",
  "get_linear_node_connections",
  "copy_linear_connection_from_node",
]);

const ALL: readonly AnyCommandDef[] = KANBAN_COMMANDS;

const task = {
  id: "t-1",
  projectId: "p-1",
  title: "Ticket",
  description: "",
  acceptanceCriteria: "",
  status: "backlog",
  comments: [{ id: "c-1", text: "hi", createdAt: "2026-11-07T00:00:00Z" }],
  images: [],
  createdAt: "2026-11-07T00:00:00Z",
  order: 0,
  sync: { seq: 3, revs: { title: 3 } },
  newerField: { kept: true },
};

function argsError(def: AnyCommandDef, raw: unknown): string {
  const decoded = decodeCommandArgs(def, raw);
  if (Result.isSuccess(decoded)) throw new Error("expected a failure");
  return decoded.failure.message;
}

describe("kanban definitions", () => {
  it("cover the 41 commands once, the Linear board ones since version 2", () => {
    expect(ALL).toHaveLength(41);
    expect(new Set(ALL.map((def) => def.name)).size).toBe(41);
    expect(ALL.map((def) => def.name).sort()).toEqual(Object.keys(HANDLER_KEYS).sort());
    for (const def of ALL) {
      expect({ name: def.name, since: def.since, domain: def.domain.name }).toEqual({
        name: def.name,
        since: SINCE_2.has(def.name) ? 2 : 1,
        domain: "kanban",
      });
    }
  });

  it("declare exactly the keys each handler reads", () => {
    for (const def of ALL) {
      expect({ name: def.name, keys: Object.keys(def.args.fields).sort() }).toEqual({
        name: def.name,
        keys: [...HANDLER_KEYS[def.name]!].sort(),
      });
    }
  });

  it("classify reads as the routing classifier does, workspace access but the in-process merge closure", () => {
    for (const def of ALL) {
      expect({ name: def.name, read: def.read }).toEqual({
        name: def.name,
        read: isNodeReadCommand(def.name),
      });
      expect({ name: def.name, access: def.access }).toEqual({
        name: def.name,
        // The build pipeline's terminal lifecycle calls it in process only, and
        // copying another machine's Linear key is a machine credential write.
        access:
          def.name === "close_kanban_task_for_merged_pr"
            ? "internal"
            : def.name === "copy_linear_connection_from_node"
              ? "admin"
              : "workspace",
      });
    }
  });

  it("name the critical keys", () => {
    const critical = Object.fromEntries(
      ALL.filter((def) => def.critical.length).map((def) => [def.name, [...def.critical]]),
    );
    expect(critical).toEqual({
      add_kanban_task: ["requestId", "markdown", "sections", "labels"],
      update_kanban_task: ["markdown", "sections", "labels", "preserveDoneStatus"],
      set_kanban_task_label: ["projectId"],
      add_kanban_comment: ["requestId", "projectId"],
      start_feature_planning: ["operationId"],
      create_linear_issue: ["requestKey"],
    });
  });

  // The registry words these as the handlers did ("Expected projectId to be a
  // string"); commands-registry-kanban.test.ts pins that text.
  it("drop unknown keys and refuse a required key of the wrong type", () => {
    const decoded = decodeCommandArgs(addKanbanCommentCommand, {
      taskId: "t-1",
      text: "hello",
      newerOption: true,
    });
    expect(Result.isSuccess(decoded) && decoded.success).toEqual({ taskId: "t-1", text: "hello" });
    expect(argsError(getKanbanTasksCommand, {})).toContain('["projectId"]');
    expect(argsError(updateKanbanTaskCommand, { taskId: 1 })).toContain('["taskId"]');
  });

  it("refuse nothing a lenient handler accepted", () => {
    // A non-string title on an update was ignored, never refused.
    expect(
      Result.isSuccess(
        decodeCommandArgs(updateKanbanTaskCommand, { taskId: "t-1", title: 7, status: null }),
      ),
    ).toBe(true);
    // In-process callers pass absent options as `undefined`.
    expect(
      Result.isSuccess(
        decodeCommandArgs(addKanbanTaskCommand, {
          projectId: "p-1",
          title: "T",
          description: undefined,
          requestId: undefined,
          markdown: "Summary",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        decodeCommandArgs(startFeaturePlanningCommand, {
          featureId: "f-1",
          kind: "feature",
          userMessage: "Plan it",
        }),
      ),
    ).toBe(true);
  });

  it("decode tickets and plans as records, keeping fields they do not declare", () => {
    const tickets = decodeCommandResult(getKanbanTasksCommand, [task]);
    expect(Result.isSuccess(tickets) && tickets.success).toEqual([task]);
    const changed = decodeCommandResult(getKanbanTasksCommand, {
      status: "changed",
      generation: "g-1",
      revision: "r-2",
      snapshot: [task],
    });
    expect(Result.isSuccess(changed)).toBe(true);
    const unchanged = decodeCommandResult(getFeaturePlansCommand, {
      status: "unchanged",
      generation: "g-1",
      revision: "r-2",
    });
    expect(Result.isSuccess(unchanged)).toBe(true);
    // A ticket without its identity is refused.
    const { id: _id, ...anonymous } = task;
    expect(Result.isFailure(decodeCommandResult(addKanbanTaskCommand, anonymous))).toBe(true);
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
    command === "get_kanban_tasks" ? [task] : command === "delete_kanban_task" ? null : task;
  const client = createDomainClient(kanbanClient, {
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

describe("kanban client", () => {
  it("version 1 sends the envelope with the critical keys it carries and decodes", async () => {
    const { client, calls, invoked } = fakeTransport({ kanban: { min: 1, max: 1 } });
    expect(client.version()).toBe(1);
    const created = await client.api().add_kanban_task({
      projectId: "p-1",
      title: "Ticket",
      description: "",
      requestId: "req-1",
    });
    expect(created.id).toBe("t-1");
    expect(calls).toEqual([
      {
        command: "add_kanban_task",
        args: { projectId: "p-1", title: "Ticket", description: "", requestId: "req-1" },
        envelope: { domain: "kanban", version: 1, critical: ["requestId"] },
      },
    ]);
    expect(invoked).toEqual([]);
  });

  it("version 0 is today's call by name, without an envelope, answered as sent", async () => {
    const { client, calls, invoked } = fakeTransport(null);
    expect(client.version()).toBe(0);
    const tickets = await client.api().get_kanban_tasks({ projectId: "p-1" });
    expect(tickets).toEqual([task]);
    await client.api().delete_kanban_task({ taskId: "t-1" });
    expect(calls).toEqual([]);
    expect(invoked).toEqual([
      { command: "get_kanban_tasks", args: { projectId: "p-1" } },
      { command: "delete_kanban_task", args: { taskId: "t-1" } },
    ]);
  });

  it("a node advertising another domain only is version 0", () => {
    const { client } = fakeTransport({ "node-mail": { min: 1, max: 1 } });
    expect(client.version()).toBe(0);
  });
});
