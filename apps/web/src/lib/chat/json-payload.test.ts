import { describe, expect, test } from "bun:test";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import {
  describeJsonValue,
  humanizeJsonKey,
  isEmptyJsonContainer,
  jsonEntryLabel,
  jsonPayloadSearchText,
  jsonPayloadSource,
  jsonPayloadSummary,
  jsonPayloadTitle,
  MAX_JSON_PAYLOAD_LENGTH,
  parseJsonPayload,
} from "./json-payload";

describe("jsonPayloadSource", () => {
  test("accepts a bare object or array", () => {
    expect(jsonPayloadSource(' {"a":1} ')).toEqual({
      source: '{"a":1}',
      fenced: false,
    });
    expect(jsonPayloadSource("[1, 2]")).toEqual({
      source: "[1, 2]",
      fenced: false,
    });
  });

  test("unwraps a fenced block and records that it was fenced", () => {
    expect(jsonPayloadSource('```json\n{"a":1}\n```')).toEqual({
      source: '{"a":1}',
      fenced: true,
    });
    expect(jsonPayloadSource('```\n{"a":1}\n```')).toEqual({
      source: '{"a":1}',
      fenced: true,
    });
  });

  test("unwraps the json5 and jsonc fence tags the fence pattern allows", () => {
    expect(jsonPayloadSource('```json5\n{"a":1}\n```')?.source).toBe('{"a":1}');
    expect(jsonPayloadSource('```jsonc\n{"a":1}\n```')?.source).toBe('{"a":1}');
    expect(jsonPayloadSource('```JSON\n{"a":1}\n```')?.source).toBe('{"a":1}');
  });

  test("unwraps a fence written with CRLF line endings", () => {
    expect(jsonPayloadSource('```json\r\n{"a":1}\r\n```')).toEqual({
      source: '{"a":1}',
      fenced: true,
    });
  });

  test("rejects prose that merely contains JSON", () => {
    expect(jsonPayloadSource('Here it is: {"a":1}')).toBeNull();
    expect(jsonPayloadSource('{"a":1} and then some words')).toBeNull();
  });

  test("does not treat two fenced blocks as one document", () => {
    // The greedy tail would splice them into an unparseable candidate; the
    // balance check lets it through but `parseJsonPayload` must not accept it.
    const twoBlocks = '```json\n{"a":1}\n```\n\n```json\n{"b":2}\n```';
    expect(parseJsonPayload(twoBlocks)).toBeNull();
  });

  test("accepts a payload at exactly the parse budget", () => {
    const filler = "x".repeat(MAX_JSON_PAYLOAD_LENGTH - '{"a":""}'.length);
    const atLimit = `{"a":"${filler}"}`;
    expect(atLimit).toHaveLength(MAX_JSON_PAYLOAD_LENGTH);
    expect(jsonPayloadSource(atLimit)?.source).toHaveLength(
      MAX_JSON_PAYLOAD_LENGTH,
    );
  });

  test("rejects a payload one character past the parse budget", () => {
    const filler = "x".repeat(MAX_JSON_PAYLOAD_LENGTH - '{"a":""}'.length + 1);
    const overLimit = `{"a":"${filler}"}`;
    expect(overLimit).toHaveLength(MAX_JSON_PAYLOAD_LENGTH + 1);
    expect(jsonPayloadSource(overLimit)).toBeNull();
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

  test("recognizes a fenced verification verdict", () => {
    const payload = parseJsonPayload(
      '```json\n{"complete":true,"rationale":"Clean."}\n```',
    );
    expect(payload?.kind).toBe("verification");
  });

  test("materializes notRun on a report persisted before the field existed", () => {
    const { notRun: _notRun, ...legacyTestResults } =
      TEST_STRUCTURED_REVIEW_REPORT.testResults;
    const payload = parseJsonPayload(JSON.stringify({
      ...TEST_STRUCTURED_REVIEW_REPORT,
      testResults: legacyTestResults,
    }));

    expect(payload?.kind).toBe("structured-review");
    // Validation runs against a backfilled copy, so the report carried out of
    // here has to be that copy — not the original, which would hand every
    // consumer a `StructuredReviewReport` missing a required field.
    if (payload?.kind !== "structured-review") throw new Error("unreachable");
    expect(typeof payload.report.testResults.notRun).toBe("number");
    expect(payload.report.testResults.notRun).toBe(
      legacyTestResults.total
        - legacyTestResults.passed
        - legacyTestResults.failed,
    );
  });

  test("strips the null alternativeFixes sentinel the contract permits", () => {
    const [firstIssue, ...restIssues] = TEST_STRUCTURED_REVIEW_REPORT.issues;
    const payload = parseJsonPayload(JSON.stringify({
      ...TEST_STRUCTURED_REVIEW_REPORT,
      issues: [{ ...firstIssue, alternativeFixes: null }, ...restIssues],
    }));

    expect(payload?.kind).toBe("structured-review");
    if (payload?.kind !== "structured-review") throw new Error("unreachable");
    const normalizedIssue = payload.report.issues[0]!;
    expect(normalizedIssue).not.toHaveProperty("alternativeFixes", null);
    expect(normalizedIssue.alternativeFixes).toBeUndefined();
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

  test("falls back to a generic payload for other bare JSON", () => {
    const payload = parseJsonPayload('{"status":"ok","items":[1]}');
    expect(payload).toEqual({
      kind: "json",
      value: { status: "ok", items: [1] },
    });
  });

  test("leaves a fenced block of unrecognized JSON to the markdown renderer", () => {
    // The tree humanizes keys, so it cannot show the document the agent wrote.
    // An agent that fenced its JSON meant it to be read as source, and
    // Markdown already renders that verbatim.
    expect(parseJsonPayload('```json\n{"compilerOptions":{"strict":true}}\n```'))
      .toBeNull();
    expect(parseJsonPayload('```\n[1, 2, 3]\n```')).toBeNull();
  });

  test("leaves prose, scalars and malformed JSON to the text renderer", () => {
    expect(parseJsonPayload("Reviewing the branch now.")).toBeNull();
    expect(parseJsonPayload("null")).toBeNull();
    expect(parseJsonPayload('"just a string"')).toBeNull();
    expect(parseJsonPayload('{"a": }')).toBeNull();
    expect(parseJsonPayload("")).toBeNull();
  });

  test("does not mistake a __proto__ carrier for a verdict, and does not pollute", () => {
    const payload = parseJsonPayload(
      '{"__proto__":{"polluted":true},"complete":true,"rationale":"Done."}',
    );
    // JSON.parse defines `__proto__` as an own property, so the key count rules
    // this out as a verdict rather than letting it through as one.
    expect(payload?.kind).toBe("json");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("jsonPayloadTitle and jsonPayloadSummary", () => {
  test("name a verification verdict by its outcome", () => {
    const passed = parseJsonPayload('{"complete":true,"rationale":"Clean."}')!;
    const failed = parseJsonPayload('{"complete":false,"rationale":"Nope."}')!;
    expect(jsonPayloadTitle(passed)).toBe("Verification passed");
    expect(jsonPayloadTitle(failed)).toBe("Verification failed");
    expect(jsonPayloadSummary(passed)).toBe("Clean.");
  });

  test("flatten a multi-line rationale onto the collapsed row", () => {
    const payload = parseJsonPayload(
      '{"complete":true,"rationale":"Tree clean.\\n\\nSuite passed."}',
    )!;
    expect(jsonPayloadSummary(payload)).toBe("Tree clean. Suite passed.");
  });

  test("distinguish a list from an object payload", () => {
    expect(jsonPayloadTitle(parseJsonPayload('[{"a":1}]')!)).toBe("JSON list");
    expect(jsonPayloadTitle(parseJsonPayload('{"a":1}')!)).toBe("JSON payload");
    expect(jsonPayloadSummary(parseJsonPayload('[1,2,3]')!)).toBe("3 items");
  });

  test("summarize a structured review report by its verdict", () => {
    const payload = parseJsonPayload(
      JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT),
    )!;
    expect(jsonPayloadTitle(payload)).toBe("Structured review report");
    expect(jsonPayloadSummary(payload)).toContain("Ready: ");
    expect(jsonPayloadSummary(payload)).toContain(" risk");
  });
});

describe("jsonPayloadSearchText", () => {
  test("is the collapsed row's own text, concatenated as the DOM holds it", () => {
    const payload = parseJsonPayload('{"complete":true,"rationale":"Clean."}')!;
    expect(jsonPayloadSearchText(payload)).toBe("Verification passedClean.");
  });

  test("never indexes the raw document", () => {
    // Indexing the source would count matches inside an unmounted disclosure,
    // which find can count but can never highlight.
    const payload = parseJsonPayload('{"stageName":"verify","attempts":2}')!;
    const searchText = jsonPayloadSearchText(payload);
    expect(searchText).not.toContain("stageName");
    expect(searchText).toBe("JSON payload2 fields");
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
    expect(humanizeJsonKey("")).toBe("");
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
    expect(describeJsonValue(null)).toBe("");
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

  test("prefers the earliest label key over a later one", () => {
    expect(jsonEntryLabel({ id: "abc", name: "Readable" })).toBe("Readable");
  });

  test("collapses whitespace and truncates a long label", () => {
    expect(jsonEntryLabel({ name: " a \n b " })).toBe("a b");
    expect(jsonEntryLabel({ name: "x".repeat(200) })).toHaveLength(80);
    expect(jsonEntryLabel({ name: "x".repeat(200) })?.endsWith("…")).toBe(true);
  });

  test("has no label for an array, a scalar or an unlabelled record", () => {
    expect(jsonEntryLabel([1])).toBeNull();
    expect(jsonEntryLabel("text")).toBeNull();
    expect(jsonEntryLabel(null)).toBeNull();
    expect(jsonEntryLabel({ count: 2 })).toBeNull();
    expect(jsonEntryLabel({ title: "  " })).toBeNull();
  });
});
