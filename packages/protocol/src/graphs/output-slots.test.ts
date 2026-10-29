import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_RESULT_KINDS,
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultInstruction,
  workflowResultToolName,
} from "../workflow-results";
import {
  GRAPH_OUTPUT_RESERVED_PORTS,
  graphOutputContextProblem,
  graphOutputPortProblem,
  graphOutputToolNames,
  graphOutputToolPort,
  graphOutputValidationToolName,
  type WorkflowGraphOutputContext,
} from "./output-slots";

const context = (
  overrides: Partial<WorkflowGraphOutputContext> = {},
): WorkflowGraphOutputContext => ({
  type: "graph-output",
  port: "brief",
  description: "The chosen design brief.",
  artifactType: "design-brief@1",
  storage: "value",
  budgets: { maxBytes: 16_384 },
  ...overrides,
});

describe("graph output tool names", () => {
  test("each port gets submit_<port> and validate_<port>", () => {
    expect(graphOutputToolNames("design_brief")).toEqual({
      submit: "submit_design_brief",
      validate: "validate_design_brief",
    });
    expect(graphOutputToolPort("submit_design_brief")).toBe("design_brief");
    expect(graphOutputValidationToolName("submit_brief")).toBe("validate_brief");
    expect(() => graphOutputValidationToolName("validate_brief")).toThrow();
  });

  test("port names follow the key grammar and fit every provider's tool-name limit", () => {
    const longest = `p${"a".repeat(47)}`;
    expect(graphOutputPortProblem(longest)).toBeNull();
    expect(graphOutputToolNames(longest).validate.length).toBeLessThanOrEqual(64);
    expect(graphOutputPortProblem(`${longest}a`)).toBe("too_long");
    for (const bad of ["", "Brief", "1brief", "design-brief", "a b", 7]) {
      expect(graphOutputPortProblem(bad)).toBe("pattern");
    }
    expect(graphOutputToolPort("submit_Brief")).toBeNull();
    expect(graphOutputToolPort("report_finding")).toBeNull();
  });

  test("a port can never shadow a built-in result tool", () => {
    for (const kind of WORKFLOW_RESULT_KINDS) {
      const port = workflowResultToolName(kind).slice("submit_".length);
      expect(GRAPH_OUTPUT_RESERVED_PORTS).toContain(port);
      expect(graphOutputPortProblem(port)).toBe("reserved");
      expect(graphOutputToolPort(workflowResultToolName(kind))).toBeNull();
    }
    expect(graphOutputPortProblem("workflow_result")).toBe("reserved");
    expect(graphOutputToolNames("workflow_result").validate).toBe(
      WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
    );
  });

  test("the result instruction names a port's own tools", () => {
    const text = workflowResultInstruction("graph-output", "key-1", {
      tools: graphOutputToolNames("brief"),
    });
    expect(text).toContain("`validate_brief`");
    expect(text).toContain("`submit_brief`");
    expect(text).not.toContain(WORKFLOW_RESULT_VALIDATION_TOOL_NAME);
    expect(text).not.toContain("submit_graph_output");
  });
});

describe("graph output slot context", () => {
  test("a well-formed context passes", () => {
    expect(graphOutputContextProblem(context())).toBeNull();
    expect(
      graphOutputContextProblem(
        context({
          artifactType: "decision@1",
          storage: undefined,
          budgets: undefined,
          choices: ["a", "b"],
          provenance: {
            mode: "cite",
            fields: [{ segments: ["options", "[]", "sources"] }],
            sources: { "brief-1/option-1": "option@1" },
          },
        }),
      ),
    ).toBeNull();
  });

  test.each([
    ["an unknown field", { extra: true }, "unknown field"],
    ["a bad port", { port: "Brief" }, "port"],
    ["a reserved port", { port: "review_report" }, "reserved"],
    ["a list type", { artifactType: "list<finding@1>" }, "list"],
    ["a bad type ref", { artifactType: "brief" }, "type reference"],
    ["a long description", { description: "x".repeat(3_000) }, "description"],
    ["bad budgets", { budgets: { maxBytes: 0 } }, "maxBytes"],
    ["bad storage", { storage: "disk" }, "storage"],
    ["bad choices", { choices: [""] }, "choices"],
    ["bad sources", { provenance: { mode: "cite", fields: [], sources: { a: 1 } } }, "source"],
    [
      "extra provenance fields",
      { provenance: { mode: "cite", fields: [], sources: {}, x: 1 } },
      "provenance",
    ],
  ] as const)("%s is refused", (_label, overrides, message) => {
    expect(graphOutputContextProblem({ ...context(), ...overrides })).toContain(message);
  });
});
