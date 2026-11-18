import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import {
  STRUCTURED_REVIEW_MAX_LIST_ITEMS,
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  safeParseStructuredReviewReport,
  structuredReviewReportBudgetIssues,
  utf8Bytes,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import { validateWorkflowJsonSchema } from "@orkestrator/protocol/workflow-json-schema";
import type { ConsolidationScopeLists } from "@orkestrator/protocol/workflow-results";
import { createMultiReviewConsolidationPrompt } from "./multi-review-prompts.js";
import {
  CONSOLIDATED_REVIEW_EXAMPLE,
  CONSOLIDATED_REVIEW_EXAMPLE_SOURCE_IDS,
  CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE,
} from "./review-consolidation-example.js";
import {
  CONSOLIDATED_REVIEW_SUBMISSION_JSON_SCHEMA,
  CONSOLIDATION_SCOPE_MAX_BYTES,
  CONSOLIDATION_SCOPE_LIST_FIELDS,
  completeConsolidatedReview,
  consolidationScopeLists,
  isConsolidationScopeLists,
  mergeConsolidationScopeLists,
} from "./review-consolidation-scope.js";
import {
  consolidationResultContext,
  consolidationScopeFilledByBackend,
} from "./review-fanout-provenance.js";
import { parseStructuredReportResult } from "./review-fanout.js";
import { WorkflowResultService } from "./workflow-result-service.js";
import { workflowResultProviderSchema } from "./workflow-result-registry.js";

type Scope = StructuredReviewReport["reviewScope"];

function reportWith(scope: Partial<Scope>): StructuredReviewReport {
  const base = CONSOLIDATED_REVIEW_EXAMPLE as unknown as StructuredReviewReport;
  return {
    ...base,
    reviewScope: {
      ...base.reviewScope,
      filesReviewed: [],
      filesSkipped: [],
      filesLeftUncommitted: [],
      commandsRun: [],
      commandsNotRun: [],
      ...scope,
    },
  };
}

function reviewer(id: string, report: StructuredReviewReport | undefined, status = "completed") {
  return { id, agent: "claude", model: "haiku", status, report } as unknown as ReviewerRecord;
}

const MERGED: ConsolidationScopeLists = {
  filesReviewed: ["src/a.ts", "src/b.ts"],
  filesSkipped: [{ file: "bun.lock", reason: "Generated." }],
  filesLeftUncommitted: [],
  commandsRun: [{ command: "bun test", result: "passed", summary: "12 passed." }],
  commandsNotRun: [{ command: "mise run test:browser", reason: "No display." }],
};

describe("mergeConsolidationScopeLists", () => {
  test("takes the union in reviewer order, first entry winning", () => {
    const merged = mergeConsolidationScopeLists([
      reportWith({
        filesReviewed: ["src/a.ts", "src/b.ts"],
        filesLeftUncommitted: [{ file: "notes.md", reason: "Scratch file." }],
        commandsRun: [{ command: "bun test", result: "passed", summary: "First summary." }],
      }),
      reportWith({
        filesReviewed: ["src/b.ts", "src/c.ts"],
        filesLeftUncommitted: [{ file: "notes.md", reason: "Another reason." }],
        commandsRun: [
          { command: "bun test", result: "passed", summary: "Second summary." },
          { command: "bun run lint", result: "passed", summary: "Clean." },
        ],
      }),
    ]);
    expect(merged?.filesReviewed).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(merged?.filesLeftUncommitted).toEqual([{ file: "notes.md", reason: "Scratch file." }]);
    expect(merged?.commandsRun).toEqual([
      { command: "bun test", result: "passed", summary: "First summary." },
      { command: "bun run lint", result: "passed", summary: "Clean." },
    ]);
  });

  test("a file another reviewer read is not skipped, and a command another ran is not unrun", () => {
    const merged = mergeConsolidationScopeLists([
      reportWith({
        filesSkipped: [
          { file: "src/big.ts", reason: "Too large." },
          { file: "bun.lock", reason: "Generated." },
        ],
        commandsNotRun: [
          { command: "bun test", reason: "Out of time." },
          { command: "mise run test:browser", reason: "No display." },
        ],
      }),
      reportWith({
        filesReviewed: ["src/big.ts"],
        commandsRun: [{ command: "bun test", result: "passed", summary: "Ran." }],
      }),
    ]);
    expect(merged?.filesSkipped).toEqual([{ file: "bun.lock", reason: "Generated." }]);
    expect(merged?.commandsNotRun).toEqual([
      { command: "mise run test:browser", reason: "No display." },
    ]);
  });

  test("keeps a command that passed for one reviewer and failed for another", () => {
    const merged = mergeConsolidationScopeLists([
      reportWith({ commandsRun: [{ command: "bun test", result: "passed", summary: "Pass." }] }),
      reportWith({ commandsRun: [{ command: "bun test", result: "failed", summary: "Fail." }] }),
    ]);
    expect(merged?.commandsRun.map((entry) => entry.result)).toEqual(["passed", "failed"]);
  });

  test("retains opposite outcomes at the count limit and falls back above it", () => {
    const passed = Array.from({ length: STRUCTURED_REVIEW_MAX_LIST_ITEMS }, (_, i) => ({
      command: `cmd ${i}`,
      result: "passed" as const,
      summary: "Ok.",
    }));
    const failing = { command: passed[0]!.command, result: "failed" as const, summary: "Fail." };
    const reports = [reportWith({ commandsRun: passed }), reportWith({ commandsRun: [failing] })];
    for (const report of reports) {
      expect(safeParseStructuredReviewReport(report).success).toBe(true);
      expect(structuredReviewReportBudgetIssues(report)).toEqual([]);
    }
    expect(
      utf8Bytes(JSON.stringify({ ...MERGED, commandsRun: [...passed, failing] })),
    ).toBeLessThan(CONSOLIDATION_SCOPE_MAX_BYTES);
    expect(consolidationScopeLists(reports)).toBeUndefined();
    const atLimit = consolidationScopeLists([
      reportWith({ commandsRun: passed.slice(0, -1) }),
      reports[1]!,
    ]);
    expect(atLimit?.commandsRun).toEqual([...passed.slice(0, -1), failing]);
    expect(
      consolidationScopeLists([
        ...reports.slice(0, 1),
        reportWith({ commandsRun: passed.slice(0, 1) }),
      ])?.commandsRun,
    ).toEqual(passed);
  });

  test("offers no lists when the merge exceeds the context budget", () => {
    const filesReviewed = Array.from({ length: 2_000 }, (_, i) => `src/generated/file-${i}.ts`);
    expect(consolidationScopeLists([reportWith({ filesReviewed })])).toBeUndefined();
    expect(consolidationScopeLists([reportWith({ filesReviewed: ["a.ts"] })])).toBeDefined();
  });
});

describe("isConsolidationScopeLists", () => {
  test("accepts a merge and refuses other shapes", () => {
    expect(isConsolidationScopeLists(MERGED)).toBe(true);
    expect(isConsolidationScopeLists({ ...MERGED, extra: [] })).toBe(false);
    expect(isConsolidationScopeLists({ ...MERGED, filesReviewed: [1] })).toBe(false);
    expect(
      isConsolidationScopeLists({
        ...MERGED,
        commandsRun: [{ command: "x", result: "skipped", summary: "y" }],
      }),
    ).toBe(false);
    expect(
      isConsolidationScopeLists({ ...MERGED, filesSkipped: [{ file: "a", reason: "b", c: "d" }] }),
    ).toBe(false);
  });
});

describe("completeConsolidatedReview", () => {
  test("fills the lists in schema order and passes the full report schema", () => {
    const completed = completeConsolidatedReview(
      CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE,
      MERGED,
    ) as StructuredReviewReport;
    expect(Object.keys(completed.reviewScope)).toEqual([
      ...STRUCTURED_REVIEW_REPORT_JSON_SCHEMA.properties.reviewScope.required,
    ]);
    expect(completed.reviewScope.filesReviewed).toEqual(MERGED.filesReviewed);
    expect(completed.reviewScope.commandsNotRun).toEqual(MERGED.commandsNotRun);
    expect(validateWorkflowJsonSchema(STRUCTURED_REVIEW_REPORT_JSON_SCHEMA, completed)).toEqual([]);
  });

  test("replaces lists the model sent anyway, so filling in twice changes nothing", () => {
    const once = completeConsolidatedReview(CONSOLIDATED_REVIEW_EXAMPLE, MERGED);
    expect(completeConsolidatedReview(once, MERGED)).toEqual(once);
    expect((once as StructuredReviewReport).reviewScope.filesReviewed).toEqual(
      MERGED.filesReviewed,
    );
  });

  test("leaves a value without a reviewScope object for validation to report", () => {
    expect(completeConsolidatedReview("not a report", MERGED)).toBe("not a report");
    const noScope = { verdict: { ready: "yes", reasoning: "r" } };
    expect(completeConsolidatedReview(noScope, MERGED)).toBe(noScope);
  });
});

describe("the consolidated review submission schema", () => {
  test("makes exactly the backend-filled lists optional", () => {
    const scope = (
      CONSOLIDATED_REVIEW_SUBMISSION_JSON_SCHEMA as {
        properties: { reviewScope: { required: string[]; properties: Record<string, unknown> } };
      }
    ).properties.reviewScope;
    for (const field of CONSOLIDATION_SCOPE_LIST_FIELDS) {
      expect(scope.required).not.toContain(field);
      expect(scope.properties[field]).toBeDefined();
    }
    expect(scope.required).toContain("limitations");
    expect(
      validateWorkflowJsonSchema(
        CONSOLIDATED_REVIEW_SUBMISSION_JSON_SCHEMA,
        CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE,
      ),
    ).toEqual([]);
    // A prompt saved before the upgrade can still submit a full report.
    expect(
      validateWorkflowJsonSchema(
        CONSOLIDATED_REVIEW_SUBMISSION_JSON_SCHEMA,
        CONSOLIDATED_REVIEW_EXAMPLE,
      ),
    ).toEqual([]);
  });

  test("is offered only to a slot that carries the lists", () => {
    const sources = { [CONSOLIDATED_REVIEW_EXAMPLE_SOURCE_IDS.issue]: "issue" as const };
    expect(
      workflowResultProviderSchema("consolidated-review", {
        context: { type: "consolidated-review", sources, scope: MERGED },
      }),
    ).toBe(CONSOLIDATED_REVIEW_SUBMISSION_JSON_SCHEMA);
    expect(
      workflowResultProviderSchema("consolidated-review", {
        context: { type: "consolidated-review", sources },
      }),
    ).toBe(STRUCTURED_REVIEW_REPORT_JSON_SCHEMA);
  });
});

describe("the OpenCode broker's consolidated review tool", () => {
  test("serves every slot: takes the report with or without the lists", async () => {
    const schemas = new Map<string, unknown>();
    const server = {
      registerTool(name: string, meta: { inputSchema: unknown }) {
        schemas.set(name, meta.inputSchema);
      },
    };
    const { registerWorkflowResultBrokerTools } = await import("./workflow-result-tools.js");
    registerWorkflowResultBrokerTools(server as never, {} as never, {
      environmentId: "env-1",
      projectId: "project-1",
    });
    const accepts = (result: unknown) => {
      const outcome = (
        schemas.get("submit_consolidated_review") as {
          "~standard": { validate: (value: unknown) => { issues?: unknown } };
        }
      )["~standard"].validate({
        resultKey: crypto.randomUUID(),
        capability: "c".repeat(32),
        result,
      });
      return !outcome.issues;
    };
    expect(accepts(CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE)).toBe(true);
    expect(accepts(CONSOLIDATED_REVIEW_EXAMPLE)).toBe(true);
    // Everything else is still the report's shape.
    expect(accepts({ ...CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE, verdict: undefined })).toBe(false);
  });
});

describe("consolidationResultContext", () => {
  test("merges the completed reviewers' lists and says the backend fills them in", () => {
    const reviewers = [
      reviewer("r1", reportWith({ filesReviewed: ["src/a.ts"] })),
      reviewer("r2", reportWith({ filesReviewed: ["src/failed.ts"] }), "failed"),
      reviewer("r3", reportWith({ filesReviewed: ["src/b.ts"] })),
    ];
    const context = consolidationResultContext(reviewers);
    expect(context.scope?.filesReviewed).toEqual(["src/a.ts", "src/b.ts"]);
    expect(consolidationScopeFilledByBackend(reviewers)).toBe(true);
  });

  test("carries no lists, and the prompt keeps them, when the merge does not fit", () => {
    const filesReviewed = Array.from({ length: 2_000 }, (_, i) => `src/generated/file-${i}.ts`);
    const reviewers = [reviewer("r1", reportWith({ filesReviewed }))];
    expect(consolidationResultContext(reviewers).scope).toBeUndefined();
    expect(consolidationScopeFilledByBackend(reviewers)).toBe(false);
  });
});

describe("the consolidation prompt", () => {
  const reports = [
    {
      reviewerId: "r1",
      agent: "claude",
      model: "haiku",
      report: reportWith({ filesReviewed: ["src/a.ts"] }),
    },
  ];

  test.each([true, false])(
    "matches the checklist and template to the slot (filled=%s)",
    (filled) => {
      const prompt = createMultiReviewConsolidationPrompt({
        targetBranch: "main",
        reports,
        scopeFilledByBackend: filled,
      });
      const expectedSchema = filled
        ? CONSOLIDATED_REVIEW_SUBMISSION_JSON_SCHEMA
        : STRUCTURED_REVIEW_REPORT_JSON_SCHEMA;
      const { required } = expectedSchema.properties.reviewScope;
      expect(prompt).toContain(`\`reviewScope\` { ${required.join(", ")} }`);
      expect(prompt.includes("The backend fills in `reviewScope.filesReviewed`")).toBe(filled);
      const template = prompt.match(/```json\n([\s\S]*?)\n```/)?.[1];
      const example = JSON.parse(template!);
      expect(Object.keys(example.reviewScope)).toEqual([...required]);
      expect(validateWorkflowJsonSchema(expectedSchema, example)).toEqual([]);
    },
  );
});

describe("WorkflowResultService with merged scope lists", () => {
  let dataDir: string;
  let service: WorkflowResultService;
  const scope = { environmentId: "env-1", projectId: "project-1" };
  const sources = {
    [CONSOLIDATED_REVIEW_EXAMPLE_SOURCE_IDS.issue]: "issue" as const,
    [CONSOLIDATED_REVIEW_EXAMPLE_SOURCE_IDS.coverageGap]: "coverage-gap" as const,
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-consolidation-scope-"));
    service = new WorkflowResultService(dataDir);
  });

  afterEach(async () => {
    service.closeStorage();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function prepare(context: Parameters<WorkflowResultService["prepare"]>[0]["context"]) {
    const resultKey = crypto.randomUUID();
    await service.prepare({
      resultKey,
      kind: "consolidated-review",
      ...scope,
      provider: "claude",
      context,
    });
    return resultKey;
  }

  test("accepts a report without the lists and stores the complete report", async () => {
    const resultKey = await prepare({ type: "consolidated-review", sources, scope: MERGED });
    const binding = await service.binding(scope, resultKey);
    expect(workflowResultProviderSchema("consolidated-review", binding?.slot ?? {})).toBe(
      CONSOLIDATED_REVIEW_SUBMISSION_JSON_SCHEMA,
    );

    const submission = await service.submit(
      scope,
      resultKey,
      CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE,
    );
    expect(submission).toMatchObject({ ok: true, duplicate: false });
    const stored = await service.structured<StructuredReviewReport>(resultKey);
    expect(stored?.ok).toBe(true);
    if (!stored?.ok) return;
    expect(safeParseStructuredReviewReport(stored.value).success).toBe(true);
    expect(stored.value.reviewScope.filesReviewed).toEqual(MERGED.filesReviewed);
    expect(stored.value.reviewScope.commandsRun).toEqual(MERGED.commandsRun);
    // A resend of the same submission is still the same submission.
    expect(
      await service.submit(scope, resultKey, CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE),
    ).toMatchObject({ ok: true, duplicate: true });
  });

  test("validates and commits by digest without the lists", async () => {
    const resultKey = await prepare({ type: "consolidated-review", sources, scope: MERGED });
    const validation = await service.validate(
      scope,
      resultKey,
      CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE,
    );
    expect(validation).toMatchObject({ ok: true, valid: true });
    if (!validation.ok || !validation.validatedDigest) throw new Error("expected a digest");
    expect(
      await service.submitValidated(scope, resultKey, validation.validatedDigest),
    ).toMatchObject({ ok: true });
    const stored = await service.structured<StructuredReviewReport>(resultKey);
    expect(stored?.ok && stored.value.reviewScope.filesSkipped).toEqual(MERGED.filesSkipped);
  });

  test("a slot without the lists still needs the full report", async () => {
    const resultKey = await prepare({ type: "consolidated-review", sources });
    expect((await service.binding(scope, resultKey))?.slot).toBeUndefined();
    expect(
      await service.submit(scope, resultKey, CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE),
    ).toMatchObject({ ok: false, error: { code: "invalid_result" } });
    expect(await service.submit(scope, resultKey, CONSOLIDATED_REVIEW_EXAMPLE)).toMatchObject({
      ok: true,
    });
  });

  test("an open slot from an older backend takes the lists when it is prepared again", async () => {
    const resultKey = await prepare({ type: "consolidated-review", sources });
    await service.prepare({
      resultKey,
      kind: "consolidated-review",
      ...scope,
      provider: "claude",
      context: { type: "consolidated-review", sources, scope: MERGED },
    });
    expect((await service.binding(scope, resultKey))?.slot?.context).toMatchObject({
      scope: MERGED,
    });
    expect(
      await service.submit(scope, resultKey, CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE),
    ).toMatchObject({ ok: true });
  });

  test.each(["claude", "codex"] as const)(
    "serves the upgraded slot through the %s per-slot validate and submit tools",
    async (provider) => {
      const { McpServer } = await import("@modelcontextprotocol/server");
      const { callToolInProcess } = await import("./mcp-in-process.js");
      const { registerWorkflowResultTools } = await import("./workflow-result-tools.js");
      const resultKey = crypto.randomUUID();
      const input = {
        resultKey,
        kind: "consolidated-review",
        provider,
        ...scope,
        context: { type: "consolidated-review", sources },
      } as const;
      await service.prepare(input);
      await service.prepare({ ...input, context: { ...input.context, scope: MERGED } });
      const binding = await service.binding(scope, resultKey);
      expect(binding?.provider).toBe(provider);
      expect(binding?.slot?.context).toMatchObject({ scope: MERGED });
      const factory = () => {
        const server = new McpServer({ name: "scoped-consolidation-test", version: "1.0.0" });
        registerWorkflowResultTools(server, service, {
          ...scope,
          kind: input.kind,
          workflowResultKey: resultKey,
          slot: binding?.slot,
        });
        return server;
      };
      for (const result of [CONSOLIDATED_REVIEW_EXAMPLE, CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE]) {
        const validated = await callToolInProcess(factory, "validate_workflow_result", {
          resultKey,
          result,
        });
        expect(validated.isError).toBe(false);
        expect(JSON.parse(validated.text)).toMatchObject({ ok: true, valid: true });
      }
      const submitted = await callToolInProcess(factory, "submit_consolidated_review", {
        resultKey,
        result:
          provider === "claude"
            ? CONSOLIDATED_REVIEW_EXAMPLE
            : CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE,
      });
      expect(submitted.isError).toBe(false);
      expect(JSON.parse(submitted.text)).toMatchObject({ ok: true });
      const stored = await service.structured<StructuredReviewReport>(resultKey);
      expect(stored?.ok && stored.value.reviewScope.commandsRun).toEqual(MERGED.commandsRun);
    },
  );

  test("an accepted slot keeps its own context, and other sources are another attempt", async () => {
    const resultKey = await prepare({ type: "consolidated-review", sources });
    await service.submit(scope, resultKey, CONSOLIDATED_REVIEW_EXAMPLE);
    const again = {
      resultKey,
      kind: "consolidated-review" as const,
      ...scope,
      provider: "claude" as const,
      context: { type: "consolidated-review" as const, sources, scope: MERGED },
    };
    await service.prepare(again);
    expect((await service.binding(scope, resultKey))?.slot).toBeUndefined();
    await expect(
      service.prepare({
        ...again,
        context: { type: "consolidated-review", sources: { other: "issue" }, scope: MERGED },
      }),
    ).rejects.toThrow("already bound to another attempt");
  });

  test("selects the full tool contract when a structured-output reviewer used placeholder scope text", async () => {
    const source = {
      ...reportWith({ commandsRun: [{ command: "bun test", result: "passed", summary: "TBD" }] }),
      issues: [],
      testCoverageGaps: [],
    };
    const parsed = parseStructuredReportResult({
      ok: true,
      provider: "claude",
      requestId: "legacy-review",
      value: source,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("expected a legacy reviewer report");
    const context = consolidationResultContext([reviewer("legacy-review", parsed.data)]);
    expect(context.scope).toBeUndefined();
    const resultKey = await prepare(context);
    const binding = await service.binding(scope, resultKey);
    expect(workflowResultProviderSchema("consolidated-review", binding?.slot ?? {})).toBe(
      STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
    );
    expect(await service.validate(scope, resultKey, source)).toMatchObject({
      ok: false,
      error: {
        issues: [{ path: "$.reviewScope.commandsRun[0].summary", code: "placeholder_value" }],
      },
    });
    const corrected = {
      ...source,
      reviewScope: {
        ...source.reviewScope,
        commandsRun: [{ command: "bun test", result: "passed", summary: "Suite passed." }],
      },
    };
    expect(await service.submit(scope, resultKey, corrected)).toMatchObject({ ok: true });
  });

  test.each(["constructor", "toString", "__proto__"])(
    "refuses an unknown own scope key %s",
    async (key) => {
      const resultKey = await prepare({ type: "consolidated-review", sources, scope: MERGED });
      const result = {
        ...CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE,
        reviewScope: { ...CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE.reviewScope, [key]: "extra" },
      };
      expect(await service.validate(scope, resultKey, result)).toMatchObject({
        ok: false,
        error: { issues: [{ path: `$.reviewScope.${key}`, code: "unknown_field" }] },
      });
    },
  );

  test.each([
    { kind: "review-report" },
    { provider: "codex" },
    { projectId: "another-project" },
    { environmentId: "another-environment" },
    { expectedStoryId: "another-story" },
    { schema: { type: "object" } },
  ] as const)("preserves the legacy binding when re-preparation changes %j", async (change) => {
    const resultKey = await prepare({ type: "consolidated-review", sources });
    await expect(
      service.prepare({
        resultKey,
        kind: "consolidated-review",
        provider: "claude",
        ...scope,
        context: { type: "consolidated-review", sources, scope: MERGED },
        ...change,
      }),
    ).rejects.toThrow("already bound to another attempt");
    expect(await service.binding(scope, resultKey)).toEqual({
      kind: "consolidated-review",
      provider: "claude",
    });
  });

  test("an upgraded slot refuses a different scope and requires fresh validation across service instances", async () => {
    const resultKey = await prepare({ type: "consolidated-review", sources });
    const validation = await service.validate(scope, resultKey, CONSOLIDATED_REVIEW_EXAMPLE);
    if (!validation.ok || !validation.validatedDigest) throw new Error("expected a digest");
    const peer = new WorkflowResultService(dataDir);
    const upgraded = {
      resultKey,
      kind: "consolidated-review",
      provider: "claude",
      ...scope,
      schema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
      context: { type: "consolidated-review", sources, scope: MERGED },
    } as const;
    try {
      await peer.prepare(upgraded);
      await expect(
        peer.prepare({
          ...upgraded,
          context: { ...upgraded.context, scope: { ...MERGED, filesReviewed: [] } },
        }),
      ).rejects.toThrow("already bound to another attempt");
      expect(
        await service.submitValidated(scope, resultKey, validation.validatedDigest),
      ).toMatchObject({
        ok: false,
        error: { issues: [{ code: "unknown_validation" }] },
      });
      expect(service.heldValidation(resultKey)).toBeUndefined();
      const fresh = await service.validate(
        scope,
        resultKey,
        CONSOLIDATED_REVIEW_SUBMISSION_EXAMPLE,
      );
      if (!fresh.ok || !fresh.validatedDigest) throw new Error("expected a fresh digest");
      expect(await service.submitValidated(scope, resultKey, fresh.validatedDigest)).toMatchObject({
        ok: true,
      });
      const stored = await service.structured<StructuredReviewReport>(resultKey);
      expect(stored?.ok && stored.value.reviewScope.filesReviewed).toEqual(MERGED.filesReviewed);
    } finally {
      peer.closeStorage();
    }
  });

  test("does not hold a validation that finishes after the scope was upgraded", async () => {
    const resultKey = await prepare({ type: "consolidated-review", sources });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const remove = service.addAcceptanceCheck("consolidated-review", async () => {
      entered.resolve();
      await resume.promise;
      return null;
    });
    const validation = service.validate(scope, resultKey, CONSOLIDATED_REVIEW_EXAMPLE);
    try {
      await Promise.race([entered.promise, validation]);
      await service.prepare({
        resultKey,
        kind: "consolidated-review",
        provider: "claude",
        ...scope,
        context: { type: "consolidated-review", sources, scope: MERGED },
      });
    } finally {
      resume.resolve();
      remove();
    }
    expect(await validation).toMatchObject({ ok: false, error: { code: "invalid_result" } });
    expect(service.heldValidation(resultKey)).toBeUndefined();
  });
});
