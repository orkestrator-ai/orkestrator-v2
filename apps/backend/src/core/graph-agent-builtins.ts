/**
 * The text of a built-in prompt (`prompt: { builtIn: "<id>" }`, item 105) for
 * one agent-node activation (item 204).
 *
 * Each built-in is written by the backend builder its registry entry names
 * (`GraphBuiltInPromptDefinition.backend`), so a graph node sends the prompt
 * today's flows send. This module only adapts graph values to the builders'
 * arguments: a `ticket@1` becomes a task snapshot, a `review-package@2`
 * descriptor and its sealed file the persisted package reference, a
 * replicated branch the reviewer's panel position.
 *
 * The result is only the task part. `renderGraphNodePrompt({ builtInText })`
 * appends the inputs the built-in does not read and the locked system
 * contract: the capability statement, the unattended policy and the per-port
 * result tools, whose preamble replaces any earlier instruction to emit final
 * JSON or a provider-enforced schema. Builder text that would contradict that
 * contract is therefore handled in two ways, each noted where it happens:
 * separable output-contract paragraphs are left out (the adapters call the
 * builders' parts variants), and schema wording inside a builder's shared body
 * is left to the contract's preamble, exactly as today's result-tool workflows
 * do. Nothing here may tell an agent to push, open or edit a pull request, or
 * run `gh` (D12): the pull request and conflict built-ins use the push-free
 * builders.
 *
 * Errors are {@link GraphBuiltInPromptError}s with content-free messages: they
 * name the built-in, input and type, never a payload.
 */
