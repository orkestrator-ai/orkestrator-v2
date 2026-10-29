import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_RESULT_KINDS,
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultToolName,
} from "@orkestrator/protocol/workflow-results";
import { validateWorkflowResult, workflowResultJsonSchema } from "./workflow-result-contracts.js";
import {
  WorkflowResultRegistry,
  registerWorkflowResultKind,
  registeredWorkflowResultKinds,
  workflowResultKindDefinition,
  workflowResultProviderSchema,
  workflowResultSlotTools,
  type WorkflowResultAcceptanceCheck,
} from "./workflow-result-registry.js";

describe("workflow result kind registry", () => {
  test("every protocol kind registers itself, in protocol order", () => {
    expect(registeredWorkflowResultKinds()).toEqual([...WORKFLOW_RESULT_KINDS]);
  });

  test("a kind registers once", () => {
    expect(() => registerWorkflowResultKind(workflowResultKindDefinition("pr-result"))).toThrow(
      "already registered",
    );
  });

  test("built-in kinds keep their schema, tools and labels; a slot schema does not override them", () => {
    const foreign = { type: "object", properties: { other: { type: "string" } } };
    for (const kind of WORKFLOW_RESULT_KINDS.filter((entry) => entry !== "graph-output")) {
      const definition = workflowResultKindDefinition(kind);
      expect(workflowResultJsonSchema(kind)).toBe(definition.schema({}));
      expect(workflowResultJsonSchema(kind, foreign)).toBe(definition.schema({}));
      expect(workflowResultProviderSchema(kind, { schema: foreign })).toBe(definition.schema({}));
      expect(workflowResultSlotTools(kind)).toEqual({
        submit: workflowResultToolName(kind),
        validate: WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
      });
      expect(definition.label({})).toBe(kind.replaceAll("-", " "));
    }
  });

  test("graph-output takes its schema and tools from the slot", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["ids"],
      properties: {
        ids: { type: "array", items: { type: "string" }, "x-orkestrator-sources": true },
      },
    };
    expect(workflowResultJsonSchema("graph-output")).toEqual({ type: "object" });
    expect(workflowResultJsonSchema("graph-output", schema)).toBe(schema);
    expect(workflowResultProviderSchema("graph-output", { schema })).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["ids"],
      properties: { ids: { type: "array", items: { type: "string" } } },
    });
    expect(workflowResultSlotTools("graph-output")).toEqual({
      submit: "submit_graph_output",
      validate: WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
    });
    expect(workflowResultSlotTools("graph-output", { toolName: "submit_brief" })).toEqual({
      submit: "submit_brief",
      validate: "validate_brief",
    });
  });

  test("an unregistered kind keeps the pre-registry fallback: the slot schema and nothing else", () => {
    const kind = "not-a-kind" as never;
    expect(workflowResultJsonSchema(kind)).toEqual({});
    expect(
      validateWorkflowResult(kind, { a: 1 }, { type: "object", additionalProperties: false }),
    ).toEqual([{ path: "$.a", code: "unknown_field", message: "Field is not allowed" }]);
    expect(validateWorkflowResult(kind, { a: "probe" })).toEqual([]);
  });
});

describe("registry instances", () => {
  const attempt = {
    resultKey: "key-1",
    kind: "review-report" as const,
    environmentId: "env-1",
    projectId: "project-1",
  };

  test("acceptance checks belong to one instance and list per kind in registration order", async () => {
    const first = new WorkflowResultRegistry();
    const second = new WorkflowResultRegistry();
    const calls: string[] = [];
    const check =
      (name: string): WorkflowResultAcceptanceCheck =>
      async () => {
        calls.push(name);
        return null;
      };
    const removeA = first.addAcceptanceCheck("review-report", check("a"));
    first.addAcceptanceCheck("review-report", check("b"));
    expect(first.entry("review-report").acceptanceChecks).toHaveLength(2);
    expect(first.entry("fix-result").acceptanceChecks).toHaveLength(0);
    expect(second.entry("review-report").acceptanceChecks).toHaveLength(0);
    expect(second.hasAcceptanceChecks()).toBe(false);
    for (const registered of first.checksFor("review-report")) await registered(attempt);
    expect(calls).toEqual(["a", "b"]);
    removeA();
    removeA();
    expect(first.entry("review-report").acceptanceChecks).toHaveLength(1);
  });

  test("an entry is the static definition plus the instance's checks", () => {
    const registry = new WorkflowResultRegistry();
    const entry = registry.entry("verification-result");
    expect(entry.kind).toBe("verification-result");
    expect(entry.toolName({})).toBe("submit_verification_result");
    expect(entry.acceptanceChecks).toEqual([]);
  });

  test("the environment hook is installed per instance and removed only by its own installer", () => {
    const registry = new WorkflowResultRegistry();
    const first = async () => [];
    const second = async () => [];
    const removeFirst = registry.setEnvironmentValidator(first);
    expect(registry.environmentHook()).toBe(first);
    const removeSecond = registry.setEnvironmentValidator(second);
    removeFirst();
    expect(registry.environmentHook()).toBe(second);
    removeSecond();
    expect(registry.environmentHook()).toBeNull();
    expect(new WorkflowResultRegistry().environmentHook()).toBeNull();
  });
});
