import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verificationCriterionResults } from "@orkestrator/protocol/build-pipeline";
import { parseFeaturePlannerState } from "@orkestrator/protocol/feature-planning";
import { safeParseStructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { WORKFLOW_RESULT_KINDS } from "@orkestrator/protocol/workflow-results";
import {
  validateWorkflowJsonSchema,
  validateWorkflowResult,
  workflowResultJsonSchema,
} from "./workflow-result-contracts.js";
import { WorkflowResultService } from "./workflow-result-service.js";

const report: StructuredReviewReport = {
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

describe("workflow result contract validation", () => {
  test("every kind exposes a model-facing schema", () => {
    for (const kind of WORKFLOW_RESULT_KINDS) {
      const schema = workflowResultJsonSchema(kind);
      expect(schema).toBeTruthy();
      expect(Object.keys(schema as Record<string, unknown>).length).toBeGreaterThan(0);
    }
  });

  test("a valid result for every kind is accepted with no diagnostics", () => {
    const valid: Record<string, unknown> = {
      "feature-plan-state": { phase: "collecting", title: "Feature", summary: "Summary." },
      "story-refinement": {
        storyId: "story-1",
        title: "Story",
        description: "Description.",
        acceptanceCriteria: ["Criterion"],
      },
      "review-report": report,
      "consolidated-review": report,
      "verification-result": { complete: false, rationale: "Validation did not pass." },
    };
    for (const [kind, value] of Object.entries(valid)) {
      expect(validateWorkflowResult(kind as (typeof WORKFLOW_RESULT_KINDS)[number], value)).toEqual(
        [],
      );
    }
  });

  test("a current turn accepting a legacy verdict exposes omitted criteria as not checked", () => {
    const verdict = { complete: true, rationale: "Verification finished." };
    expect(validateWorkflowResult("verification-result", verdict)).toEqual([]);
    expect(
      verificationCriterionResults([{ id: "ac-9", text: "Must be verified" }], verdict),
    ).toEqual([
      { id: "ac-9", status: "not-checked", evidence: "Verify did not report on this criterion." },
    ]);
  });

  test("an explicit negative outcome is a valid result, not a rejection", () => {
    expect(
      validateWorkflowResult("verification-result", {
        complete: false,
        rationale: "Two checks failed.",
      }),
    ).toEqual([]);
    const negative = validateWorkflowResult("review-report", report);
    expect(negative).toEqual([]);
  });

  test("placeholder narrative fields are rejected for every final result shape", () => {
    const cases = [
      ["feature-plan-state", { phase: "collecting", title: "probe", summary: "" }, "$.title"],
      [
        "story-refinement",
        {
          storyId: "story-1",
          title: "probe",
          description: "Final description.",
          acceptanceCriteria: ["Criterion"],
        },
        "$.title",
      ],
      [
        "validation-plan",
        { headRef: "a".repeat(40), commands: [], limitations: ["probe"] },
        "$.limitations[0]",
      ],
      [
        "review-preparation",
        { validation: [], uncommittedFiles: [], limitations: ["This is a probe."] },
        "$.limitations[0]",
      ],
      ["review-report", { ...report, reviewSummary: "probe" }, "$.reviewSummary"],
      [
        "fix-result",
        {
          complete: true,
          summary: "probe",
          filesChanged: [],
          commandsRun: [],
          notes: [],
          limitations: [],
        },
        "$.summary",
      ],
      ["verification-result", { complete: true, rationale: "probe" }, "$.rationale"],
      [
        "pr-result",
        { status: "created", url: "https://github.com/org/repo/pull/1", summary: "probe" },
        "$.summary",
      ],
    ] as const;

    for (const [kind, value, path] of cases) {
      expect(validateWorkflowResult(kind, value)).toContainEqual(
        expect.objectContaining({ path, code: "placeholder_value" }),
      );
    }
  });

  test("placeholder matching is whole-field and leaves ordinary prose unchanged", () => {
    const legitimate = {
      ...report,
      whatChanged: {
        ...report.whatChanged,
        overview: "The test harness now rejects a placeholder before accepting the report.",
      },
      reviewScope: {
        ...report.reviewScope,
        limitations: ["A sample project was unavailable, so the integration suite was not run."],
      },
      reviewSummary: "The placeholder guard is covered by focused tests.",
    };
    expect(validateWorkflowResult("review-report", legitimate)).toEqual([]);

    const nestedProbe = {
      ...report,
      reviewScope: { ...report.reviewScope, limitations: ["placeholder only"] },
    };
    expect(validateWorkflowResult("review-report", nestedProbe)).toContainEqual(
      expect.objectContaining({
        path: "$.reviewScope.limitations[0]",
        code: "placeholder_value",
      }),
    );
  });

  test("filler used to shrink a payload past a failing call is rejected as a placeholder", () => {
    const shrunk = {
      ...report,
      whatChanged: { ...report.whatChanged, overview: "x", before: "x", after: "x" },
      summaryOfChange: "XX",
      reviewSummary: "x",
    };
    const issues = validateWorkflowResult("review-report", shrunk);
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "$.whatChanged.overview",
        "$.whatChanged.before",
        "$.whatChanged.after",
        "$.summaryOfChange",
        "$.reviewSummary",
      ]),
    );
    expect(issues.every((issue) => issue.code === "placeholder_value")).toBe(true);
    // A longer value that merely starts with the letter is ordinary prose.
    expect(
      validateWorkflowResult("review-report", {
        ...report,
        reviewSummary: "x-axis labels reviewed",
      }),
    ).toEqual([]);
  });

  test("wrong types, unknown properties, and enum confusion are reported by path", () => {
    const issues = validateWorkflowResult("feature-plan-state", {
      phase: "stories ",
      title: 12,
      summary: "",
      unexpected: true,
    });
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain("$.phase");
    expect(paths).toContain("$.unexpected");
    expect(issues.some((issue) => issue.code === "invalid_enum")).toBe(true);
    expect(issues.some((issue) => issue.code === "unknown_field")).toBe(true);
  });

  test("a missing required field is reported rather than defaulted", () => {
    const issues = validateWorkflowResult("story-refinement", {
      storyId: "story-1",
      title: "Story",
    });
    expect(issues.some((issue) => issue.path === "$.description")).toBe(true);
    expect(issues.every((issue) => issue.code === "missing_field")).toBe(true);
  });

  test("diagnostics stay bounded in count and per-issue length", () => {
    const wide: Record<string, unknown> = {
      phase: "collecting",
      title: "T",
      summary: "S",
    };
    for (let index = 0; index < 200; index += 1) wide[`extra${index}`] = index;
    const issues = validateWorkflowResult("feature-plan-state", wide);
    expect(issues.length).toBeLessThanOrEqual(32);
    for (const issue of issues) {
      expect(issue.path.length).toBeLessThanOrEqual(256);
      expect(issue.message.length).toBeLessThanOrEqual(512);
    }
  });

  test("excessive nesting is refused instead of walked", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 64; index += 1) deep = { nested: deep };
    const schema = {
      type: "object",
      properties: { nested: {} },
    } as const;
    let deepSchema: Record<string, unknown> = { type: "object", properties: {} };
    let cursor = deepSchema;
    for (let index = 0; index < 64; index += 1) {
      const next: Record<string, unknown> = { type: "object", properties: {} };
      (cursor.properties as Record<string, unknown>).nested = next;
      cursor = next;
    }
    void schema;
    const issues = validateWorkflowJsonSchema(deepSchema, deep);
    expect(issues.some((issue) => issue.code === "too_deep")).toBe(true);
  });

  test("a legacy tagged payload and a tool payload accept the same domain result", () => {
    const value = {
      phase: "stories",
      title: "Feature",
      summary: "Summary.",
      stories: [
        { id: "s1", title: "Story", description: "Description.", acceptanceCriteria: ["One"] },
      ],
    };
    const tagged = `prose\n<feature_planner_state>\n${JSON.stringify(value)}\n</feature_planner_state>`;
    expect(validateWorkflowResult("feature-plan-state", value)).toEqual([]);
    expect(parseFeaturePlannerState(tagged)).toEqual(
      parseFeaturePlannerState(
        `<feature_planner_state>${JSON.stringify(value)}</feature_planner_state>`,
      ),
    );
  });

  test("accepting a report does not rewrite its limitations, verdict, or confidence", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ork-workflow-result-tools-"));
    try {
      const service = new WorkflowResultService(dataDir);
      const resultKey = crypto.randomUUID();
      const scope = { environmentId: "env-1", projectId: "project-1" };
      await service.prepare({ resultKey, kind: "review-report", ...scope, provider: "codex" });
      const submission = await service.submit(scope, resultKey, report);
      expect(submission.ok).toBe(true);
      const stored = await service.structured<StructuredReviewReport>(resultKey);
      if (!stored?.ok) throw new Error("Expected an accepted report");
      // Acceptance stores the model's judgment verbatim. Nothing here may
      // normalize a limitation away or soften a negative verdict.
      expect(stored.value).toEqual(report);
      expect(stored.value.reviewScope.limitations).toEqual([
        "Could not run the integration suite.",
      ]);
      expect(stored.value.verdict).toEqual({ ready: "no", reasoning: "The suite did not run." });
      expect(safeParseStructuredReviewReport(stored.value).success).toBe(true);
      service.closeStorage();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("workflow result context fencing", () => {
  let dataDir: string;
  let service: WorkflowResultService;
  const scope = { environmentId: "env-1", projectId: "project-1" };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-workflow-result-tools-"));
    service = new WorkflowResultService(dataDir);
  });

  afterEach(async () => {
    service.closeStorage();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a consolidated finding citing an unknown source is rejected", async () => {
    const resultKey = crypto.randomUUID();
    await service.prepare({
      resultKey,
      kind: "consolidated-review",
      ...scope,
      provider: "claude",
      context: { type: "consolidated-review", sources: { "reviewer-1:0": "issue" } },
    });
    const invented = {
      ...report,
      issues: [
        {
          severity: "medium",
          title: "Invented",
          description: "Cites a source that no reviewer produced.",
          location: "src/a.ts",
          recommendation: "None.",
          confidence: "medium",
          reviewSourceIds: ["reviewer-9:4"],
        },
      ],
    };
    const rejected = await service.submit(scope, resultKey, invented);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe("invalid_result");
      expect(rejected.error.nextAction).toBe("correct");
    }
  });

  test("an obvious consolidated-review probe is rejected before it can become authoritative", async () => {
    const resultKey = crypto.randomUUID();
    await service.prepare({
      resultKey,
      kind: "consolidated-review",
      ...scope,
      provider: "cursor",
      context: { type: "consolidated-review", sources: { "reviewer-1:0": "issue" } },
    });
    const probe = {
      ...report,
      whatChanged: {
        overview: "probe",
        before: "probe",
        after: "probe",
        keyCodeChanges: [],
        userImpact: "probe",
      },
      riskProfile: { ...report.riskProfile, reasoning: "probe" },
      verdict: { ready: "yes", reasoning: "probe" },
      summaryOfChange: "probe",
      reviewSummary: "probe",
    };

    const validation = await service.validate(scope, resultKey, probe);
    expect(validation).toMatchObject({
      ok: false,
      error: {
        code: "invalid_result",
      },
    });
    expect(
      !validation.ok &&
        validation.error.issues?.some((issue) => issue.code === "placeholder_value"),
    ).toBe(true);
    expect(await service.submit(scope, resultKey, probe)).toMatchObject({
      ok: false,
      error: { code: "invalid_result" },
    });
    expect(await service.projection(resultKey)).toBe("correcting");
  });

  test("a review-report probe is rejected without requiring consolidation context", async () => {
    const resultKey = crypto.randomUUID();
    await service.prepare({
      resultKey,
      kind: "review-report",
      ...scope,
      provider: "cursor",
    });
    const probe = { ...report, reviewSummary: "probe" };

    expect(await service.submit(scope, resultKey, probe)).toMatchObject({
      ok: false,
      error: {
        code: "invalid_result",
        issues: [expect.objectContaining({ path: "$.reviewSummary", code: "placeholder_value" })],
      },
    });
    expect(await service.projection(resultKey)).toBe("correcting");
  });

  test("a submission with no accepted slot is denied rather than fabricated", async () => {
    const denied = await service.submit(scope, crypto.randomUUID(), { phase: "collecting" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("capability_denied");
  });

  test("status for an unknown key reports absence without recommending redispatch", async () => {
    expect(await service.status(scope, crypto.randomUUID())).toBeNull();
  });
});

describe("workflow result broker tools", () => {
  test("broker validation schema rejects bad capabilities and the handler authorizes and forwards JSON", async () => {
    type Registration = {
      meta: { inputSchema: { safeParse(value: unknown): { success: boolean } } };
      handler: (args: Record<string, unknown>) => Promise<unknown>;
    };
    const registrations = new Map<string, Registration>();
    const server = {
      registerTool(name: string, meta: Registration["meta"], handler: Registration["handler"]) {
        registrations.set(name, { meta, handler });
      },
    };
    const resultKey = crypto.randomUUID();
    const capability = "c".repeat(32);
    const authorizationCalls: unknown[][] = [];
    const validationCalls: unknown[][] = [];
    let failValidation = false;
    const workflowResults = {
      async authenticateCapability(token: string) {
        authorizationCalls.push([token]);
        return token === capability ? { ...scope, workflowResultKey: resultKey } : null;
      },
      async validate(...args: unknown[]) {
        validationCalls.push(args);
        if (failValidation) throw new Error("disk unavailable");
        return { ok: true, valid: true };
      },
      async binding() {
        return { kind: "review-report", provider: "opencode" };
      },
      async submit() {
        return { ok: true, lifecycle: "accepted" };
      },
      async status() {
        return null;
      },
    };
    const { registerWorkflowResultBrokerTools } = await import("./workflow-result-tools.js");
    const scope = { environmentId: "env-1", projectId: "project-1" };
    registerWorkflowResultBrokerTools(server as never, workflowResults as never, scope);
    const registration = registrations.get("validate_workflow_result");
    if (!registration) throw new Error("missing validation tool");

    expect(registration.meta.inputSchema.safeParse({ resultKey, result: {} }).success).toBe(false);
    expect(
      registration.meta.inputSchema.safeParse({ resultKey, capability: "short", result: {} })
        .success,
    ).toBe(false);
    expect(
      registration.meta.inputSchema.safeParse({ resultKey, capability, result: undefined }).success,
    ).toBe(false);
    const result = { nested: [true, null, 1, "value"] };
    expect(registration.meta.inputSchema.safeParse({ resultKey, capability, result }).success).toBe(
      true,
    );

    expect(
      await registration.handler({
        resultKey: crypto.randomUUID(),
        capability,
        result,
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "invalid_result", nextAction: "correct" } },
    });
    expect(validationCalls).toHaveLength(0);

    expect(await registration.handler({ resultKey, capability, result })).toMatchObject({
      structuredContent: { ok: true, valid: true },
    });
    expect(authorizationCalls.at(-1)).toEqual([capability]);
    expect(validationCalls).toEqual([[scope, resultKey, result]]);

    failValidation = true;
    expect(await registration.handler({ resultKey, capability, result })).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "storage_unavailable" } },
    });
  });

  test("attempt-scoped tools turn a different result key into correctable feedback before service access", async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool(
        name: string,
        _meta: unknown,
        handler: (args: Record<string, unknown>) => Promise<unknown>,
      ) {
        handlers.set(name, handler);
      },
    };
    let serviceCalls = 0;
    const workflowResults = {
      async validate() {
        serviceCalls += 1;
        return { ok: true, valid: true };
      },
      async submit() {
        serviceCalls += 1;
        return { ok: true, lifecycle: "accepted" };
      },
      async status() {
        serviceCalls += 1;
        return null;
      },
    };
    let findingCalls = 0;
    const findings = {
      accepts() {
        return true;
      },
      async report() {
        findingCalls += 1;
        return { ok: true, findingId: "f-1", duplicate: false, provisionalCount: 1, limit: 10 };
      },
    };
    const boundKey = crypto.randomUUID();
    // The slip that stranded a real run: one digit of the key mistyped.
    const mistyped = `${boundKey.slice(0, -1)}${boundKey.endsWith("0") ? "1" : "0"}`;
    const { registerWorkflowResultTools } = await import("./workflow-result-tools.js");
    registerWorkflowResultTools(
      server as never,
      workflowResults as never,
      {
        environmentId: "env-1",
        projectId: "project-1",
        workflowResultKey: boundKey,
        kind: "review-report",
      },
      findings as never,
    );
    const calls: Array<[string, Record<string, unknown>]> = [
      ["validate_workflow_result", { resultKey: mistyped, result: report }],
      ["submit_review_report", { resultKey: mistyped, result: report }],
      ["get_workflow_result_status", { resultKey: mistyped }],
    ];
    for (const [name, args] of calls) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`missing ${name}`);
      expect(await handler(args)).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: {
            code: "invalid_result",
            nextAction: "correct",
            message: expect.stringContaining(boundKey),
            issues: [{ path: "$.resultKey", code: "result_key_mismatch" }],
          },
        },
      });
    }
    const reportFinding = handlers.get("report_finding");
    if (!reportFinding) throw new Error("missing report_finding");
    expect(await reportFinding({ resultKey: mistyped, finding: {} })).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          code: "invalid_finding",
          nextAction: "correct",
          message: expect.stringContaining(boundKey),
        },
      },
    });
    expect(serviceCalls).toBe(0);
    expect(findingCalls).toBe(0);
  });

  test("status reports capability rejection, unavailability, and storage failure", async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool(
        name: string,
        _meta: unknown,
        handler: (args: Record<string, unknown>) => Promise<unknown>,
      ) {
        handlers.set(name, handler);
      },
    };
    const workflowResults = {
      async authenticateCapability(capability: string) {
        if (capability === "denied") return null;
        if (capability === "storage") throw new Error("disk full");
        return { environmentId: "env-1", projectId: "project-1", workflowResultKey: "known-key" };
      },
      async status() {
        return null;
      },
      async binding() {
        return { kind: "review-report", provider: "opencode" };
      },
      async submit() {
        return { ok: true, lifecycle: "accepted" };
      },
      async validate() {
        return { ok: true, valid: true };
      },
    };
    const { registerWorkflowResultBrokerTools } = await import("./workflow-result-tools.js");
    registerWorkflowResultBrokerTools(server as never, workflowResults as never, {
      environmentId: "env-1",
      projectId: "project-1",
    });
    const status = handlers.get("get_workflow_result_status");
    if (!status) throw new Error("missing status tool");
    expect(await status({ resultKey: "known-key", capability: "denied" })).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "capability_denied" } },
    });
    expect(await status({ resultKey: "known-key", capability: "ok" })).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "result_status_unavailable" } },
    });
    expect(await status({ resultKey: "known-key", capability: "storage" })).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "storage_unavailable" } },
    });
  });

  test("a valid capability presented to the wrong submit tool is denied", async () => {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool(
        name: string,
        _meta: unknown,
        handler: (args: Record<string, unknown>) => Promise<unknown>,
      ) {
        handlers.set(name, handler);
      },
    };
    const workflowResults = {
      async authenticateCapability() {
        return { environmentId: "env-1", projectId: "project-1", workflowResultKey: "known-key" };
      },
      async binding() {
        return { kind: "review-report", provider: "opencode" };
      },
      async submit() {
        return { ok: true, lifecycle: "accepted" };
      },
      async validate() {
        return { ok: true, valid: true };
      },
      async status() {
        return null;
      },
    };
    const { registerWorkflowResultBrokerTools } = await import("./workflow-result-tools.js");
    registerWorkflowResultBrokerTools(server as never, workflowResults as never, {
      environmentId: "env-1",
      projectId: "project-1",
    });
    const submitFix = handlers.get("submit_fix_result");
    if (!submitFix) throw new Error("missing submit_fix_result");
    expect(
      await submitFix({
        resultKey: "known-key",
        capability: "ok",
        result: { complete: true },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "capability_denied" } },
    });
  });
});