import {
  taskSnapshotCriteria,
  verificationCriterionResults,
  type TaskSnapshot,
  type TaskSnapshotCriterion,
  type VerificationVerdict,
} from "@orkestrator/protocol/build-pipeline";
import { boundPipelineFixResult } from "@orkestrator/protocol/build-pipeline-address-report";
import {
  graphBuiltInPrompt,
  type GraphBuiltInPromptDefinition,
  type GraphBuiltInPromptId,
  type GraphBuiltInPromptPort,
} from "@orkestrator/protocol/graphs/prompts";
import {
  graphItemIdOwner,
  graphItemIds,
  type GraphArtifactProducer,
} from "@orkestrator/protocol/graphs/run";
import {
  graphBuiltInType,
  validateGraphArtifactValue,
  type GraphTicketV1,
  type GraphTypeValidationContext,
} from "@orkestrator/protocol/graphs/types";
import { MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION } from "@orkestrator/protocol/multi-review";
import {
  MULTI_REVIEW_CUSTOM_FIX_INSTRUCTIONS_PREFIX,
  MULTI_REVIEW_CUSTOM_FIX_PROMPT_CONTINUATION,
  STRUCTURED_REVIEW_FINDINGS_FRAME_CLOSE,
  STRUCTURED_REVIEW_FINDINGS_FRAME_INSTRUCTION,
  STRUCTURED_REVIEW_FINDINGS_FRAME_OPEN,
  promptCarrierJson,
  wrapSystemInstructions,
} from "@orkestrator/protocol/review-evidence-frames";
import { withReviewLens, type ReviewLens } from "@orkestrator/protocol/review-lens";
import type { ReviewFixResult } from "@orkestrator/protocol/review-results";
import {
  isReviewPackageReference,
  type ReviewPackageReference,
} from "@orkestrator/protocol/review-workflow";
import {
  safeParseStructuredReviewReport,
  structuredReviewFindings,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import {
  addressFindingsPrompt,
  addressPrompt,
  addressValidationGuidance,
  buildPipelineReviewPackageContext,
  buildTaskPrompt,
  fixTaskPrompt,
  pullRequestDescriptionPrompt,
  resolveConflictsLocallyPrompt,
  verificationTaskPrompt,
} from "./build-pipeline-prompts.js";
import { createMultiReviewConsolidationPrompt, reviewerPanelTail } from "./multi-review-prompts.js";
import { createDiscoveryPrompt } from "./review-prompts.js";
import { ConsolidationBudgetError } from "./review-consolidation-evidence.js";
import {
  IMPLEMENTATION_VALIDATION_HANDOFF,
  reviewValidationDiscoveryPrompt,
} from "./review-validation-prompts.js";

export interface GraphBuiltInPromptInputValue {
  /** The node's input port name. */
  port: string;
  /** The artifact's type ref, e.g. "review-report@1". */
  type: string;
  artifactId: string;
  /** Value artifacts: the value. Reference artifacts: the type's descriptor value when it has one (review-package@2). */
  value?: unknown;
  /** Reference artifacts: the sealed file, workspace-relative, already hash-verified by the caller. */
  file?: { path: string; sha256: string; bytes: number };
  /** Stable per-item source ids of the artifact (types with `items`), in item order. */
  itemIds?: string[];
  /**
   * Review reports read by the consolidation built-in: the source ids of the
   * report's coverage gaps, which `review-report@1` does not list as items
   * (`graphReviewCoverageGapIds`), in order.
   */
  coverageGapIds?: string[];
  /**
   * Review reports read by the consolidation built-in: who wrote the report,
   * from the producing activation, as Multi Review labels its reviewers.
   */
  reviewer?: { agent: string; model: string; focus?: string };
  /**
   * Review reports read by the consolidation built-in: read the report as
   * Multi Review accepts a reviewer's report, through the domain parse that
   * drops the provider schema's `null` placeholders (`alternativeFixes`,
   * `reviewModels`, `reviewSourceIds`) a submitted `review-report@1` keeps.
   * The graph runtime sets it for reports its agent nodes submitted, so the
   * evidence matches a bespoke Multi Review's.
   */
  acceptedReport?: boolean;
}

export interface GraphBuiltInPromptContext {
  builtIn: GraphBuiltInPromptId;
  /** Built-in input name (the registry's `inputs[].name`) → the bound input; a list input → every element in order. Absent optional inputs are missing. */
  inputs: Readonly<
    Record<string, GraphBuiltInPromptInputValue | readonly GraphBuiltInPromptInputValue[]>
  >;
  /** Built-in output name → the node's output port name, for outputs the node declares. */
  outputs: Readonly<Record<string, string>>;
  /** The environment's base branch the work targets ("main"). */
  targetBranch: string;
  /** Project notes, when the project has any. */
  notes?: string;
  /** The node's lens (replicated over lenses). */
  lens?: { key: string; label: string; instruction: string };
  /** Replicated nodes: 1-based branch index and count. */
  branch?: { index: number; count: number };
  /** A user instruction param, when the template passes one (e.g. a review instruction). */
  instruction?: string;
  /**
   * A `reviewInstruction` param (item 301): the review's own instruction. Only
   * the discovery review reads it, and it wins over `instruction` there, so a
   * template can instruct its reviewers without turning its Fix into a custom
   * fix.
   */
  reviewInstruction?: string;
}

/** The built-in prompt that merges review reports under Multi Review's contract. */
export const GRAPH_REVIEW_CONSOLIDATION_BUILT_IN = "consolidation";

/**
 * Whether a node consolidates review reports as Multi Review does (item 301):
 * its prompt is the consolidation built-in. Such a node's `review-report@1`
 * output follows Multi Review's provenance contract — every consolidated
 * issue and coverage gap cites at least one source finding of its own kind,
 * and leaves `reviewModels` to the backend — because the built-in's text tells
 * the model exactly that.
 */
export function isGraphReviewConsolidationNode(node: {
  prompt: { builtIn: string } | object;
}): boolean {
  return (
    "builtIn" in node.prompt &&
    (node.prompt as { builtIn: string }).builtIn === GRAPH_REVIEW_CONSOLIDATION_BUILT_IN
  );
}

/**
 * The source ids of a review report's coverage gaps, which the type does not
 * list as items: `<the report's item label>/coverage-gap-<k>`, parallel to its
 * issues' `<label>/issue-<k>` (so `review/panel.2/coverage-gap-1`). Derived
 * from the producing activation, so they are stable across reads.
 */
export function graphReviewCoverageGapIds(
  producer: GraphArtifactProducer,
  count: number,
): string[] {
  return count > 0 ? graphItemIds(graphItemIdOwner(producer), "coverage-gap", count) : [];
}

/** A built-in prompt that cannot be written for this activation. The message never quotes a payload. */
export class GraphBuiltInPromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphBuiltInPromptError";
  }
}

