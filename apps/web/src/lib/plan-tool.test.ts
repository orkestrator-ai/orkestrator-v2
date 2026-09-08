import { describe, expect, test } from "bun:test";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { normalizeNativeMessages } from "@/lib/chat/native-message-adapters";
import {
  extractPlanMarkdown,
  firstMarkdownHeading,
  getPlanToolLabel,
  isPlanTool,
  nativeMessageHasPlanTool,
} from "./plan-tool";

describe("isPlanTool", () => {
  test("recognizes Cursor createPlan spellings", () => {
    expect(isPlanTool("createPlan")).toBe(true);
    expect(isPlanTool("create_plan")).toBe(true);
    expect(isPlanTool("CreatePlan")).toBe(true);
  });

  test("does not treat ACP plan or other tools as createPlan", () => {
    expect(isPlanTool("plan")).toBe(false);
    expect(isPlanTool("ExitPlanMode")).toBe(false);
    expect(isPlanTool("Read")).toBe(false);
    expect(isPlanTool(undefined)).toBe(false);
    expect(isPlanTool("")).toBe(false);
  });
});

describe("getPlanToolLabel", () => {
  test("uses a descriptive title and falls back to Plan", () => {
    expect(getPlanToolLabel("createPlan", "Split discovery")).toBe("Split discovery");
    expect(getPlanToolLabel("createPlan", "createPlan")).toBe("Plan");
    expect(getPlanToolLabel("createPlan")).toBe("Plan");
  });
});

describe("extractPlanMarkdown", () => {
  test("prefers toolArgs.plan over output", () => {
    expect(extractPlanMarkdown({ plan: "# From args" }, "# From output")).toBe("# From args");
  });

  test("unwraps a legacy JSON dump in toolOutput", () => {
    expect(extractPlanMarkdown(undefined, '{"plan":"# Nested\\n\\nbody"}')).toBe(
      "# Nested\n\nbody",
    );
  });

  test("returns raw markdown output when it is not a plan envelope", () => {
    expect(extractPlanMarkdown(undefined, "# Ready\n\nDo the work.")).toBe(
      "# Ready\n\nDo the work.",
    );
  });

  test("returns empty when nothing is present", () => {
    expect(extractPlanMarkdown()).toBe("");
    expect(extractPlanMarkdown({})).toBe("");
  });
});

describe("firstMarkdownHeading", () => {
  test("reads the first ATX heading", () => {
    expect(firstMarkdownHeading("intro\n## Split discovery\n\nbody")).toBe("Split discovery");
    expect(firstMarkdownHeading("no heading")).toBeUndefined();
  });
});

describe("nativeMessageHasPlanTool", () => {
  test("finds createPlan in nested groups", () => {
    const message: NativeMessage = {
      id: "a",
      role: "assistant",
      content: "",
      createdAt: "2026-09-08T00:00:00.000Z",
      parts: [
        {
          type: "tool-group",
          content: "",
          parts: [
            {
              type: "tool-invocation",
              content: "Plan",
              toolName: "createPlan",
            },
          ],
        },
      ],
    };
    expect(nativeMessageHasPlanTool(message)).toBe(true);
  });

  test("still finds createPlan after transcript grouping", () => {
    const [normalized] = normalizeNativeMessages([
      {
        id: "a",
        role: "assistant",
        content: "",
        createdAt: "2026-09-08T00:00:00.000Z",
        parts: [
          {
            type: "tool-invocation",
            content: "Plan",
            toolName: "createPlan",
            toolOutput: "# Split\n\nDo it.",
          },
        ],
      },
    ]);
    expect(normalized).toBeDefined();
    expect(nativeMessageHasPlanTool(normalized!)).toBe(true);
  });

  test("returns false when the turn has no plan tool", () => {
    const message: NativeMessage = {
      id: "a",
      role: "assistant",
      content: "",
      createdAt: "2026-09-08T00:00:00.000Z",
      parts: [{ type: "tool-invocation", content: "", toolName: "read" }],
    };
    expect(nativeMessageHasPlanTool(message)).toBe(false);
  });
});
