import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { WORKFLOW_RESULT_KINDS } from "@orkestrator/protocol/workflow-results";
import { callToolInProcess } from "../mcp-in-process.js";
import {
  CONSOLIDATED_REVIEW_EXAMPLE,
  CONSOLIDATED_REVIEW_EXAMPLE_SOURCE_IDS,
} from "../review/consolidation-example.js";
import {
  acceptsOnlyDeclaredFields,
  decodeJsonTextResult,
  findJsonTextFault,
} from "./result-json-text.js";
import { CONSOLIDATED_REVIEW_ANY_SLOT_JSON_SCHEMA } from "../review/consolidation-scope.js";
import { workflowResultAnySlotSchema, workflowResultProviderSchema } from "./result-registry.js";
import { WorkflowResultService } from "./result-service.js";
import { registerWorkflowResultBrokerTools, registerWorkflowResultTools } from "./result-tools.js";

/** The tool's published shape, whose `blockedReason` is null when the review was not blocked. */
const report = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: [],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: ["Could not run the integration suite."],
    outcome: "reviewed",
    blockedReason: null,
  },
  whatChanged: {
    overview: "No change.",
    before: "Before.",
    after: "After.",
    keyCodeChanges: [],
    userImpact: "None.",
  },
  riskProfile: { changeTypes: [], riskAreas: [], overallRisk: "low", reasoning: "Low." },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "no", reasoning: "The suite did not run." },
  summaryOfChange: "No change.",
  reviewSummary: "No high-confidence issues were found.",
};

/**
 * The fault in the real failure (#2470): one stray `}` right after the
 * `testCoverageGaps` array closes the root, and `verdict`, `summaryOfChange`
 * and `reviewSummary` follow outside it.
 */
function strayBraceText(): { text: string; brace: number } {
  const valid = JSON.stringify(report);
  const marker = '"verdict":';
  const at = valid.indexOf(marker) - 1; // the `,` before `"verdict"`
  return { text: `${valid.slice(0, at)}}${valid.slice(at)}`, brace: at };
}

/**
 * The stray brace with a second fault after it (an extra `}` at the end), so
 * removing either bracket alone does not make the text parse.
 */
function unrepairableStrayBraceText(): { text: string; brace: number } {
  const { text, brace } = strayBraceText();
  return { text: `${text}}`, brace };
}

/** `text` with one character inserted before `offset`. */
function insertAt(text: string, offset: number, char: string): string {
  return `${text.slice(0, offset)}${char}${text.slice(offset)}`;
}