/**
 * Agent and model of a consolidated report's reviewer. A graph report carries
 * neither (the reviewer is just the producing node), and the consolidation
 * prompt tells the model to leave model labels to the backend anyway.
 */
const UNKNOWN_REVIEWER_LABEL = "unknown";

/** The text of a built-in prompt, from today's backend builders. */
export function graphBuiltInPromptText(context: GraphBuiltInPromptContext): string {
  const inputs = new BuiltInInputs(context);
  const notes = context.notes ?? "";
  const target = context.targetBranch;
  const instruction = context.instruction?.trim() ? context.instruction : undefined;
  switch (context.builtIn) {
    case "review-package-preparation":
      // The registry also names createMultiReviewPreparationPrompt, the older
      // contract in which the model runs validation and returns artifact
      // metadata; it cannot fill a `validation-plan@1`. Multi Review's
      // `prepare` step sends this discovery prompt today, and a system step
      // runs the plan and seals the package. Its "only the final response is
      // the schema-constrained plan" sentence is replaced by the contract's
      // result-tool preamble.
      inputs.required("code");
      return reviewValidationDiscoveryPrompt(target);
    case "discovery-review":
      return discoveryReviewText(
        inputs,
        context,
        notes,
        context.reviewInstruction?.trim() ? context.reviewInstruction : instruction,
      );
    case "consolidation":
      return consolidationText(inputs, target);
    case "fix-review-issues":
      inputs.optional("code");
      return fixReviewIssuesText(inputs, instruction);
    case "address-review": {
      inputs.optional("code");
      const report = inputs.reviewReport(inputs.required("report"));
      // addressValidationGuidance is addressValidationInstruction without
      // ADDRESS_OUTPUT_CONTRACT (the fix result as the final JSON response):
      // the node submits it through its `fix-result` port tool instead.
      return addressPrompt(
        report,
        addressValidationGuidance(inputs.reviewPackage("package"), target),
      );
    }
    case "build":
      inputs.optional("code");
      // The implementation handoff, not reviewPackagePreparationPrompt: in a
      // graph the package is prepared by a node of its own (as a pipeline
      // with a preparation session does), and that prompt's final-JSON
      // preparation contract would contradict the node's port tools.
      return buildTaskPrompt(
        inputs.ticket(inputs.required("ticket")),
        notes,
        IMPLEMENTATION_VALIDATION_HANDOFF,
      );
    case "pipeline-fix": {
      inputs.optional("code");
      const task = inputs.ticket(inputs.required("ticket"));
      const criteria = taskSnapshotCriteria(task);
      const verdict = inputs.builtInValue<VerificationVerdict>(inputs.required("feedback"), {
        criterionIds: criteria.map(({ id }) => id),
      });
      // As buildTaskPrompt above: the implementation handoff ends the turn.
      return fixTaskPrompt(
        task,
        notes,
        verificationFeedback(verdict, criteria),
        target,
        IMPLEMENTATION_VALIDATION_HANDOFF,
      );
    }
    case "verify":
      return verifyText(inputs, notes, target);
    case "pull-request-description":
      // prPrompt commits, pushes and opens the pull request with `gh`, which
      // no agent node may do (D12); this builder only writes the text.
      inputs.required("code");
      return pullRequestDescriptionPrompt(target);
    case "resolve-conflicts":
      // resolveConflictsPrompt ends with "push it" (D12); this variant
      // commits locally and leaves the push to a system step.
      inputs.required("code");
      return resolveConflictsLocallyPrompt(target);
  }
}