describe("broker result key correction with signed capabilities", () => {
  type Handler = (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
  const scope = { environmentId: "env-1", projectId: "project-1" };
  const toolNames = [
    "submit_review_report",
    "report_finding",
    "validate_workflow_result",
    "get_workflow_result_status",
  ];
  const finding = {
    severity: "P2",
    confidence: 85,
    category: "correctness",
    title: "A finding",
    file: "src/review.ts",
    line: 12,
    symbol: "review",
    description: "The clock resets when the step restarts.",
    evidence: "restartStep clears stepRuntimes",
    suggestion: "Keep the previous runtime.",
    verification: "Restart a step and read its runtime.",
  };
  let dataDir: string;
  let service: WorkflowResultService;
  let handlers: Map<string, Handler>;
  let resultKey: string;
  let otherKey: string;
  let capability: string;
  let findingCalls: unknown[][];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-broker-key-correction-"));
    service = new WorkflowResultService(dataDir);
    await service.initializeCapabilityIdentity();
    resultKey = crypto.randomUUID();
    otherKey = crypto.randomUUID();
    for (const key of [resultKey, otherKey]) {
      await service.prepare({
        ...scope,
        resultKey: key,
        kind: "review-report",
        provider: "opencode",
      });
    }
    capability = service.capabilityToken(scope, resultKey);
    handlers = new Map();
    findingCalls = [];
    const { registerWorkflowResultBrokerTools } = await import("./workflow-result-tools.js");
    registerWorkflowResultBrokerTools(
      {
        registerTool(name: string, _meta: unknown, handler: Handler) {
          handlers.set(name, handler);
        },
      } as never,
      service,
      scope,
      {
        accepts() {
          return true;
        },
        async report(...args) {
          findingCalls.push(args);
          return { ok: true, findingId: "f-1", duplicate: false, provisionalCount: 1, limit: 10 };
        },
      },
    );
  });

  afterEach(async () => {
    service.closeStorage();
    await rm(dataDir, { recursive: true, force: true });
  });

  test.each(toolNames)(
    "%s corrects another attempt's key without accessing that attempt",
    async (name) => {
      const handler = handlers.get(name)!;
      const before = await service.status(scope, resultKey);
      const otherBefore = await service.status(scope, otherKey);
      const response = await handler({ resultKey: otherKey, capability, result: report, finding });
      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: {
            code: name === "report_finding" ? "invalid_finding" : "invalid_result",
            nextAction: "correct",
            message: expect.stringContaining(resultKey),
          },
        },
      });
      expect(JSON.stringify(response)).not.toContain(otherKey);
      expect(JSON.stringify(response)).not.toContain(capability);
      expect(await service.status(scope, resultKey)).toEqual(before);
      expect(await service.status(scope, otherKey)).toEqual(otherBefore);
      expect(findingCalls).toHaveLength(0);

      // Correcting the key makes the original call usable without a new capability.
      const corrected = await handler({ resultKey, capability, result: report, finding });
      expect(corrected.isError).toBeUndefined();
      if (name === "report_finding") {
        expect(findingCalls).toEqual([[scope, resultKey, finding]]);
      }
      expect(await service.status(scope, otherKey)).toEqual(otherBefore);
    },
  );

  test.each([
    "tampered signature",
    "tampered embedded key",
    "unknown attempt",
    "foreign environment",
    "foreign project",
    "provider mismatch",
  ])("%s stays denied for both matching and mismatched keys", async (failure) => {
    let deniedKey = resultKey;
    let deniedCapability = capability;
    if (failure === "tampered signature") {
      deniedCapability = capability.slice(0, -1) + (capability.endsWith("A") ? "B" : "A");
    } else if (failure === "tampered embedded key") {
      deniedCapability = otherKey + capability.slice(resultKey.length);
    } else {
      deniedKey = crypto.randomUUID();
      const deniedScope = {
        environmentId: failure === "foreign environment" ? "other-env" : scope.environmentId,
        projectId: failure === "foreign project" ? "other-project" : scope.projectId,
      };
      if (failure !== "unknown attempt") {
        await service.prepare({
          ...deniedScope,
          resultKey: deniedKey,
          kind: "review-report",
          provider: failure === "provider mismatch" ? "codex" : "opencode",
        });
      }
      deniedCapability = service.capabilityToken(deniedScope, deniedKey);
    }
    for (const name of toolNames) {
      for (const submittedKey of [deniedKey, otherKey]) {
        const response = await handlers.get(name)!({
          resultKey: submittedKey,
          capability: deniedCapability,
          result: report,
          finding,
        });
        expect(response).toMatchObject({
          isError: true,
          structuredContent: {
            ok: false,
            error: { code: "capability_denied", nextAction: "stop" },
          },
        });
        const encoded = JSON.stringify(response);
        for (const secret of [resultKey, otherKey, deniedKey, deniedCapability]) {
          expect(encoded).not.toContain(secret);
        }
      }
    }
    expect(findingCalls).toHaveLength(0);
    expect(await service.projection(resultKey)).toBe("preparing");
    expect(await service.projection(otherKey)).toBe("preparing");
  });

  test("wrong result kinds stay denied before disclosing a correction", async () => {
    const fixKey = crypto.randomUUID();
    await service.prepare({
      ...scope,
      resultKey: fixKey,
      kind: "fix-result",
      provider: "opencode",
    });
    const fixCapability = service.capabilityToken(scope, fixKey);
    for (const name of ["submit_review_report", "report_finding"]) {
      for (const submittedKey of [fixKey, otherKey]) {
        const response = await handlers.get(name)!({
          resultKey: submittedKey,
          capability: fixCapability,
          result: report,
          finding,
        });
        expect(response).toMatchObject({
          isError: true,
          structuredContent: {
            ok: false,
            error: { code: "capability_denied", nextAction: "stop" },
          },
        });
        expect(JSON.stringify(response)).not.toContain(fixKey);
        expect(JSON.stringify(response)).not.toContain(otherKey);
      }
    }
    expect(findingCalls).toHaveLength(0);
    expect(await service.projection(fixKey)).toBe("preparing");
  });
});