describe("decodeJsonTextResult", () => {
  test("valid JSON text decodes to the object it encodes", () => {
    const decoded = decodeJsonTextResult(JSON.stringify(report));
    expect(decoded.ok && decoded.value).toEqual(report);
  });

  test("text encoded twice is unwrapped once", () => {
    expect(decodeJsonTextResult(JSON.stringify(JSON.stringify({ a: 1 })))).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  test("text that encodes something other than an object is refused by its type", () => {
    for (const [text, kind] of [
      ["[1,2]", "an array"],
      ["3", "a number"],
      ["null", "null"],
    ] as const) {
      const decoded = decodeJsonTextResult(text);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) continue;
      expect(decoded.message).toContain(`decodes to ${kind}, not an object`);
    }
  });

  test("a stray brace that closes the root early names the brace, the last field and the position", () => {
    const { text, brace } = strayBraceText();
    expect(() => JSON.parse(text)).toThrow();
    const decoded = decodeJsonTextResult(text);
    if (decoded.ok) throw new Error("expected a refusal");
    expect(decoded.summary).toContain(`at character ${brace + 1} (line 1, column ${brace + 2})`);
    expect(decoded.summary).toContain(
      `the \`}\` at character ${brace} already closed the top-level value right after its field \`testCoverageGaps\``,
    );
    expect(decoded.summary).toContain(`one closing \`}\` too many at or before character ${brace}`);
    expect(decoded.summary).toContain("pass the result as a JSON object");
    // The excerpt shows the text around the fault; the summary does not.
    expect(decoded.message).toContain('⟪HERE⟫,"verdict":');
    expect(decoded.summary).not.toContain("⟪HERE⟫");
    expect(decoded.summary).not.toContain("The suite did not run.");
  });

  test.each([
    ['{"a":1} ]', 8, "Remove the extra `]` at character 8."],
    ['{"a":1} {"b":2}', 8, "Pass exactly one JSON object."],
    ['{"a":1} "second"', 8, "Pass exactly one JSON object."],
    ["[1],2]", 3, "remove the extra one so the items that follow stay inside the top-level value"],
  ] as const)("gives focused advice for trailing data in %s", (text, offset, advice) => {
    expect(findJsonTextFault(text)).toMatchObject({
      offset,
      advice: expect.stringContaining(advice),
    });
  });

  test("a payload cut short names the brackets still open, innermost first", () => {
    const text = '{"issues":[{"title":"A"';
    const decoded = decodeJsonTextResult(text);
    if (decoded.ok) throw new Error("expected a refusal");
    expect(decoded.summary).toContain(`at character ${text.length}`);
    expect(decoded.summary).toContain("`$.issues[0]` is still open (3 unclosed brackets in all)");
    expect(decoded.summary).toContain("missing the closing `}]}`");
  });

  test("common slips are each named with their path", () => {
    const cases: Array<[string, string]> = [
      ['{"a":1,}', "a comma after `$.a` is followed by `}`"],
      ['{"a":[1,]}', "a comma inside `$.a` is followed by `]`"],
      ['{"a":[{"b":1]}', "`]` appears where `,` or `}` was expected, after `$.a[0].b`"],
      ['{"a":[1}', "`}` appears where `,` or `]` was expected, after `$.a[0]`"],
      ['{"a":"x\ny"}', "unescaped control character"],
      ['{"a":"x\\qy"}', "invalid escape `\\q`"],
      ["{'a':1}", "where a quoted field name was expected"],
      ['{"a":{"b":1,c:2}}', "where a quoted field name was expected, inside `$.a`"],
      ['{"a":{"b":1,"c', "inside `$.a`, is never closed"],
      ['{"a":{"b":1,"c":"value', "inside `$.a.c`, is never closed"],
      ['{"a" 1}', "where `:` was expected after the field name `$.a`"],
      ['{"a":undefined}', "where a value of `$.a` was expected"],
      ['{"a":"never closed}', "is never closed"],
    ];
    for (const [text, expected] of cases) {
      const decoded = decodeJsonTextResult(text);
      if (decoded.ok) throw new Error(`expected a refusal for ${text}`);
      expect(decoded.summary).toContain(expected);
    }
  });

  test("the scanner agrees with JSON.parse on every one-character deletion and duplication", () => {
    const valid = JSON.stringify({ a: [1, { b: "x\\y", c: null }], "d e": true, f: -1.5e3 });
    const variants = [valid];
    for (let index = 0; index < valid.length; index += 1) {
      variants.push(valid.slice(0, index) + valid.slice(index + 1));
      variants.push(valid.slice(0, index + 1) + valid.slice(index));
    }
    for (const text of variants) {
      let parses = true;
      try {
        JSON.parse(text);
      } catch {
        parses = false;
      }
      expect({ text, valid: findJsonTextFault(text) === null }).toEqual({ text, valid: parses });
    }
  });

  test("a stray brace that closes the root early is offered as a one-bracket repair", () => {
    const { text, brace } = strayBraceText();
    const decoded = decodeJsonTextResult(text);
    if (decoded.ok) throw new Error("expected a refusal");
    expect(decoded.repaired).toEqual({ value: report, offset: brace, bracket: "}" });
  });

  test.each([
    ["an extra `}` at the end", '{"a":[1],"b":{"c":2}}}', 21, "}"],
    ["an extra `]` after an array field", '{"a":[1]],"b":2}', 8, "]"],
    ["an extra `}` after an array item", '{"a":[{"b":1}},{"b":2}]}', 13, "}"],
  ] as const)("offers a repair for %s", (_name, text, offset, bracket) => {
    const decoded = decodeJsonTextResult(text);
    if (decoded.ok) throw new Error("expected a refusal");
    expect(decoded.repaired).toMatchObject({ offset, bracket });
    expect(decoded.repaired?.value).toEqual(
      JSON.parse(text.slice(0, offset) + text.slice(offset + 1)),
    );
  });

  test.each([
    ["a second fault after the first", unrepairableStrayBraceText().text],
    ["a missing closing bracket", '{"issues":[{"title":"A"}]'],
    ["a raw line break in a string", '{"a":"x\ny"}'],
    ["a trailing comma", '{"a":1,}'],
    ["a second JSON value", '{"a":1} {"b":2}'],
    ["text that repairs to an array", "[1]]"],
  ] as const)("offers no repair for %s", (_name, text) => {
    const decoded = decodeJsonTextResult(text);
    if (decoded.ok) throw new Error("expected a refusal");
    expect(decoded.repaired).toBeUndefined();
  });

  test("deep nesting is scanned without recursion", () => {
    expect(findJsonTextFault("[".repeat(200_000))).toMatchObject({ offset: 200_000 });
  });
});

describe("acceptsOnlyDeclaredFields", () => {
  test("every built-in result kind refuses undeclared fields at every level", () => {
    const builtIn = WORKFLOW_RESULT_KINDS.filter(
      (kind) => kind !== "graph-output" && kind !== "graph-template",
    );
    for (const kind of builtIn) {
      expect({
        kind,
        closed: acceptsOnlyDeclaredFields(workflowResultAnySlotSchema(kind)),
      }).toEqual({ kind, closed: true });
      expect({
        kind,
        closed: acceptsOnlyDeclaredFields(workflowResultProviderSchema(kind, {})),
      }).toEqual({ kind, closed: true });
    }
    expect(acceptsOnlyDeclaredFields(CONSOLIDATED_REVIEW_ANY_SLOT_JSON_SCHEMA)).toBe(true);
  });

  test.each([
    ["any object", { type: "object" }],
    ["no type", {}],
    [
      "an object that allows more fields",
      { type: "object", properties: {}, additionalProperties: true },
    ],
    [
      "a nested open object",
      {
        type: "object",
        additionalProperties: false,
        properties: { a: { type: "object", properties: {} } },
      },
    ],
    ["a reference", { $ref: "#/$defs/a" }],
    ["pattern properties", { type: "object", additionalProperties: false, patternProperties: {} }],
    [
      "an array of open items",
      { type: "array", items: { type: "object", additionalProperties: true } },
    ],
    ["an open alternative", { anyOf: [{ type: "null" }, { type: "object" }] }],
  ] as const)("counts %s as open", (_name, schema) => {
    expect(acceptsOnlyDeclaredFields(schema)).toBe(false);
  });

  test("closed objects, arrays, scalars, enums and alternatives count as closed", () => {
    expect(
      acceptsOnlyDeclaredFields({
        type: "object",
        additionalProperties: false,
        properties: {
          a: { type: ["string", "null"] },
          b: { type: "array", items: { enum: ["x", "y"] } },
          c: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false }] },
          d: { const: 1 },
        },
      }),
    ).toBe(true);
  });
});