function discoveryReviewText(
  inputs: BuiltInInputs,
  context: GraphBuiltInPromptContext,
  notes: string,
  instruction: string | undefined,
): string {
  const reviewPackage = inputs.reviewPackage("package", true)!;
  const ticket = inputs.optional("ticket");
  const task = ticket ? inputs.ticket(ticket) : undefined;
  const discovery = createDiscoveryPrompt({
    reviewPackage,
    reviewInstruction: instruction,
    // The ticket context the Build Pipeline attaches to its reviewers.
    ...(task
      ? { context: buildPipelineReviewPackageContext({ taskSnapshot: task }, notes).context }
      : {}),
  });
  const lens: ReviewLens | undefined = context.lens
    ? { label: context.lens.label, instruction: context.lens.instruction }
    : undefined;
  if (!context.branch) return withReviewLens(discovery, lens);
  const { index, count } = context.branch;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || index > count) {
    throw new GraphBuiltInPromptError(
      "Built-in prompt discovery-review got an invalid branch position",
    );
  }
  // The Build Pipeline panel's reviewer prompt: the shared discovery prompt,
  // then the panel position and lens. createPackagedMultiReviewerPrompt is the
  // same text plus a sentence saying the final message alone must hold the
  // structured report, which the node's port tool replaces, so it is left out.
  return [discovery, reviewerPanelTail(index, count, lens)].join("\n\n");
}

function consolidationText(inputs: BuiltInInputs, target: string): string {
  const reports = inputs.list("reports").map((entry) => ({
    reviewerId: entry.artifactId,
    agent: entry.reviewer?.agent ?? UNKNOWN_REVIEWER_LABEL,
    model: entry.reviewer?.model ?? UNKNOWN_REVIEWER_LABEL,
    ...(entry.reviewer?.focus ? { focus: entry.reviewer.focus } : {}),
    report: withSourceIds(
      entry.acceptedReport
        ? acceptedReport(inputs.reviewReport(entry))
        : inputs.reviewReport(entry),
      entry.itemIds,
      entry.coverageGapIds,
    ),
  }));
  const reviewPackage = inputs.reviewPackage("package");
  try {
    // The builder's "provider-enforced structured result" wording is replaced
    // by the contract's result-tool preamble; its rule against probing the
    // submission tool already fits the node's port tools.
    return createMultiReviewConsolidationPrompt({
      reports,
      targetBranch: target,
      ...(reviewPackage ? { reviewPackage } : {}),
    });
  } catch (error) {
    if (error instanceof ConsolidationBudgetError) {
      throw new GraphBuiltInPromptError(
        `Built-in prompt consolidation: the ${reports.length} reports do not fit one consolidation turn`,
      );
    }
    throw error;
  }
}

/** A submitted report as Multi Review accepts it: the domain parse, without null placeholders. */
function acceptedReport(report: StructuredReviewReport): StructuredReviewReport {
  const parsed = safeParseStructuredReviewReport(report);
  if (!parsed.success) {
    throw new GraphBuiltInPromptError(
      "Built-in prompt consolidation got a report Multi Review would not accept",
    );
  }
  return parsed.data;
}

/**
 * Stamps each issue with the artifact's stable item id, and each coverage gap
 * with its derived source id (`graphReviewCoverageGapIds`), as Multi Review
 * stamps its backend-issued source ids before consolidation, so the
 * consolidated report cites ids the graph's provenance check knows.
 */
