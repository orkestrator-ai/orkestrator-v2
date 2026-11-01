import { describe, expect, test } from "bun:test";
import { structuredReviewFindings } from "@orkestrator/protocol/structured-review";
import { TEST_STRUCTURED_REVIEW_REPORT } from "@/components/build-pipeline/structured-review-test-fixture";
import {
  describeJsonValue,
  humanizeJsonKey,
  isEmptyJsonContainer,
  jsonEntryLabel,
  jsonPayloadSearchText,
  jsonPayloadSummary,
  jsonPayloadTitle,
  parseJsonPayload,
  structuredReviewJsonPayload,
} from "./json-payload";

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
    expect(jsonPayloadSummary(parseJsonPayload("[1,2,3]")!)).toBe("3 items");
  });

  test("summarize a structured review report by its verdict", () => {
    const payload = parseJsonPayload(JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT))!;
    expect(jsonPayloadTitle(payload)).toBe("Structured review report");
    expect(jsonPayloadSummary(payload)).toContain("Ready: ");
    expect(jsonPayloadSummary(payload)).toContain(" risk");
  });

  test("summarize review findings by their counts", () => {
    const payload = parseJsonPayload(
      JSON.stringify(structuredReviewFindings(TEST_STRUCTURED_REVIEW_REPORT)),
    )!;
    expect(jsonPayloadTitle(payload)).toBe("Review findings");
    expect(jsonPayloadSummary(payload)).toBe("1 issue · 1 coverage gap");
  });

  test("wraps a durable report as the structured-review transcript payload", () => {
    const payload = structuredReviewJsonPayload(TEST_STRUCTURED_REVIEW_REPORT);
    expect(payload.kind).toBe("structured-review");
    expect(payload.report).toBe(TEST_STRUCTURED_REVIEW_REPORT);
    expect(payload.source).toContain("reviewScope");
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
    expect(humanizeJsonKey("filesLeftUncommitted")).toBe("Files left uncommitted");
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
    expect(jsonEntryLabel({ id: "1", title: "Retry is not persisted" })).toBe(
      "Retry is not persisted",
    );
    expect(jsonEntryLabel({ command: "bun test", result: "passed" })).toBe("bun test");
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
