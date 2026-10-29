import { describe, expect, test } from "bun:test";
import type { BuildPipeline, TaskSnapshot } from "@orkestrator/protocol/build-pipeline";
import { boundPipelineFixResult } from "@orkestrator/protocol/build-pipeline-address-report";
import {
  GRAPH_BUILT_IN_PROMPT_IDS,
  graphBuiltInPrompt,
  type GraphBuiltInPromptId,
} from "@orkestrator/protocol/graphs/prompts";
import {
  graphBuiltInType,
  graphBuiltInTypes,
  graphBuiltInValidator,
  graphTicketFromTaskSnapshot,
} from "@orkestrator/protocol/graphs/types";
import {
  MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION,
  MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION,
  multiReviewCustomFixPrompt,
} from "@orkestrator/protocol/multi-review";
import {
  REVIEW_VALIDATION_DISCOVERY_PROMPT_SIGNATURE,
  STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION,
  wrapSystemInstructions,
} from "@orkestrator/protocol/review-evidence-frames";
import type { ReviewFixResult } from "@orkestrator/protocol/review-results";
import type { ReviewPackageReference } from "@orkestrator/protocol/review-workflow";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  ADDRESS_OUTPUT_CONTRACT,
  addressPrompt,
  addressValidationInstruction,
  buildPipelineReviewPackageContext,
  buildPrompt,
  fixPrompt,
  PULL_REQUEST_TITLE_MAX_CHARACTERS,
  prPrompt,
  pullRequestDescriptionPrompt,
  resolveConflictsLocallyPrompt,
  resolveConflictsPrompt,
  VERIFICATION_OUTPUT_CONTRACT,
  verificationPrompt,
} from "./build-pipeline-prompts.js";
import {
  GraphBuiltInPromptError,
  graphBuiltInPromptText,
  type GraphBuiltInPromptContext,
  type GraphBuiltInPromptInputValue,
} from "./graph-agent-builtins.js";
import {
  createMultiReviewConsolidationPrompt,
  createPackagedMultiReviewerPrompt,
  reviewerPanelTail,
} from "./multi-review-prompts.js";
import { createDiscoveryPrompt } from "./review-prompts.js";
import { reviewValidationDiscoveryPrompt } from "./review-validation-prompts.js";

/** A recognisable phrase of each built-in's bound builder. */
const BUILDER_PHRASES: Record<GraphBuiltInPromptId, string> = {
  "review-package-preparation": REVIEW_VALIDATION_DISCOVERY_PROMPT_SIGNATURE,
  "discovery-review": "You are an independent native code-review pass.",
  consolidation: "This is a merge, not another review.",
  "fix-review-issues": STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION,
  "address-review": "Fix every recorded failure that relates to the ticket",
  build: "You are building a feature. Here is the ticket:",
  "pipeline-fix": "Fix the unmet acceptance criteria for this ticket:",
  verify: "Verify the committed branch changes against this ticket:",
  "pull-request-description": "Write the pull request title and description",
  "resolve-conflicts": "Fetch origin, merge origin/main, and resolve every merge conflict",
};

function example<T = unknown>(name: string): T {
  const definition = graphBuiltInTypes().find((type) => type.name === name);
  if (!definition) throw new Error(`no built-in type ${name}`);
  return structuredClone(definition.example) as T;
}

function typeRef(name: string): string {
  return graphBuiltInTypes().find((type) => type.name === name)!.ref;
}

let artifactCounter = 0;

function artifact(
  port: string,
  name: string,
  value: unknown = example(name),
): GraphBuiltInPromptInputValue {
  artifactCounter += 1;
  const ref = typeRef(name);
  const entry: GraphBuiltInPromptInputValue = {
    port,
    type: ref,
    artifactId: `artifact-${artifactCounter}`,
    value,
  };
  if (name === "review-package") {
    const descriptor = value as ReviewPackageReference;
    entry.file = { path: descriptor.filePath, sha256: descriptor.sha256, bytes: descriptor.bytes };
  }
  const items = graphBuiltInType(ref)?.items;
  if (items && name === "review-report") {
    const issues = (value as StructuredReviewReport).issues;
    entry.itemIds = issues.map((_, index) => `${entry.artifactId}/${items.idPrefix}-${index + 1}`);
  }
  return entry;
}