function withSourceIds(
  report: StructuredReviewReport,
  itemIds: readonly string[] | undefined,
  coverageGapIds: readonly string[] | undefined,
): StructuredReviewReport {
  if (itemIds && itemIds.length !== report.issues.length) {
    throw new GraphBuiltInPromptError(
      "Built-in prompt consolidation: a report's item ids do not match its issues",
    );
  }
  if (coverageGapIds && coverageGapIds.length !== report.testCoverageGaps.length) {
    throw new GraphBuiltInPromptError(
      "Built-in prompt consolidation: a report's coverage gap ids do not match its gaps",
    );
  }
  return {
    ...report,
    issues: itemIds
      ? report.issues.map((issue, index) => ({ ...issue, reviewSourceIds: [itemIds[index]!] }))
      : report.issues,
    testCoverageGaps: coverageGapIds
      ? report.testCoverageGaps.map((gap, index) => ({
          ...gap,
          reviewSourceIds: [coverageGapIds[index]!],
        }))
      : report.testCoverageGaps,
  };
}

function fixReviewIssuesText(inputs: BuiltInInputs, instruction: string | undefined): string {
  const entry = inputs.required("report");
  const name = typeName(entry.type);
  let framed: unknown;
  let findings: unknown;
  if (name === "review-report") {
    const report = inputs.reviewReport(entry);
    framed = report;
    findings = structuredReviewFindings(report);
  } else if (name === "finding") {
    findings = { issues: [inputs.builtInValue(entry)], testCoverageGaps: [] };
    framed = findings;
  } else {
    // Another report (a diagnosis, a custom report): its value is the findings.
    findings = inputs.reportValue(entry);
    framed = findings;
  }
  // Without an instruction this is addressPrompt as the Multi Review fix sends
  // it (no validation instruction: no verifier follows).
  return instruction ? customFixText(framed, instruction) : addressFindingsPrompt(findings);
}

/**
 * multiReviewCustomFixPrompt with one section swapped. Its
 * MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION turns the session into a
 * manual, interactive conversation answered in prose, which contradicts an
 * unattended node that submits a fix result; the implementation-mode
 * instruction it ends with is kept on its own. Built here from the same
 * protocol constants, so a finding or a custom report frames like a report.
 */
function customFixText(framed: unknown, instruction: string): string {
  return `${MULTI_REVIEW_CUSTOM_FIX_INSTRUCTIONS_PREFIX}
${instruction}

${wrapSystemInstructions(MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION)}

${wrapSystemInstructions(STRUCTURED_REVIEW_FINDINGS_FRAME_INSTRUCTION)}

${STRUCTURED_REVIEW_FINDINGS_FRAME_OPEN}
${promptCarrierJson(framed)}
${STRUCTURED_REVIEW_FINDINGS_FRAME_CLOSE}

${wrapSystemInstructions(MULTI_REVIEW_CUSTOM_FIX_PROMPT_CONTINUATION)}`;
}

function verifyText(inputs: BuiltInInputs, notes: string, target: string): string {
  inputs.optional("code");
  const task = inputs.ticket(inputs.required("ticket"));
  const address = inputs.optional("address");
  // The bounded copy the Build Pipeline keeps on its Address session and
  // renders into Verify's prompt.
  const addressReport = address
    ? {
        kind: "fix-result" as const,
        result: boundPipelineFixResult(inputs.builtInValue<ReviewFixResult>(address)),
      }
    : undefined;
  // verificationTaskPrompt is verificationPrompt without
  // VERIFICATION_OUTPUT_CONTRACT (the verdict as the final JSON response): the
  // node submits it through its `verification-verdict` port tool. No worktree
  // baseline is passed: the executor captures none, and the builder then omits
  // that section rather than claim one.
  return verificationTaskPrompt({
    task,
    reviewPackage: inputs.reviewPackage("package"),
    notes,
    targetBranch: target,
    ...(addressReport ? { addressReport } : {}),
  });
}

/**
 * The feedback a pipeline Fix reads, from a verdict: the rationale, then the
 * failed criteria by id. The Build Pipeline's `feedbackWithUnmetCriteria`
 * (build-pipeline-service-recovery.ts) writes the same text.
 */
