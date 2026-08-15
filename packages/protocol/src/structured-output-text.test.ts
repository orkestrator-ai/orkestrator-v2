import { describe, expect, test } from "bun:test";
import {
  STRUCTURED_OUTPUT_RECOVERY_CANDIDATES,
  tryParseStructuredOutputText,
} from "./structured-output-text";

describe("tryParseStructuredOutputText", () => {
  test("accepts a bare JSON value including primitives", () => {
    expect(tryParseStructuredOutputText('{"complete":true}')).toEqual({ complete: true });
    expect(tryParseStructuredOutputText("[1, 2]")).toEqual([1, 2]);
    expect(tryParseStructuredOutputText("true")).toBe(true);
    expect(tryParseStructuredOutputText("42")).toBe(42);
    expect(tryParseStructuredOutputText("null")).toBeNull();
    expect(tryParseStructuredOutputText("  \uFEFF{\"ok\":true}  ")).toEqual({ ok: true });
  });

  test("unwraps one outer Markdown fence", () => {
    expect(tryParseStructuredOutputText('```json\n{"complete":false}\n```'))
      .toEqual({ complete: false });
    expect(tryParseStructuredOutputText('```json\n{"complete":true}```'))
      .toEqual({ complete: true });
    expect(tryParseStructuredOutputText('```\n{\n  "complete": false\n}\n```'))
      .toEqual({ complete: false });
  });

  test("recovers the last well-formed document after thinking or commentary", () => {
    expect(tryParseStructuredOutputText(
      "The malformed JSON likely stems from the reasoning channel.\n{\"ready\":\"yes\"}",
    )).toEqual({ ready: "yes" });

    expect(tryParseStructuredOutputText('{"complete":true}\n\nAll checks passed.'))
      .toEqual({ complete: true });

    expect(tryParseStructuredOutputText('The result is {"complete":false}'))
      .toEqual({ complete: false });

    expect(tryParseStructuredOutputText('Example {"nope":1}. Answer {"complete":true}.'))
      .toEqual({ complete: true });
  });

  test("does not let nested values replace their outer document", () => {
    expect(tryParseStructuredOutputText(
      'Result: {"complete":true,"commandsRun":[{"command":"bun test","result":"passed"}]} Done.',
    )).toEqual({
      complete: true,
      commandsRun: [{ command: "bun test", result: "passed" }],
    });

    expect(tryParseStructuredOutputText(
      'Candidates: [{"id":1,"metadata":{"selected":false}},{"id":2}] Done.',
    )).toEqual([
      { id: 1, metadata: { selected: false } },
      { id: 2 },
    ]);
  });

  test("skips a tagged thinking prefix so schema sketches do not starve recovery", () => {
    const sketches = Array.from(
      { length: STRUCTURED_OUTPUT_RECOVERY_CANDIDATES + 8 },
      (_, index) => `{ incomplete schema sketch ${index}`,
    ).join(" ");
    const text = [
      "<thinking>",
      "The schema requires JSON. CreatePlan's plan field is markdown, not JSON.",
      sketches,
      '{"type":"object","properties":{"name":{}}}',
      "</thinking>",
      '{"verdict":{"ready":"yes"}}',
    ].join("\n");

    expect(tryParseStructuredOutputText(text)).toEqual({ verdict: { ready: "yes" } });
  });

  test("still reaches a trailing document after more than 16 untagged brace fragments", () => {
    const sketches = Array.from(
      { length: 40 },
      (_, index) => `{ incomplete schema sketch ${index}`,
    ).join(" ");

    expect(tryParseStructuredOutputText(`${sketches}\n{"ready":"yes"}`))
      .toEqual({ ready: "yes" });
  });

  test("recovers JSON wrapped in XML or a tool-call envelope", () => {
    expect(tryParseStructuredOutputText(
      '<result>\n{"complete":true}\n</result>',
    )).toEqual({ complete: true });

    expect(tryParseStructuredOutputText(
      '<invoke name="CreatePlan">{"name":"plan","overview":"nope"}</invoke>\n{"complete":true}',
    )).toEqual({ complete: true });
  });

  test("recovers a fenced document that follows a thinking prefix", () => {
    expect(tryParseStructuredOutputText(
      "Weighing whether to embed JSON inside the plan.\n```json\n{\"complete\":true}\n```",
    )).toEqual({ complete: true });
  });

  test("rejects prose with no JSON document", () => {
    expect(tryParseStructuredOutputText("")).toBeUndefined();
    expect(tryParseStructuredOutputText("   ")).toBeUndefined();
    expect(tryParseStructuredOutputText("I could not verify the build.")).toBeUndefined();
    expect(tryParseStructuredOutputText("{not json")).toBeUndefined();
    expect(tryParseStructuredOutputText('{"a": }')).toBeUndefined();
  });
});
