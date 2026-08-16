import { describe, expect, test } from "bun:test";
import {
  STRUCTURED_OUTPUT_RECOVERY_CANDIDATES,
  STRUCTURED_OUTPUT_RECOVERY_CHARS,
  STRUCTURED_OUTPUT_RECOVERY_TAGS,
  tryParseStructuredOutputText,
} from "./structured-output-text";

/** Enough incomplete `{` fragments to spend the whole candidate budget. */
function starvingSketches(): string {
  return Array.from(
    { length: STRUCTURED_OUTPUT_RECOVERY_CANDIDATES + 8 },
    (_, index) => `{ incomplete schema sketch ${index}`,
  ).join(" ");
}

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

  test("prefers JSON outside a tagged thinking block over JSON inside it", () => {
    expect(tryParseStructuredOutputText(
      '{"complete":true}\n<thinking>\n{"fromThought":true}\n</thinking>',
    )).toEqual({ complete: true });

    expect(tryParseStructuredOutputText(
      '<thinking>\n{"fromThought":true}\n</thinking>\n{"complete":true}',
    )).toEqual({ complete: true });

    expect(tryParseStructuredOutputText(
      '{"complete":true}\n<think>{"fromThought":true}</think>',
    )).toEqual({ complete: true });
  });

  test("recognises a thinking tag with attributes, emphasis, or no leading space", () => {
    expect(tryParseStructuredOutputText(
      '{"complete":true}\n<thinking type="reflection">{"fromThought":true}</thinking>',
    )).toEqual({ complete: true });

    expect(tryParseStructuredOutputText(
      '{"complete":true}\n**<thinking>**{"fromThought":true}**</thinking>**',
    )).toEqual({ complete: true });

    expect(tryParseStructuredOutputText(
      '{"complete":true}\nReasoning:<thinking>{"fromThought":true}</thinking>',
    )).toEqual({ complete: true });

    // `<thinker>` is not a thinking tag, so its contents stay in scan range.
    expect(tryParseStructuredOutputText(
      '{"complete":true}\n<thinker>{"fromElsewhere":true}</thinker>',
    )).toEqual({ fromElsewhere: true });
  });

  test("treats an opening tag with no close as running to the end of the text", () => {
    expect(tryParseStructuredOutputText(
      '{"complete":true}\n<thinking>{"fromThought":true}',
    )).toEqual({ complete: true });

    // Nothing outside it, so the truncated block is still searched.
    expect(tryParseStructuredOutputText(
      '<thinking>\nDeciding the shape.\n{"complete":true}',
    )).toEqual({ complete: true });
  });

  test("recovers past a thinking trace whose opening tag never reached the text", () => {
    const text = [
      "The schema requires JSON. CreatePlan's plan field is markdown, not JSON.",
      starvingSketches(),
      "</thinking>",
      '{"verdict":{"ready":"yes"}}',
    ].join("\n");

    expect(tryParseStructuredOutputText(text)).toEqual({ verdict: { ready: "yes" } });
  });

  test("still recovers JSON that exists only inside a tagged thinking block", () => {
    expect(tryParseStructuredOutputText(
      '<thinking>\n{"complete":true}\n</thinking>',
    )).toEqual({ complete: true });

    // The interior wins only as a last resort: nothing outside the block parses
    // here, so a schema sketch is preferred over losing the turn entirely.
    expect(tryParseStructuredOutputText(
      '<thinking>\nPlan: emit {"type":"object"}\n</thinking>\nHere is the answer: {"partial":',
    )).toEqual({ type: "object" });
  });

  test("bounds the scan when thinking tags never pair", () => {
    // Wrapper discovery must stay linear. Pairing each opening tag by rescanning
    // the remaining text costs ~34s on this input; the bound here is loose
    // enough to absorb a slow machine and still catch that.
    const budgetMs = 2_000;
    const payload = '\n{"complete":true}';
    const fill = (unit: string) =>
      unit.repeat(Math.floor((STRUCTURED_OUTPUT_RECOVERY_CHARS - payload.length) / unit.length));

    for (const unit of ["<think> ", "</think> ", "<think></other> "]) {
      const started = performance.now();
      const parsed = tryParseStructuredOutputText(`${fill(unit)}${payload}`);
      expect(performance.now() - started).toBeLessThan(budgetMs);
      expect(parsed).toEqual({ complete: true });
    }
  });

  test("degrades to the untagged scan past the thinking-tag cap", () => {
    const wrappers = Array.from(
      { length: STRUCTURED_OUTPUT_RECOVERY_TAGS + 4 },
      (_, index) => `<thinking>{"sketch":${index}}</thinking>`,
    ).join("\n");

    // Blocks beyond the cap are no longer skipped, but the document outside
    // every block still wins because it is the last one recovered.
    expect(tryParseStructuredOutputText(`${wrappers}\n{"complete":true}`))
      .toEqual({ complete: true });
  });

  test("does not treat a stray thinking close tag as a scan boundary", () => {
    expect(tryParseStructuredOutputText(
      '{"complete":true}\nI used </thinking> as an example.\n',
    )).toEqual({ complete: true });

    expect(tryParseStructuredOutputText(
      'Here is the result:\n{"note":"see </thinking> inside","complete":true}',
    )).toEqual({ note: "see </thinking> inside", complete: true });

    expect(tryParseStructuredOutputText(
      'Result:\n{"note":"</thinking>","payload":{"complete":true}}',
    )).toEqual({ note: "</thinking>", payload: { complete: true } });
  });

  test("skips a tagged thinking prefix so schema sketches do not starve recovery", () => {
    const sketches = starvingSketches();
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