function verificationFeedback(
  verdict: VerificationVerdict,
  criteria: readonly TaskSnapshotCriterion[],
): string {
  const failed = verificationCriterionResults(criteria, verdict).filter(
    (result) => result.status === "failed",
  );
  if (failed.length === 0) return verdict.rationale;
  const text = new Map(criteria.map((criterion) => [criterion.id, criterion.text]));
  const lines = failed.map((result) => {
    const criterion = (text.get(result.id) ?? "").replace(/\s+/g, " ").slice(0, 300);
    return `- ${result.id}: ${criterion}${result.evidence ? ` (${result.evidence})` : ""}`;
  });
  return `${verdict.rationale}\n\nUnmet acceptance criteria:\n${lines.join("\n")}`;
}

/**
 * A pipeline task snapshot from a `ticket@1`: the inverse of
 * `graphTicketFromTaskSnapshot`. The criteria keep their ids for Verify and
 * are listed as the acceptance-criteria text. A value artifact holds no
 * images, so none are attached.
 */
function taskSnapshotFromTicket(ticket: GraphTicketV1): TaskSnapshot {
  return {
    title: ticket.title,
    description: ticket.description,
    acceptanceCriteria: ticket.criteria
      .map(({ text }) => `- ${text.replace(/\r\n|\r|\n/g, "\n  ")}`)
      .join("\n"),
    comments: ticket.comments.map(({ text }) => ({ text })),
    images: [],
    ...(ticket.kind ? { kind: ticket.kind } : {}),
    acceptanceCriteriaItems: ticket.criteria.map(({ id, text }) => ({ id, text })),
  };
}

function typeName(ref: string): string {
  const at = ref.lastIndexOf("@");
  return at < 0 ? ref : ref.slice(0, at);
}

/** The context's inputs, checked against the built-in's registry entry. */
class BuiltInInputs {
  private readonly definition: GraphBuiltInPromptDefinition;

  constructor(private readonly context: GraphBuiltInPromptContext) {
    const definition = graphBuiltInPrompt(context.builtIn);
    if (!definition) throw new GraphBuiltInPromptError("Unknown built-in prompt");
    this.definition = definition;
    if (typeof context.targetBranch !== "string" || !context.targetBranch.trim()) {
      this.fail("needs a target branch");
    }
    for (const output of definition.outputs) {
      const port = context.outputs[output.name];
      if (output.required && (typeof port !== "string" || !port)) {
        this.fail(`needs its ${output.name} output`);
      }
    }
    for (const name of Object.keys(context.inputs)) {
      if (!definition.inputs.some((input) => input.name === name)) {
        this.fail(`does not read an input named ${name}`);
      }
    }
    for (const port of definition.inputs) {
      const bound = context.inputs[port.name];
      if (bound === undefined) {
        if (port.required) this.fail(`needs its ${port.name} input`);
        continue;
      }
      const entries = this.entries(port, bound);
      if (port.required && entries.length === 0) this.fail(`needs its ${port.name} input`);
      for (const entry of entries) this.checkAccepted(port, entry);
    }
  }

  required(name: string): GraphBuiltInPromptInputValue {
    const entry = this.optional(name);
    if (!entry) this.fail(`needs its ${name} input`);
    return entry;
  }

  optional(name: string): GraphBuiltInPromptInputValue | undefined {
    const bound = this.context.inputs[name];
    if (bound === undefined) return undefined;
    if (isEntryList(bound)) this.fail(`expects one artifact on its ${name} input`);
    return bound;
  }

  list(name: string): readonly GraphBuiltInPromptInputValue[] {
    const bound = this.context.inputs[name];
    if (bound === undefined) return [];
    if (!isEntryList(bound)) this.fail(`expects a list on its ${name} input`);
    return bound;
  }

  /** A built-in type's value, held to the type's budgets, schema and domain check. */
  builtInValue<T = unknown>(
    entry: GraphBuiltInPromptInputValue,
    validation: GraphTypeValidationContext = {},
  ): T {
    const definition = graphBuiltInType(entry.type);
    if (!definition) this.fail(`does not know the type ${entry.type} of its ${entry.port} input`);
    if (entry.value === undefined) this.fail(`has no value on its ${entry.port} input`);
    if (validateGraphArtifactValue(definition, entry.value, validation).length > 0) {
      this.fail(`got a value on its ${entry.port} input that does not fit ${entry.type}`);
    }
    return entry.value as T;
  }

