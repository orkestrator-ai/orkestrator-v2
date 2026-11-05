import { describe, expect, test } from "bun:test";
import { parseChartSpec } from "./chart-spec.js";
import { STATIC_PRESENTATION_POLICY } from "./rich-content-policy.js";
import {
  AGENT_CHART_FENCE_EXAMPLE,
  AGENT_CHART_SPEC_SHAPES,
  AGENT_DOCUMENT_INSTRUCTION,
  AGENT_IMAGE_PREVIEW_INSTRUCTION,
  AGENT_VISUAL_OUTPUT_INSTRUCTION,
  GENERAL_AGENT_INSTRUCTIONS,
  agentSystemInstructions,
} from "./agent-system-instructions.js";

describe("agentSystemInstructions", () => {
  test("is the general block alone without provider lines", () => {
    expect(agentSystemInstructions()).toBe(GENERAL_AGENT_INSTRUCTIONS.join("\n\n"));
    expect(agentSystemInstructions()).toContain(AGENT_IMAGE_PREVIEW_INSTRUCTION);
    expect(agentSystemInstructions()).toContain(AGENT_DOCUMENT_INSTRUCTION);
  });

  test("puts provider lines after the general block and drops blank ones", () => {
    expect(agentSystemInstructions(["first", "  ", "second"])).toBe(
      [...GENERAL_AGENT_INSTRUCTIONS, "first", "second"].join("\n\n"),
    );
  });

  test("tells every provider how to choose a visual", () => {
    expect(GENERAL_AGENT_INSTRUCTIONS).toContain(AGENT_VISUAL_OUTPUT_INSTRUCTION);
    for (const term of [
      "`mermaid`",
      "`chart`",
      "html-static",
      "html-interactive",
      "publish_artifact",
      "photographs",
      "--ork-foreground",
      "because the preview defines none",
    ])
      expect(AGENT_VISUAL_OUTPUT_INSTRUCTION).toContain(term);
  });

  test("makes the artifact tools conditional, because some sessions have none", () => {
    expect(AGENT_VISUAL_OUTPUT_INSTRUCTION).toContain(
      "When this session has the Orkestrator artifact tools",
    );
    expect(AGENT_VISUAL_OUTPUT_INSTRUCTION).toContain("If verification is unavailable");
  });

  test("states the display budget the renderer enforces", () => {
    expect(AGENT_VISUAL_OUTPUT_INSTRUCTION).toContain(
      `${STATIC_PRESENTATION_POLICY.maxDocumentBytes / 1024} KiB`,
    );
    expect(AGENT_VISUAL_OUTPUT_INSTRUCTION).toContain(
      `${STATIC_PRESENTATION_POLICY.maxElements} elements`,
    );
  });

  test("its chart fence example passes the real validator", () => {
    expect(parseChartSpec(AGENT_CHART_FENCE_EXAMPLE).ok).toBe(true);
    expect(AGENT_VISUAL_OUTPUT_INSTRUCTION).toContain(AGENT_CHART_FENCE_EXAMPLE);
  });

  test("states the shape of every chart kind, and each shape as written validates", () => {
    expect(AGENT_VISUAL_OUTPUT_INSTRUCTION).toContain(AGENT_CHART_SPEC_SHAPES);
    const common = { schemaVersion: 1, title: "T", description: "D" };
    const axis = { label: "X" };
    for (const spec of [
      {
        ...common,
        kind: "bar",
        xAxis: { kind: "category", label: "X" },
        yAxis: axis,
        categories: [{ id: "a", label: "A" }],
        series: [{ id: "s", label: "S", points: [{ categoryId: "a", value: 1 }] }],
      },
      ...["line", "area", "scatter"].map((kind) => ({
        ...common,
        kind,
        xAxis: { kind: "number", label: "X" },
        yAxis: axis,
        series: [{ id: "s", label: "S", points: [{ x: 1, y: 2 }] }],
      })),
      { ...common, kind: "donut", valueLabel: "V", slices: [{ id: "a", label: "A", value: 1 }] },
    ])
      expect(parseChartSpec(JSON.stringify(spec)).ok).toBe(true);
  });

  test("keeps image guidance to outputs that are images", () => {
    expect(AGENT_IMAGE_PREVIEW_INSTRUCTION).not.toContain("chart");
  });

  test("states the image preview storage boundary", () => {
    expect(AGENT_IMAGE_PREVIEW_INSTRUCTION).toContain("absolute path");
    expect(AGENT_IMAGE_PREVIEW_INSTRUCTION).toContain("/tmp");
    expect(AGENT_IMAGE_PREVIEW_INSTRUCTION).toContain("Project-home checkouts");
  });
});