/** A context built from the type examples: every input (lists get two elements) and output. */
function exampleContext(
  id: GraphBuiltInPromptId,
  options: { optionalInputs?: boolean } = {},
): GraphBuiltInPromptContext {
  const definition = graphBuiltInPrompt(id)!;
  const inputs: Record<string, GraphBuiltInPromptInputValue | GraphBuiltInPromptInputValue[]> = {};
  for (const input of definition.inputs) {
    if (!input.required && options.optionalInputs === false) continue;
    const name = input.types?.[0] ?? "review-report";
    inputs[input.name] = input.list
      ? [artifact(input.name, name), artifact(input.name, name)]
      : artifact(input.name, name);
    // The review instruction is read only from a run input (item 301).
    if (input.name === "instruction") {
      inputs[input.name] = {
        ...(inputs[input.name] as GraphBuiltInPromptInputValue),
        runInput: true,
      };
    }
  }
  return {
    builtIn: id,
    inputs,
    outputs: Object.fromEntries(definition.outputs.map((output) => [output.name, output.name])),
    targetBranch: "main",
    notes: "Use bun for everything.",
  };
}

/**
 * Sentences that mention pushing or `gh` must forbid it or hand it to the
 * system step; anything else would be a push instruction (D12).
 */
function pushInstructions(text: string): string[] {
  return text
    .split(/(?<=[.!?:])\s+|\n+/)
    .filter((sentence) => /\bpush(es|ed|ing)?\b|\bgh\b|gh pr|git push/i.test(sentence))
    .filter(
      (sentence) =>
        !/\b(do not|don't|never|must not|may not)\b/i.test(sentence) &&
        !/\bsystem step\b/i.test(sentence),
    );
}

function snapshot(): TaskSnapshot {
  return {
    title: "Add CSV export to the reports page",
    description: "Users need to take report data into spreadsheets.",
    acceptanceCriteria:
      "- The reports page has an Export CSV button.\n- The CSV has a header row and every visible row.",
    acceptanceCriteriaItems: [
      { id: "ac-1", text: "The reports page has an Export CSV button." },
      { id: "ac-2", text: "The CSV has a header row and every visible row." },
    ],
    comments: [{ text: "Match the column order on screen." }],
    images: [],
    kind: "feature",
  };
}

function pipeline(overrides: Partial<BuildPipeline> = {}): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "environment-1",
    environmentType: "local",
    agentType: "codex",
    phase: "building",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-10-29T08:00:00.000Z",
    taskTitle: "Add CSV export to the reports page",
    taskSnapshot: snapshot(),
    backendRevision: 1,
    controller: "backend",
    // A preparation session: the build ends with the implementation handoff,
    // as a graph's Build node (whose package another node prepares) does.
    reviewPreparation: { agent: "claude" },
    ...overrides,
  };
}

function ticketArtifact(): GraphBuiltInPromptInputValue {
  return artifact("ticket", "ticket", graphTicketFromTaskSnapshot(snapshot()));
}

const NOTES = "Use bun for everything.";