  /** A value of any report type: built-in ones are checked, custom ones were checked when produced. */
  reportValue(entry: GraphBuiltInPromptInputValue): unknown {
    if (graphBuiltInType(entry.type)) return this.builtInValue(entry);
    if (entry.value === undefined) this.fail(`has no value on its ${entry.port} input`);
    return entry.value;
  }

  reviewReport(entry: GraphBuiltInPromptInputValue): StructuredReviewReport {
    this.expectType(entry, "review-report");
    return this.builtInValue<StructuredReviewReport>(entry);
  }

  ticket(entry: GraphBuiltInPromptInputValue): TaskSnapshot {
    this.expectType(entry, "ticket");
    return taskSnapshotFromTicket(this.builtInValue<GraphTicketV1>(entry));
  }

  /**
   * The persisted package reference a builder reads: the type's descriptor,
   * which must describe the sealed file the caller verified (same SHA-256 and
   * byte count). The builders tell the agent the package's SHA-256 was
   * verified before dispatch, so a descriptor without that file is refused
   * rather than passed on unverified.
   *
   * `run-validation-and-seal` seals a copy of the generated package in the
   * run's artifact directory, while its descriptor keeps the path the package
   * was generated at. The builders are then given the verified copy's path,
   * so the file the prompt names is the file that was verified (item 301).
   */
  reviewPackage(name: string, required = false): ReviewPackageReference | undefined {
    const entry = required ? this.required(name) : this.optional(name);
    if (!entry) return undefined;
    this.expectType(entry, "review-package");
    const descriptor = this.builtInValue<ReviewPackageReference>(entry);
    const file = entry.file;
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path ||
      file.sha256 !== descriptor.sha256 ||
      file.bytes !== descriptor.bytes ||
      !isReviewPackageReference(descriptor)
    ) {
      this.fail(`needs the verified sealed file of its ${name} input`);
    }
    return file.path === descriptor.filePath ? descriptor : { ...descriptor, filePath: file.path };
  }

  private expectType(entry: GraphBuiltInPromptInputValue, name: string): void {
    if (typeName(entry.type) !== name) {
      this.fail(`expects ${name} on its ${entry.port} input, not ${entry.type}`);
    }
  }

  private entries(
    port: GraphBuiltInPromptPort,
    bound: GraphBuiltInPromptInputValue | readonly GraphBuiltInPromptInputValue[],
  ): readonly GraphBuiltInPromptInputValue[] {
    if (port.list) {
      if (!isEntryList(bound)) this.fail(`expects a list on its ${port.name} input`);
      return bound;
    }
    if (isEntryList(bound)) this.fail(`expects one artifact on its ${port.name} input`);
    return [bound];
  }

  private checkAccepted(port: GraphBuiltInPromptPort, entry: GraphBuiltInPromptInputValue): void {
    if (!entry || typeof entry.type !== "string" || typeof entry.port !== "string") {
      this.fail(`got a malformed artifact on its ${port.name} input`);
    }
    const builtIn = graphBuiltInType(entry.type);
    const family = builtIn?.family ?? (entry.file ? "package" : "report");
    const accepted =
      (builtIn !== undefined && (port.types ?? []).includes(builtIn.name)) ||
      (port.families ?? []).includes(family);
    if (!accepted) this.fail(`does not accept ${entry.type} on its ${port.name} input`);
  }

  private fail(reason: string): never {
    throw new GraphBuiltInPromptError(`Built-in prompt ${this.definition.id} ${reason}`);
  }
}

function isEntryList(
  value: GraphBuiltInPromptInputValue | readonly GraphBuiltInPromptInputValue[],
): value is readonly GraphBuiltInPromptInputValue[] {
  return Array.isArray(value);
}
