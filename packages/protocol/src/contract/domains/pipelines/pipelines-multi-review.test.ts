/**
 * The `pipelines` and `multi-review` domains (plan item 7007): their
 * definitions classify reads as the routing classifier does, results keep
 * every key the backend sends, undeclared argument keys are dropped while a
 * newer vocabulary's start keys survive for the handler to rewrite, and the
 * clients send typed, enveloped calls to a node with the domain while a
 * pre-contract node gets today's untyped calls.
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
import { unknownCommand } from "../../errors.js";
import {
  MULTI_REVIEW_COMMANDS,
  getMultiReviewWorkflowCommand,
  multiReviewClient,
  multiReviewDomain,
  restartMultiReviewStepCommand,
  startMultiReviewCommand,
} from "../multi-review/index.js";
import {
  PIPELINES_COMMANDS,
  createFeatureBuildCommand,
  getBuildPipelineCommand,
  launchBuildPipelineCommand,
  listBuildPipelinesCommand,
  pauseBuildPipelineCommand,
  pipelinesClient,
  pipelinesDomain,
} from "./index.js";

/** Operational commands no client calls: the workflow result rollout. */
const ADMIN = new Set([
  "get_workflow_result_metrics",
  "get_workflow_result_tools_rollout",
  "set_workflow_result_tools_rollout",
]);

/** Driven in-process by the supervisors (`invoke`), never by a client. */
const INTERNAL = new Set([
  "start_review_validation",
  "status_review_validation",
  "cancel_review_validation",
]);

const DOMAINS = [
  { domain: pipelinesDomain, commands: PIPELINES_COMMANDS, count: 41 },
  { domain: multiReviewDomain, commands: MULTI_REVIEW_COMMANDS, count: 30 },
] as const;

describe("pipelines and multi-review definitions", () => {
  it.each(DOMAINS)("defines $domain.name's $count commands once each, at version 1", (entry) => {
    const commands: readonly AnyCommandDef[] = entry.commands;
    const names = commands.map((def) => def.name);
    expect(names).toHaveLength(entry.count);
    expect(new Set(names).size).toBe(entry.count);
    expect(entry.domain).toMatchObject({ version: 1, min: 1 });
    for (const def of commands) {
      expect(def.domain).toBe(entry.domain);
      expect(def.since).toBe(1);
    }
  });

  it("classifies reads with the routing classifier, access as recorded, nothing encoded", () => {
    for (const def of [...PIPELINES_COMMANDS, ...MULTI_REVIEW_COMMANDS] as AnyCommandDef[]) {
      expect({ name: def.name, read: def.read }).toEqual({
        name: def.name,
        read: isNodeReadCommand(def.name),
      });
      expect({ name: def.name, access: def.access }).toEqual({
        name: def.name,
        access: ADMIN.has(def.name) ? "admin" : INTERNAL.has(def.name) ? "internal" : "workspace",
      });
      expect(def.encoded).toBe(false);
    }
  });

  it("exports every schema as JSON Schema", () => {
    for (const def of [...PIPELINES_COMMANDS, ...MULTI_REVIEW_COMMANDS] as AnyCommandDef[]) {
      expect(() => Schema.toJsonSchemaDocument(def.args)).not.toThrow();
      expect(() => Schema.toJsonSchemaDocument(def.result)).not.toThrow();
    }
  });

  it("lists both clients in DOMAIN_CLIENTS", () => {
    expect(DOMAIN_CLIENTS).toContain(pipelinesClient);
    expect(DOMAIN_CLIENTS).toContain(multiReviewClient);
  });

  it("drops unknown argument keys, keeps the text of a missing id, refuses an unknown critical key", () => {
    const decoded = decodeCommandArgs(pauseBuildPipelineCommand, { pipelineId: "p1", extra: 1 });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).toEqual({ pipelineId: "p1" });
    const missing = decodeCommandArgs(pauseBuildPipelineCommand, {});
    expect(missing._tag).toBe("Failure");
    const refused = decodeCommandArgs(
      pauseBuildPipelineCommand,
      { pipelineId: "p1", force: true },
      { critical: ["force"] },
    );
    expect(refused._tag).toBe("Failure");
    if (refused._tag === "Failure") expect(refused.failure._tag).toBe("UnsupportedFieldError");
  });

  it("keeps every start key for the handler's guard, the newer vocabulary's included", () => {
    const start = {
      environmentId: "e1",
      projectId: "p1",
      targetBranch: "main",
      reviewers: [{ agent: "codex", model: "m" }],
      autoAddressFindings: true,
      addressFindingsModel: { agent: "codex", model: "m" },
      unknown: "dropped",
    };
    const decoded = decodeCommandArgs(startMultiReviewCommand, start);
    expect(decoded._tag).toBe("Success");
    const { unknown: _unknown, ...kept } = start;
    if (decoded._tag === "Success") expect(decoded.success).toEqual(kept as never);
    // A guard-checked request keeps an invalid value for the guard's own message.
    const restart = decodeCommandArgs(restartMultiReviewStepCommand, { workflowId: 7, kind: "x" });
    expect(restart._tag).toBe("Success");
  });

  it("marks the idempotency key, the chosen environment and delivery policy, and restart selections critical", () => {
    expect(createFeatureBuildCommand.critical).toEqual(["requestId", "deliveryPolicy"]);
    expect(launchBuildPipelineCommand.critical).toEqual([
      "existingEnvironmentId",
      "deliveryPolicy",
    ]);
    expect(restartMultiReviewStepCommand.critical).toEqual(["model"]);
  });
});

