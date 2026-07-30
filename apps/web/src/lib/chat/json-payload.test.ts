import { describe, expect, test } from "bun:test";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import {
  describeJsonValue,
  humanizeJsonKey,
  isEmptyJsonContainer,
  jsonEntryLabel,
  jsonPayloadSource,
  MAX_JSON_PAYLOAD_LENGTH,
  parseJsonPayload,
} from "./json-payload";

describe("jsonPayloadSource", () => {
  test("accepts a bare object or array", () => {
    expect(jsonPayloadSource(' {"a":1} ')).toBe('{"a":1}');
    expect(jsonPayloadSource("[1, 2]")).toBe("[1, 2]");
  });

  test("unwraps a fenced block", () => {
    expect(jsonPayloadSource('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(jsonPayloadSource('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("rejects prose that merely contains JSON", () => {
    expect(jsonPayloadSource('Here it is: {"a":1}')).toBeNull();
    expect(jsonPayloadSource('{"a":1} and then some words')).toBeNull();
  });

  test("rejects a payload past the parse budget", () => {
    const huge = `{"a":"${"x".repeat(MAX_JSON_PAYLOAD_LENGTH)}"}`;
    expect(jsonPayloadSource(huge)).toBeNull();
  });
});

describe("parseJsonPayload", () => {
  test("recognizes a structured review report", () => {
    const payload = parseJsonPayload(
      JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT),
    );
    expect(payload?.kind).toBe("structured-review");
  });

  test("recognizes a fenced structured review report", () => {
    const payload = parseJsonPayload(
      `\`\`\`json\n${JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT, null, 2)}\n\`\`\``,
    );
    expect(payload?.kind).toBe("structured-review");
  });

  test("accepts a report persisted before testResults.notRun existed", () => {
    const { notRun: _notRun, ...legacyTestResults } =
      TEST_STRUCTURED_REVIEW_REPORT.testResults;
    const payload = parseJsonPayload(JSON.stringify({
      ...TEST_STRUCTURED_REVIEW_REPORT,
      testResults: legacyTestResults,
    }));
    expect(payload?.kind).toBe("structured-review");
  });

  test("recognizes a verification verdict", () => {
    const payload = parseJsonPayload(
      '{"complete":true,"rationale":"Working tree is clean."}',
    );
    expect(payload).toEqual({
      kind: "verification",
      verdict: { complete: true, rationale: "Working tree is clean." },
    });
  });

  test("does not mistake a wider payload for a verification verdict", () => {
    // `additionalProperties: false` is part of the contract, so a third field
    // means this was never a verdict.
    const payload = parseJsonPayload(
      '{"complete":true,"rationale":"Done.","stage":"verify"}',
    );
    expect(payload?.kind).toBe("json");
    expect(parseJsonPayload('{"complete":"yes","rationale":"Done."}')?.kind)
      .toBe("json");
  });

  test("falls back to a generic payload for other JSON", () => {
    const payload = parseJsonPayload('{"status":"ok","items":[1]}');
    expect(payload).toEqual({
      kind: "json",
      value: { status: "ok", items: [1] },
    });
  });

  test("leaves prose, scalars and malformed JSON to the text renderer", () => {
    expect(parseJsonPayload("Reviewing the branch now.")).toBeNull();
    expect(parseJsonPayload("null")).toBeNull();
    expect(parseJsonPayload('"just a string"')).toBeNull();
    expect(parseJsonPayload('{"a": }')).toBeNull();
    expect(parseJsonPayload("")).toBeNull();
  });
});

describe("humanizeJsonKey", () => {
  test("reads camelCase as a sentence", () => {
    expect(humanizeJsonKey("reviewScope")).toBe("Review scope");
    expect(humanizeJsonKey("filesLeftUncommitted")).toBe(
      "Files left uncommitted",
    );
  });

  test("splits snake_case and kebab-case", () => {
    expect(humanizeJsonKey("user_impact")).toBe("User impact");
    expect(humanizeJsonKey("key-code-changes")).toBe("Key code changes");
  });

  test("keeps acronyms intact", () => {
    expect(humanizeJsonKey("SDKVersion")).toBe("SDK version");
    expect(humanizeJsonKey("URLs")).toBe("URLs");
    expect(humanizeJsonKey("id")).toBe("Id");
  });

  test("returns the original key when there is nothing to humanize", () => {
    expect(humanizeJsonKey("__")).toBe("__");
  });
});

describe("describeJsonValue", () => {
  test("counts items and fields, singular included", () => {
    expect(describeJsonValue([1, 2])).toBe("2 items");
    expect(describeJsonValue([1])).toBe("1 item");
    expect(describeJsonValue({ a: 1 })).toBe("1 field");
    expect(describeJsonValue([])).toBe("0 items");
  });

  test("has nothing to say about a scalar", () => {
    expect(describeJsonValue("text")).toBe("");
  });
});

describe("isEmptyJsonContainer", () => {
  test("distinguishes empty containers from populated ones and scalars", () => {
    expect(isEmptyJsonContainer([])).toBe(true);
    expect(isEmptyJsonContainer({})).toBe(true);
    expect(isEmptyJsonContainer([0])).toBe(false);
    expect(isEmptyJsonContainer("")).toBe(false);
    expect(isEmptyJsonContainer(null)).toBe(false);
  });
});

describe("jsonEntryLabel", () => {
  test("names a record by its most descriptive field", () => {
    expect(jsonEntryLabel({ id: "1", title: "Retry is not persisted" }))
      .toBe("Retry is not persisted");
    expect(jsonEntryLabel({ command: "bun test", result: "passed" }))
      .toBe("bun test");
  });

  test("collapses whitespace and truncates a long label", () => {
    expect(jsonEntryLabel({ name: " a \n b " })).toBe("a b");
    expect(jsonEntryLabel({ name: "x".repeat(200) })).toHaveLength(80);
  });

  test("has no label for an array, a scalar or an unlabelled record", () => {
    expect(jsonEntryLabel([1])).toBeNull();
    expect(jsonEntryLabel("text")).toBeNull();
    expect(jsonEntryLabel({ count: 2 })).toBeNull();
    expect(jsonEntryLabel({ title: "  " })).toBeNull();
  });
});