describe("result tools take a result sent as JSON text", () => {
  const scope = { environmentId: "env-1", projectId: "project-1" };
  let dataDir: string;
  let service: WorkflowResultService;
  let resultKey: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-workflow-result-json-text-"));
    service = new WorkflowResultService(dataDir);
    resultKey = crypto.randomUUID();
    await service.prepare({ resultKey, kind: "review-report", ...scope, provider: "claude" });
  });

  afterEach(async () => {
    service.closeStorage();
    await rm(dataDir, { recursive: true, force: true });
  });

  const factory = () => {
    const server = new McpServer({ name: "json-text-test", version: "1.0.0" });
    registerWorkflowResultTools(server, service, {
      ...scope,
      workflowResultKey: resultKey,
      kind: "review-report",
    });
    return server;
  };

  test("valid JSON text is accepted as the object it encodes", async () => {
    const accepted = await callToolInProcess(factory, "submit_review_report", {
      resultKey,
      result: JSON.stringify(report),
    });
    expect(accepted.isError).toBe(false);
    const stored = await service.structured<unknown>(resultKey);
    expect(stored?.ok && stored.value).toEqual(report);
  });

  test("broken JSON text is refused with its position and counted, without spending a correction", async () => {
    // A second fault leaves no one-bracket repair, so the text is refused.
    const { text, brace } = unrepairableStrayBraceText();
    for (const tool of ["validate_workflow_result", "submit_review_report"]) {
      const refused = await callToolInProcess(factory, tool, { resultKey, result: text });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain(`at character ${brace + 1}`);
      expect(refused.text).toContain("right after its field `testCoverageGaps`");
      expect(refused.text).not.toContain("Expected object, received string");
    }
    expect(service.refusals(resultKey)).toMatchObject({ count: 2, processed: 0 });
    expect(service.refusals(resultKey)?.lastReason).toContain(`at character ${brace + 1}`);
    expect(await service.projection(resultKey)).toBe("preparing");
    const status = await service.status(scope, resultKey);
    expect(status?.delivery).toMatchObject({
      validationCalls: 0,
      submissionCalls: 0,
      refusedCalls: 2,
    });
    expect(status?.delivery?.hint).toContain("2 calls were refused before processing");
    expect(status?.delivery?.hint).toContain(`at character ${brace + 1}`);
    // The repaired text is then accepted.
    const accepted = await callToolInProcess(factory, "submit_review_report", {
      resultKey,
      result: JSON.stringify(report),
    });
    expect(accepted.isError).toBe(false);
  });

  test("text that parses but breaks the contract gets the same field paths as an object", async () => {
    const { testResults: _omitted, ...rest } = report;
    const refused = await callToolInProcess(factory, "submit_review_report", {
      resultKey,
      result: JSON.stringify(rest),
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("It parses, but the object does not match the contract");
    expect(refused.text).toContain("$.testResults: Required field is missing");
    expect(service.refusals(resultKey)).toMatchObject({ count: 1, processed: 0 });
    expect(await service.projection(resultKey)).toBe("preparing");
  });

  test("a stray brace that closes the report early is repaired and accepted on the first call", async () => {
    const { text } = strayBraceText();
    const accepted = await callToolInProcess(factory, "submit_review_report", {
      resultKey,
      result: text,
    });
    expect(accepted.isError).toBe(false);
    expect(await service.structured<unknown>(resultKey)).toMatchObject({ ok: true, value: report });
    expect(service.refusals(resultKey)).toBeUndefined();
  });

  test("validation repairs the same bracket, and its digest commits the repaired report", async () => {
    const { text } = strayBraceText();
    const checked = await callToolInProcess(factory, "validate_workflow_result", {
      resultKey,
      result: text,
    });
    expect(checked.isError).toBe(false);
    const validatedDigest = checked.structuredContent?.validatedDigest;
    expect(validatedDigest).toMatch(/^[a-f0-9]{64}$/);
    const accepted = await callToolInProcess(factory, "submit_review_report", {
      resultKey,
      validatedDigest,
    });
    expect(accepted.isError).toBe(false);
    expect(await service.structured<unknown>(resultKey)).toMatchObject({ ok: true, value: report });
  });

  test("a repair that would move fields to another level is refused with the original fault", async () => {
    // The extra `}` closes `reviewScope` before `blockedReason`. Removing the
    // bracket the scanner names would make `blockedReason` a top-level field,
    // which the contract refuses, so the JSON fault is reported as it is.
    const valid = JSON.stringify(report);
    const text = insertAt(valid, valid.indexOf(',"blockedReason":'), "}");
    const decoded = decodeJsonTextResult(text);
    if (decoded.ok) throw new Error("expected a refusal");
    expect(decoded.repaired?.value).toHaveProperty("blockedReason", null);
    const refused = await callToolInProcess(factory, "submit_review_report", {
      resultKey,
      result: text,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("`result` is a string, and it is not valid JSON");
    expect(refused.text).toContain("already closed the top-level value");
    // What the check found without the bracket is named too.
    expect(refused.text).toContain("the object without it still does not match the contract");
    expect(refused.text).toContain("$.reviewScope.blockedReason: Required field is missing");
    expect(service.refusals(resultKey)).toMatchObject({ count: 1, processed: 0 });
    expect(await service.projection(resultKey)).toBe("preparing");
  });

  test("an object the input check refuses is counted for the key it names, and only that key", async () => {
    const { testResults: _omitted, ...rest } = report;
    const refused = await callToolInProcess(factory, "submit_review_report", {
      resultKey,
      result: rest,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("$.testResults: Required field is missing");
    expect(service.refusals(resultKey)?.lastReason).toContain(
      "result: $.testResults: Required field is missing",
    );
    await callToolInProcess(factory, "submit_review_report", {
      resultKey: crypto.randomUUID(),
      result: rest,
    });
    expect(service.refusals(resultKey)?.count).toBe(1);
  });

  test("a closed slot keeps no refusal count", async () => {
    await service.close(resultKey, "superseded");
    service.recordRefusedCall(scope, resultKey, "refused");
    expect(service.refusals(resultKey)).toBeUndefined();
  });

  test("superseding keeps one bounded summary without changing the successor's call status", async () => {
    const successor = crypto.randomUUID();
    const refusal = "a".repeat(1_000);
    service.recordRefusedCall(scope, resultKey, refusal);
    await service.close(resultKey, "superseded", successor);
    await service.close(resultKey, "superseded", successor);
    await service.prepare({
      ...scope,
      resultKey: successor,
      kind: "review-report",
      provider: "claude",
    });
    expect(service.refusals(resultKey)).toBeUndefined();
    expect(service.refusals(successor)).toEqual({
      count: 1,
      processed: 0,
      lastReason: `${refusal.slice(0, 599)}…`,
    });
    const status = await service.status(scope, successor);
    expect(status?.lifecycle).toBe("open");
    expect(status?.delivery?.refusedCalls).toBeUndefined();
    expect(await service.validate(scope, successor, report)).toMatchObject({ ok: true });
    expect(service.refusals(successor)?.processed).toBe(1);
    await service.close(successor, "cancelled");
    expect(service.refusals(successor)).toBeUndefined();
  });

  test("another scope cannot add refusals to a slot", () => {
    service.recordRefusedCall({ ...scope, projectId: "other" }, resultKey, "refused");
    expect(service.refusals(resultKey)).toBeUndefined();
  });

  test.each(["direct", "validated digest", "stray brace"] as const)(
    "scoped consolidation accepts JSON text by %s",
    async (mode) => {
      const key = crypto.randomUUID();
      await service.prepare({
        ...scope,
        resultKey: key,
        kind: "consolidated-review",
        provider: "claude",
        context: {
          type: "consolidated-review",
          sources: {
            [CONSOLIDATED_REVIEW_EXAMPLE_SOURCE_IDS.issue]: "issue",
            [CONSOLIDATED_REVIEW_EXAMPLE_SOURCE_IDS.coverageGap]: "coverage-gap",
          },
        },
      });
      const consolidationTools = () => {
        const server = new McpServer({ name: "consolidation-json-text", version: "1.0.0" });
        registerWorkflowResultTools(server, service, {
          ...scope,
          workflowResultKey: key,
          kind: "consolidated-review",
        });
        return server;
      };
      const valid = JSON.stringify(CONSOLIDATED_REVIEW_EXAMPLE);
      // The real consolidation fault: the root closed right after `testCoverageGaps`.
      const result =
        mode === "stray brace" ? insertAt(valid, valid.indexOf(',"verdict":'), "}") : valid;
      let input: Record<string, unknown> = { resultKey: key, result };
      if (mode === "validated digest") {
        const checked = await callToolInProcess(
          consolidationTools,
          "validate_workflow_result",
          input,
        );
        expect(checked.isError).toBe(false);
        const validatedDigest = checked.structuredContent?.validatedDigest;
        expect(validatedDigest).toMatch(/^[a-f0-9]{64}$/);
        input = { resultKey: key, validatedDigest };
      }
      const accepted = await callToolInProcess(
        consolidationTools,
        "submit_consolidated_review",
        input,
      );
      expect(accepted.isError).toBe(false);
      expect(await service.structured(key)).toMatchObject({
        ok: true,
        value: { reviewSummary: CONSOLIDATED_REVIEW_EXAMPLE.reviewSummary },
      });
    },
  );

  test("the authenticated broker's per-kind submit tool accepts JSON text", async () => {
    const key = crypto.randomUUID();
    await service.initializeCapabilityIdentity();
    await service.prepare({
      ...scope,
      resultKey: key,
      kind: "review-report",
      provider: "opencode",
    });
    const capability = service.capabilityToken(scope, key);
    const accepted = await callToolInProcess(
      () => {
        const server = new McpServer({ name: "broker-json-text-submit", version: "1.0.0" });
        registerWorkflowResultBrokerTools(server, service, scope);
        return server;
      },
      "submit_review_report",
      { resultKey: key, capability, result: JSON.stringify(report) },
    );
    expect(accepted.isError).toBe(false);
    expect(await service.structured(key)).toMatchObject({ ok: true, value: report });
  });
});

describe("the broker's validation tool takes JSON text", () => {
  test("decoded text reaches validation and broken text is refused before it", async () => {
    const resultKey = crypto.randomUUID();
    const capability = "c".repeat(32);
    const scope = { environmentId: "env-1", projectId: "project-1" };
    const validated: unknown[] = [];
    const refused: string[] = [];
    const workflowResults = {
      async authenticateCapability(token: string) {
        return token === capability ? { ...scope, workflowResultKey: resultKey } : null;
      },
      async binding() {
        return { kind: "review-report", provider: "opencode" };
      },
      async validate(_scope: unknown, _key: string, result: unknown) {
        validated.push(result);
        return { ok: true, valid: true };
      },
      recordRefusedCall(_scope: unknown, _key: string, reason: string) {
        refused.push(reason);
      },
    };
    const factory = () => {
      const server = new McpServer({ name: "json-text-broker-test", version: "1.0.0" });
      registerWorkflowResultBrokerTools(server, workflowResults as never, scope);
      return server;
    };
    const ok = await callToolInProcess(factory, "validate_workflow_result", {
      resultKey,
      capability,
      result: JSON.stringify({ a: 1 }),
    });
    expect(ok.isError).toBe(false);
    expect(validated).toEqual([{ a: 1 }]);
    const broken = await callToolInProcess(factory, "validate_workflow_result", {
      resultKey,
      capability,
      result: '{"a":1}}',
    });
    expect(broken.isError).toBe(true);
    expect(broken.text).toContain("at character 7");
    expect(broken.text).toContain("Remove the extra `}` at character 7.");
    expect(validated).toHaveLength(1);
    expect(refused).toHaveLength(1);
  });
});