const record = {
  version: 1,
  id: "p1",
  projectId: "proj",
  environmentId: "env",
  snapshot: { id: "p1", phase: "building", sessions: [] },
  updatedAt: "2026-11-07T00:00:00.000Z",
  revision: 4,
  later: "kept",
};

describe("pipelines and multi-review results", () => {
  it("decodes each get_build_pipeline answer and keeps every record key", () => {
    for (const answer of [
      null,
      { unchanged: true, revision: 4 },
      record,
      {
        unchanged: false,
        record,
        messagePatches: [{ sessionKey: "s", startIndex: 0, revision: 2, messages: [{}] }],
      },
    ]) {
      const decoded = decodeCommandResult(getBuildPipelineCommand, answer);
      expect(decoded._tag).toBe("Success");
      if (decoded._tag === "Success") expect(decoded.success).toEqual(answer as never);
    }
    expect(validateCommandResult(getBuildPipelineCommand, { id: 4 })._tag).toBe("Failure");
  });

  it("decodes each list_build_pipelines answer", () => {
    for (const answer of [
      [record],
      { ids: ["p1"], records: [] },
      { status: "unchanged", generation: "g", revision: "r" },
      { status: "changed", generation: "g", revision: "r", snapshot: [record] },
    ]) {
      expect(decodeCommandResult(listBuildPipelinesCommand, answer)._tag).toBe("Success");
    }
  });

  it("decodes a Multi Review record or unchanged", () => {
    const workflow = { ...record, snapshot: { id: "w1" } };
    delete (workflow as Partial<typeof record>).projectId;
    for (const answer of [null, { unchanged: true, revision: 2 }, workflow]) {
      const decoded = decodeCommandResult(getMultiReviewWorkflowCommand, answer);
      expect(decoded._tag).toBe("Success");
      if (decoded._tag === "Success") expect(decoded.success).toEqual(answer as never);
    }
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

const feature = {
  projectId: "p1",
  title: "T",
  environmentType: "local" as const,
  agentType: "codex" as const,
  requestId: "r1",
};

describe("pipelines and multi-review clients", () => {
  it("version 1: typed calls carry the envelope and the critical keys sent, results decode", async () => {
    const created = { taskId: "t1", pipelineId: "p1", later: true };
    const node = fakeNode({ pipelines: { min: 1, max: 1 } }, () => created);
    const client = createDomainClient(pipelinesClient, node.options);
    expect(client.version()).toBe(1);
    await expect(client.api().create_feature_build(feature)).resolves.toEqual(created as never);
    expect(node.sent).toEqual([
      {
        command: "create_feature_build",
        args: feature,
        envelope: { domain: "pipelines", version: 1, critical: ["requestId"] },
      },
    ]);
    expect(node.invoked).toEqual([]);
    expect(node.usage).toEqual([]);
  });

  it("version 1: a result that does not match its schema is refused", async () => {
    const node = fakeNode({ "multi-review": { min: 1, max: 1 } }, () => ({ id: 3 }));
    await expect(
      createDomainClient(multiReviewClient, node.options).api().cancel_multi_review({
        workflowId: "w1",
      }),
    ).rejects.toThrow("Invalid result from cancel_multi_review");
  });

  it("version 0: today's untyped call, no envelope, the answer as sent, counted", async () => {
    const legacy = { id: "w1", older: true, phase: 7 };
    const node = fakeNode(undefined, () => legacy);
    const client = createDomainClient(multiReviewClient, node.options);
    expect(client.version()).toBe(0);
    await expect(client.api().cancel_multi_review({ workflowId: "w1" })).resolves.toBe(
      legacy as never,
    );
    expect(node.invoked).toEqual([{ command: "cancel_multi_review", args: { workflowId: "w1" } }]);
    expect(node.sent).toEqual([]);
    expect(node.usage).toEqual([["multi-review", 0]]);
  });

  it("version 0: an older node's unknown-command passes through for the caller's fallback", async () => {
    const node = fakeNode(undefined, () => {
      throw unknownCommand("launch_build_pipeline");
    });
    await expect(
      createDomainClient(pipelinesClient, node.options).api().launch_build_pipeline({}),
    ).rejects.toMatchObject({ code: "unknown-command" });
  });
});