describe("committing a submission by validated digest", () => {
  type Handler = (args: Record<string, unknown>) => Promise<{
    isError?: true;
    structuredContent?: Record<string, unknown>;
  }>;
  type Registration = {
    meta: { inputSchema: { safeParse(value: unknown): { success: boolean } } };
    handler: Handler;
  };

  async function register() {
    const registrations = new Map<string, Registration>();
    const server = {
      registerTool(name: string, meta: Registration["meta"], handler: Handler) {
        registrations.set(name, { meta, handler });
      },
    };
    const resultKey = crypto.randomUUID();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const workflowResults = {
      async submit(...args: unknown[]) {
        calls.push({ method: "submit", args });
        return { ok: true, lifecycle: "accepted" };
      },
      async submitValidated(...args: unknown[]) {
        calls.push({ method: "submitValidated", args });
        return { ok: true, lifecycle: "accepted" };
      },
    };
    const scope = {
      environmentId: "env-1",
      projectId: "project-1",
      workflowResultKey: resultKey,
      kind: "review-report" as const,
    };
    const { registerWorkflowResultTools } = await import("./workflow-result-tools.js");
    registerWorkflowResultTools(server as never, workflowResults as never, scope);
    const submit = registrations.get("submit_review_report");
    if (!submit) throw new Error("missing submission tool");
    return { submit, resultKey, calls, scope };
  }

  const digest = "a".repeat(64);

  test("a digest commits the held payload without a result", async () => {
    const { submit, resultKey, calls, scope } = await register();
    expect(submit.meta.inputSchema.safeParse({ resultKey, validatedDigest: digest }).success).toBe(
      true,
    );
    expect(await submit.handler({ resultKey, validatedDigest: digest })).toMatchObject({
      structuredContent: { ok: true },
    });
    expect(calls).toEqual([{ method: "submitValidated", args: [scope, resultKey, digest] }]);
  });

  test("a full result still commits as before", async () => {
    const { submit, resultKey, calls } = await register();
    expect(await submit.handler({ resultKey, result: report })).toMatchObject({
      structuredContent: { ok: true },
    });
    expect(calls.map((call) => call.method)).toEqual(["submit"]);
  });

  test("neither or both is correctable feedback and never reaches the service", async () => {
    const { submit, resultKey, calls } = await register();
    for (const args of [{ resultKey }, { resultKey, result: report, validatedDigest: digest }]) {
      expect(await submit.handler(args)).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: {
            code: "invalid_result",
            nextAction: "correct",
            message: "Provide exactly one of `result` or `validatedDigest`.",
          },
        },
      });
    }
    expect(calls).toHaveLength(0);
  });

  test("a malformed digest is rejected by the published schema", async () => {
    const { submit, resultKey } = await register();
    for (const validatedDigest of ["short", "A".repeat(64), `${"a".repeat(63)}z`]) {
      expect(submit.meta.inputSchema.safeParse({ resultKey, validatedDigest }).success).toBe(false);
    }
  });

  test("the broker surface accepts the same alternatives after authorizing the capability", async () => {
    const registrations = new Map<string, Registration>();
    const server = {
      registerTool(name: string, meta: Registration["meta"], handler: Handler) {
        registrations.set(name, { meta, handler });
      },
    };
    const resultKey = crypto.randomUUID();
    const capability = "c".repeat(32);
    const calls: string[] = [];
    const workflowResults = {
      async authenticateCapability() {
        return { environmentId: "env-1", projectId: "project-1", workflowResultKey: resultKey };
      },
      async binding() {
        return { kind: "review-report", provider: "opencode" };
      },
      async submit() {
        calls.push("submit");
        return { ok: true, lifecycle: "accepted" };
      },
      async submitValidated() {
        calls.push("submitValidated");
        return { ok: true, lifecycle: "accepted" };
      },
    };
    const { registerWorkflowResultBrokerTools } = await import("./workflow-result-tools.js");
    registerWorkflowResultBrokerTools(server as never, workflowResults as never, {
      environmentId: "env-1",
      projectId: "project-1",
    });
    const submit = registrations.get("submit_review_report");
    if (!submit) throw new Error("missing broker submission tool");
    expect(
      submit.meta.inputSchema.safeParse({ resultKey, capability, validatedDigest: digest }).success,
    ).toBe(true);
    await submit.handler({ resultKey, capability, validatedDigest: digest });
    await submit.handler({ resultKey, capability, result: report });
    expect(calls).toEqual(["submitValidated", "submit"]);
    expect(await submit.handler({ resultKey, capability })).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "invalid_result" } },
    });
  });
});