describe("graphBuiltInPromptText", () => {
  for (const id of GRAPH_BUILT_IN_PROMPT_IDS) {
    test(`${id}: writes its builder's text from the type examples`, () => {
      const text = graphBuiltInPromptText(exampleContext(id));
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).toContain(BUILDER_PHRASES[id]);
      expect(pushInstructions(text)).toEqual([]);
      expect(text).not.toContain(ADDRESS_OUTPUT_CONTRACT);
      expect(text).not.toContain(VERIFICATION_OUTPUT_CONTRACT);
      expect(text).not.toContain(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION);
    });

    test(`${id}: works with only its required inputs`, () => {
      const text = graphBuiltInPromptText(exampleContext(id, { optionalInputs: false }));
      expect(text).toContain(BUILDER_PHRASES[id]);
    });

    const definition = graphBuiltInPrompt(id)!;
    for (const input of definition.inputs.filter((port) => port.required)) {
      test(`${id}: refuses a missing ${input.name} input`, () => {
        const context = exampleContext(id);
        const inputs = { ...context.inputs };
        delete inputs[input.name];
        expect(() => graphBuiltInPromptText({ ...context, inputs })).toThrow(
          GraphBuiltInPromptError,
        );
        if (input.list) {
          expect(() =>
            graphBuiltInPromptText({ ...context, inputs: { ...inputs, [input.name]: [] } }),
          ).toThrow(GraphBuiltInPromptError);
        }
      });
    }
    for (const output of definition.outputs.filter((port) => port.required)) {
      test(`${id}: refuses a node without its ${output.name} output`, () => {
        const context = exampleContext(id);
        const outputs = { ...context.outputs };
        delete outputs[output.name];
        expect(() => graphBuiltInPromptText({ ...context, outputs })).toThrow(
          GraphBuiltInPromptError,
        );
      });
    }
  }

  test("refuses values that do not fit, without quoting them", () => {
    const secret = "TOP-SECRET-TICKET-TITLE";
    const badTicket = { ...example<Record<string, unknown>>("ticket"), title: secret, extra: 1 };
    const context = exampleContext("build");
    let error: unknown;
    try {
      graphBuiltInPromptText({
        ...context,
        inputs: { ...context.inputs, ticket: artifact("ticket", "ticket", badTicket) },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GraphBuiltInPromptError);
    expect((error as Error).name).toBe("GraphBuiltInPromptError");
    expect((error as Error).message).not.toContain(secret);

    // A type the input does not accept.
    expect(() =>
      graphBuiltInPromptText({
        ...context,
        inputs: { ...context.inputs, ticket: artifact("ticket", "workspace") },
      }),
    ).toThrow(GraphBuiltInPromptError);
    // A list on a single input, and one artifact on a list input.
    expect(() =>
      graphBuiltInPromptText({
        ...context,
        inputs: { ...context.inputs, ticket: [ticketArtifact()] },
      }),
    ).toThrow(GraphBuiltInPromptError);
    const consolidation = exampleContext("consolidation");
    expect(() =>
      graphBuiltInPromptText({
        ...consolidation,
        inputs: { ...consolidation.inputs, reports: artifact("reports", "review-report") },
      }),
    ).toThrow(GraphBuiltInPromptError);
    // An input the built-in does not read, and no target branch.
    expect(() =>
      graphBuiltInPromptText({
        ...context,
        inputs: { ...context.inputs, diagnosis: artifact("diagnosis", "text") },
      }),
    ).toThrow(GraphBuiltInPromptError);
    expect(() => graphBuiltInPromptText({ ...context, targetBranch: " " })).toThrow(
      GraphBuiltInPromptError,
    );
  });

  test("a review package needs the verified sealed file its descriptor names", () => {
    const context = exampleContext("discovery-review");
    const reviewPackage = context.inputs.package as GraphBuiltInPromptInputValue;
    const { file: _file, ...withoutFile } = reviewPackage;
    for (const entry of [
      withoutFile,
      { ...reviewPackage, file: { ...reviewPackage.file!, sha256: "0".repeat(64) } },
      { ...reviewPackage, file: { ...reviewPackage.file!, bytes: 1 } },
    ]) {
      expect(() =>
        graphBuiltInPromptText({ ...context, inputs: { ...context.inputs, package: entry } }),
      ).toThrow(GraphBuiltInPromptError);
    }
  });

  test("consolidation refuses item ids that do not match the issues", () => {
    const context = exampleContext("consolidation");
    const [first, second] = context.inputs.reports as GraphBuiltInPromptInputValue[];
    expect(() =>
      graphBuiltInPromptText({
        ...context,
        inputs: { ...context.inputs, reports: [{ ...first!, itemIds: [] }, second!] },
      }),
    ).toThrow(GraphBuiltInPromptError);
  });

  test("discovery-review refuses an impossible branch position", () => {
    const context = exampleContext("discovery-review");
    expect(() => graphBuiltInPromptText({ ...context, branch: { index: 3, count: 2 } })).toThrow(
      GraphBuiltInPromptError,
    );
  });

  test("an unknown built-in id is refused", () => {
    expect(() =>
      graphBuiltInPromptText({
        ...exampleContext("build"),
        builtIn: "ship" as GraphBuiltInPromptId,
      }),
    ).toThrow(GraphBuiltInPromptError);
  });
});

describe("push-free built-ins (D12)", () => {
  test("the push check catches the pushing builders", () => {
    expect(pushInstructions(prPrompt("main")).length).toBeGreaterThan(0);
    expect(pushInstructions(resolveConflictsPrompt("main")).length).toBeGreaterThan(0);
  });

  test("pull-request-description writes text only and leaves the pull request to a system step", () => {
    for (const text of [
      graphBuiltInPromptText(exampleContext("pull-request-description")),
      pullRequestDescriptionPrompt("main", {
        existingPullRequestUrl: "https://github.com/acme/widgets/pull/42",
      }),
    ]) {
      expect(pushInstructions(text)).toEqual([]);
      expect(text).not.toMatch(/gh pr (create|edit|reopen)/);
      expect(text).toMatch(/system step opens or updates the pull request/i);
      expect(text).toContain("Do not push");
      expect(text).toContain("git diff origin/main...HEAD");
      expect(text).toContain(`at most ${PULL_REQUEST_TITLE_MAX_CHARACTERS} characters`);
    }
    expect(
      pullRequestDescriptionPrompt("main", {
        existingPullRequestUrl: "https://github.com/acme/widgets/pull/42",
      }),
    ).toContain("already has a pull request: https://github.com/acme/widgets/pull/42");
  });

  test("the title limit is the one pr-description@1 enforces", () => {
    const check = graphBuiltInValidator("pr-description").check;
    expect(check({ title: "x".repeat(PULL_REQUEST_TITLE_MAX_CHARACTERS), body: "b" }, {})).toEqual(
      [],
    );
    expect(
      check({ title: "x".repeat(PULL_REQUEST_TITLE_MAX_CHARACTERS + 1), body: "b" }, {}).length,
    ).toBeGreaterThan(0);
  });

  test("resolve-conflicts commits locally and leaves the push to a system step", () => {
    const text = graphBuiltInPromptText(exampleContext("resolve-conflicts"));
    expect(text).toBe(resolveConflictsLocallyPrompt("main"));
    expect(pushInstructions(text)).toEqual([]);
    expect(text).not.toContain("push it");
    expect(text).toContain("Commit the merge resolution locally");
    expect(text).toMatch(/a system step pushes it/);
  });
});

describe("equivalence with the bound builders", () => {
  test("build is buildPrompt for a pipeline with a preparation session", () => {
    const text = graphBuiltInPromptText({
      ...exampleContext("build"),
      inputs: { ticket: ticketArtifact() },
      notes: NOTES,
    });
    expect(text).toBe(buildPrompt(pipeline(), NOTES, "main"));
  });

  test("pipeline-fix is fixPrompt with the verdict's feedback", () => {
    const verdict = example<{ rationale: string }>("verification-verdict");
    const text = graphBuiltInPromptText({
      ...exampleContext("pipeline-fix"),
      inputs: { ticket: ticketArtifact(), feedback: artifact("feedback", "verification-verdict") },
      notes: NOTES,
    });
    const feedback = `${verdict.rationale}\n\nUnmet acceptance criteria:\n- ac-2: The CSV has a header row and every visible row. (A three-row report exports two rows.)`;
    expect(text).toBe(fixPrompt(pipeline(), NOTES, feedback, "main"));
  });

  test("verify is verificationPrompt without its final-JSON output contract", () => {
    const reviewPackage = example<ReviewPackageReference>("review-package");
    const fixResult = example<ReviewFixResult>("fix-result");
    const text = graphBuiltInPromptText({
      ...exampleContext("verify"),
      inputs: {
        ticket: ticketArtifact(),
        address: artifact("address", "fix-result", fixResult),
        package: artifact("package", "review-package", reviewPackage),
      },
      notes: NOTES,
    });
    expect(`${text}\n\n${VERIFICATION_OUTPUT_CONTRACT}`).toBe(
      verificationPrompt(pipeline({ reviewPackage }), NOTES, "main", undefined, {
        kind: "fix-result",
        result: boundPipelineFixResult(fixResult),
      }),
    );
  });

  test("address-review is addressPrompt with the validation instruction minus its output contract", () => {
    const report = example<StructuredReviewReport>("review-report");
    const reviewPackage = example<ReviewPackageReference>("review-package");
    const text = graphBuiltInPromptText({
      ...exampleContext("address-review"),
      inputs: {
        report: artifact("report", "review-report", report),
        package: artifact("package", "review-package", reviewPackage),
      },
    });
    const instruction = addressValidationInstruction(reviewPackage, "main");
    expect(instruction.endsWith(`\n\n${ADDRESS_OUTPUT_CONTRACT}`)).toBe(true);
    expect(text).toBe(
      addressPrompt(report, instruction.slice(0, -`\n\n${ADDRESS_OUTPUT_CONTRACT}`.length)),
    );
  });

  test("discovery-review is the panel reviewer prompt", () => {
    const reviewPackage = example<ReviewPackageReference>("review-package");
    const lens = { key: "security", label: "Security", instruction: "Look hardest at auth." };
    const base = {
      ...exampleContext("discovery-review"),
      inputs: { package: artifact("package", "review-package", reviewPackage) },
      lens,
      branch: { index: 2, count: 3 },
      instruction: "Focus on data loss.",
    };
    const text = graphBuiltInPromptText(base);
    const reviewerLens = { label: lens.label, instruction: lens.instruction };
    expect(text).toBe(
      [
        createDiscoveryPrompt({ reviewPackage, reviewInstruction: "Focus on data loss." }),
        reviewerPanelTail(2, 3, reviewerLens),
      ].join("\n\n"),
    );
    // createPackagedMultiReviewerPrompt minus its final-message sentence.
    const packaged = createPackagedMultiReviewerPrompt({
      reviewPackage,
      reviewInstruction: "Focus on data loss.",
      reviewerNumber: 2,
      reviewerCount: 3,
      lens: reviewerLens,
    });
    const sentence =
      "\n\nNarrate progress in ordinary prose as you examine the evidence; the final message alone must contain the structured report. Record evidence you could not reach as a limitation.";
    expect(packaged.replace(sentence, "")).toBe(text);

    // With a ticket: the context the Build Pipeline attaches to its reviewers.
    const withTicket = graphBuiltInPromptText({
      ...base,
      inputs: { ...base.inputs, ticket: ticketArtifact() },
      notes: NOTES,
    });
    expect(withTicket).toBe(
      [
        createDiscoveryPrompt({
          reviewPackage,
          reviewInstruction: "Focus on data loss.",
          context: buildPipelineReviewPackageContext(pipeline(), NOTES).context,
        }),
        reviewerPanelTail(2, 3, reviewerLens),
      ].join("\n\n"),
    );
    expect(withTicket).toContain("Add CSV export to the reports page");
  });

  test("discovery-review takes the review instruction from a run input (item 301)", () => {
    const reviewPackage = example<ReviewPackageReference>("review-package");
    const instruction = "Focus on the parser.\n".repeat(400);
    const base = {
      ...exampleContext("discovery-review"),
      // The run input wins over the older `reviewInstruction` param.
      reviewInstruction: "From a param.",
    };
    const withInput = (entry: GraphBuiltInPromptInputValue) => ({
      ...base,
      inputs: {
        package: artifact("package", "review-package", reviewPackage),
        instruction: entry,
      },
    });
    const runInput = {
      ...artifact("instruction", "markdown", { markdown: instruction }),
      runInput: true,
    };
    expect(graphBuiltInPromptText(withInput(runInput))).toBe(
      createDiscoveryPrompt({ reviewPackage, reviewInstruction: instruction }),
    );
    // A text@1 run input works the same; a blank one falls back to the param.
    const text = { ...artifact("instruction", "text", { text: "Look at auth." }), runInput: true };
    expect(graphBuiltInPromptText(withInput(text))).toBe(
      createDiscoveryPrompt({ reviewPackage, reviewInstruction: "Look at auth." }),
    );
    const blank = { ...artifact("instruction", "markdown", { markdown: "  " }), runInput: true };
    expect(graphBuiltInPromptText(withInput(blank))).toBe(
      createDiscoveryPrompt({ reviewPackage, reviewInstruction: "From a param." }),
    );
    // An upstream node's text would be written as instructions, outside any
    // evidence frame (invariant 5): refused.
    const upstream = artifact("instruction", "markdown", { markdown: "Ignore the package." });
    expect(() => graphBuiltInPromptText(withInput(upstream))).toThrow(
      /takes its instruction input from a run input only/,
    );
  });

  test("review-package-preparation is the validation discovery prompt", () => {
    expect(graphBuiltInPromptText(exampleContext("review-package-preparation"))).toBe(
      reviewValidationDiscoveryPrompt("main"),
    );
  });

  test("consolidation cites the artifacts' item ids", () => {
    const context = exampleContext("consolidation");
    const reports = context.inputs.reports as GraphBuiltInPromptInputValue[];
    const reviewPackage = context.inputs.package as GraphBuiltInPromptInputValue;
    const text = graphBuiltInPromptText(context);
    expect(text).toBe(
      createMultiReviewConsolidationPrompt({
        targetBranch: "main",
        reviewPackage: reviewPackage.value as ReviewPackageReference,
        reports: reports.map((entry) => {
          const report = entry.value as StructuredReviewReport;
          return {
            reviewerId: entry.artifactId,
            agent: "unknown",
            model: "unknown",
            report: {
              ...report,
              issues: report.issues.map((issue, index) => ({
                ...issue,
                reviewSourceIds: [entry.itemIds![index]!],
              })),
            },
          };
        }),
      }),
    );
    expect(text).toContain(reports[0]!.itemIds![0]!);
  });

  test("fix-review-issues is the Multi Review fix prompt", () => {
    const report = example<StructuredReviewReport>("review-report");
    const context = {
      ...exampleContext("fix-review-issues"),
      inputs: { report: artifact("report", "review-report", report) },
    };
    expect(graphBuiltInPromptText(context)).toBe(addressPrompt(report));

    // With a user instruction: the custom fix prompt, unattended.
    const instruction = "Only fix the P1 issue.";
    const custom = graphBuiltInPromptText({ ...context, instruction });
    expect(custom).toBe(
      multiReviewCustomFixPrompt(report, instruction).replace(
        wrapSystemInstructions(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION),
        wrapSystemInstructions(MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION),
      ),
    );

    // A single finding is framed as a report's findings.
    const finding = example("finding");
    const single = graphBuiltInPromptText({
      ...context,
      inputs: { report: artifact("report", "finding", finding) },
    });
    expect(single).toBe(
      addressPrompt({
        ...report,
        issues: [finding],
        testCoverageGaps: [],
      } as StructuredReviewReport),
    );
  });

  test("fix-review-issues frames a custom report's value", () => {
    const diagnosis = { diagnoses: [{ cause: "flaky clock", file: "src/time.ts" }] };
    const text = graphBuiltInPromptText({
      ...exampleContext("fix-review-issues"),
      inputs: {
        report: { port: "report", type: "diagnosis@1", artifactId: "a-1", value: diagnosis },
      },
    });
    expect(text).toContain("flaky clock");
    expect(text).toContain(STRUCTURED_REVIEW_FINDINGS_PROMPT_CONTINUATION);
  });
});
