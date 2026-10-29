/**
 * Built-in prompts an agent node can name instead of writing a template:
 * `prompt: { builtIn: "discovery-review" }` (item 105, report §9).
 *
 * This registry is what the compiler (107) and the designer know about each
 * one: what it is for, which inputs it reads and which outputs it fills. The
 * text itself is written by the backend's existing prompt builders when the
 * node runs (`backend` names them for the agent executor, 204), so today's
 * flows and their built-in templates (108) send the prompts they send now.
 * Inputs a built-in does not read are appended after its text, each in its
 * own evidence frame, so nothing wired into the node is silently dropped.
 * Browser-safe.
 */
import type { GraphTypeFamily } from "./types.js";
import type { GraphCapabilityProfileId, GraphRenderMode } from "./template-model.js";

export const GRAPH_BUILT_IN_PROMPT_IDS = [
  "review-package-preparation",
  "discovery-review",
  "consolidation",
  "fix-review-issues",
  "address-review",
  "build",
  "pipeline-fix",
  "verify",
  "pull-request-description",
  "resolve-conflicts",
] as const;
export type GraphBuiltInPromptId = (typeof GRAPH_BUILT_IN_PROMPT_IDS)[number];

/** What a built-in reads or fills: a port whose type is one of `types` or in one of `families`. */
export interface GraphBuiltInPromptPort {
  /** The name the built-in templates use; any port with an accepted type matches. */
  name: string;
  /** Type names (any version) the port may carry; `list<…>` is matched on its element when `list` is set. */
  types?: readonly string[];
  /** Type families that are also accepted (custom report types, for instance). */
  families?: readonly GraphTypeFamily[];
  /** A list of the accepted type (fan-in). */
  list?: boolean;
  required: boolean;
  /** The mode the backend's text renders this input in, for size estimates. */
  render: GraphRenderMode;
  description: string;
}

export interface GraphBuiltInPromptDefinition {
  id: GraphBuiltInPromptId;
  label: string;
  description: string;
  inputs: readonly GraphBuiltInPromptPort[];
  outputs: readonly Omit<GraphBuiltInPromptPort, "render">[];
  /** Profiles the text is written for; another profile gets an advisory note. */
  profiles: readonly GraphCapabilityProfileId[];
  /** The backend builder(s) the agent executor (204) binds the text to. */
  backend: string;
  /** Allowance for the text, without its inputs, in UTF-8 bytes (size estimates). */
  textMaxBytes: number;
}

const KIB = 1024;

const workspaceInput = (required: boolean): GraphBuiltInPromptPort => ({
  name: "code",
  types: ["workspace"],
  required,
  render: "json-frame",
  description: "The branch and commit to work on.",
});
const ticketInput = (required: boolean): GraphBuiltInPromptPort => ({
  name: "ticket",
  types: ["ticket"],
  required,
  render: "markdown",
  description: "The ticket: title, description and acceptance criteria.",
});
const workspaceOutput = (required: boolean) => ({
  name: "code",
  types: ["workspace"],
  required,
  description: "The commit the node leaves.",
});
const fixResultOutput = (required: boolean) => ({
  name: "report",
  types: ["fix-result"],
  required,
  description: "What was changed and what was validated.",
});
/**
 * The sealed package a stage reads its recorded validation from, as the
 * pipeline's Address and Verify builders do (`recordedValidationSection`).
 */
const recordedValidationInput: GraphBuiltInPromptPort = {
  name: "package",
  types: ["review-package"],
  required: false,
  render: "file",
  description: "The sealed review package whose recorded validation the stage reads.",
};

const DEFINITIONS: readonly GraphBuiltInPromptDefinition[] = [
  {
    id: "review-package-preparation",
    label: "Review package preparation",
    description:
      "Commits relevant safe changes and discovers the repository's validation plan for the change, for the backend to run and seal into one review package.",
    inputs: [workspaceInput(true)],
    outputs: [
      {
        name: "plan",
        types: ["validation-plan"],
        required: true,
        description: "The validation commands for the committed HEAD.",
      },
      workspaceOutput(false),
    ],
    profiles: ["builder"],
    backend:
      "createMultiReviewPreparationPrompt (multi-review-prompts.ts); reviewValidationDiscoveryPrompt (review-validation-prompts.ts) in the Build Pipeline",
    textMaxBytes: 16 * KIB,
  },
  {
    id: "discovery-review",
    label: "Review",
    description:
      "Reviews the change in a sealed review package, reading Git and the recorded validation instead of re-running it, and submits a structured review report.",
    inputs: [
      {
        name: "package",
        types: ["review-package"],
        required: true,
        render: "file",
        description: "The sealed review package every reviewer shares.",
      },
      ticketInput(false),
    ],
    outputs: [
      {
        name: "report",
        types: ["review-report"],
        required: true,
        description: "The structured review report.",
      },
    ],
    profiles: ["reviewer", "observer"],
    backend:
      "createPackagedMultiReviewerPrompt (multi-review-prompts.ts); reviewPrompt (build-pipeline-prompts.ts) in the Build Pipeline",
    textMaxBytes: 32 * KIB,
  },
  {
    id: "consolidation",
    label: "Consolidation",
    description:
      "Merges the reviewers' reports into one report: matches findings that describe the same defect and carries every other finding forward, citing the source ids.",
    inputs: [
      {
        name: "reports",
        types: ["review-report"],
        list: true,
        required: true,
        render: "json-frame",
        description: "Every reviewer's report.",
      },
      {
        name: "package",
        types: ["review-package"],
        required: false,
        render: "file",
        description:
          "The package the reviewers shared; the builder reconciles each report's scope against it.",
      },
    ],
    outputs: [
      {
        name: "report",
        types: ["review-report"],
        required: true,
        description: "The consolidated report, citing source ids.",
      },
    ],
    // Today's consolidation is a read-only turn that may make targeted reads.
    profiles: ["observer", "reviewer"],
    backend:
      "createMultiReviewConsolidationPrompt (multi-review-prompts.ts), with buildConsolidationEvidence",
    textMaxBytes: 16 * KIB,
  },
  {
    id: "fix-review-issues",
    label: "Fix review issues",
    description:
      "Addresses every issue and coverage gap in a report, making sensible assumptions without asking questions, and reports what it changed.",
    inputs: [
      {
        name: "report",
        types: ["review-report", "finding"],
        families: ["report"],
        required: true,
        render: "json-frame",
        description: "The findings to address (a review report, findings, or a diagnosis).",
      },
      workspaceInput(false),
    ],
    outputs: [fixResultOutput(true), workspaceOutput(false)],
    profiles: ["builder"],
    backend:
      "addressPrompt (build-pipeline-prompts.ts) as the Multi Review fix sends it; multiReviewCustomFixPrompt (protocol multi-review.ts) with a user instruction",
    textMaxBytes: 8 * KIB,
  },
  {
    id: "address-review",
    label: "Address review",
    description:
      "The Build Pipeline's Address stage: fixes the review's findings and validates the fix for the verifier.",
    inputs: [
      {
        name: "report",
        types: ["review-report"],
        required: true,
        render: "json-frame",
        description: "The review report to address.",
      },
      workspaceInput(false),
      recordedValidationInput,
    ],
    outputs: [workspaceOutput(false), fixResultOutput(true)],
    profiles: ["builder"],
    backend:
      "addressPrompt with addressValidationInstruction (build-pipeline-prompts.ts, build-pipeline-service-supervisor.ts)",
    textMaxBytes: 8 * KIB,
  },
  {
    id: "build",
    label: "Build",
    description: "Implements the ticket completely without asking questions, then validates it.",
    inputs: [ticketInput(true), workspaceInput(false)],
    // Optional: today's Build turn submits no fix result (a panel review
    // prepares the package in its own session; one reviewer's Build submits
    // the package preparation instead).
    outputs: [workspaceOutput(false), fixResultOutput(false)],
    profiles: ["builder"],
    backend: "buildPrompt (build-pipeline-prompts.ts)",
    textMaxBytes: 16 * KIB,
  },
  {
    id: "pipeline-fix",
    label: "Fix unmet criteria",
    description:
      "Fixes the acceptance criteria verification found unmet, establishing reproduction before excusing an unrelated failure.",
    inputs: [
      ticketInput(true),
      {
        name: "feedback",
        types: ["verification-verdict"],
        required: true,
        render: "json-frame",
        description: "The verification verdict.",
      },
      workspaceInput(false),
    ],
    // Optional, as for Build: today's Fix turn submits no fix result.
    outputs: [workspaceOutput(false), fixResultOutput(false)],
    profiles: ["builder"],
    backend: "fixPrompt (build-pipeline-prompts.ts)",
    textMaxBytes: 16 * KIB,
  },
  {
    id: "verify",
    label: "Verify",
    description:
      "Checks the committed change against the ticket's acceptance criteria and reports a verdict per criterion.",
    inputs: [
      ticketInput(true),
      workspaceInput(false),
      {
        name: "address",
        types: ["fix-result"],
        required: false,
        render: "json-frame",
        description: "What the Address stage reported, when it ran.",
      },
      recordedValidationInput,
    ],
    outputs: [
      {
        name: "verdict",
        types: ["verification-verdict"],
        required: true,
        description: "The verdict, with a result per criterion.",
      },
      workspaceOutput(false),
    ],
    profiles: ["verifier"],
    backend: "verificationPrompt (build-pipeline-prompts.ts)",
    textMaxBytes: 32 * KIB,
  },
  {
    id: "pull-request-description",
    label: "Pull request description",
    description:
      "Writes the pull request's title and description for the change. A system step opens or updates the pull request (D12).",
    inputs: [workspaceInput(true)],
    outputs: [
      {
        name: "description",
        types: ["pr-description"],
        required: true,
        description: "The title and body.",
      },
    ],
    profiles: ["observer", "reviewer"],
    backend:
      "none yet: prPrompt (build-pipeline-prompts.ts) pushes and opens the pull request itself, which no agent node may do (D12); 204 needs a description-only builder",
    textMaxBytes: 8 * KIB,
  },
  {
    id: "resolve-conflicts",
    label: "Resolve conflicts",
    description:
      "Merges the target branch and resolves every conflict, validating the resolution as the repository asks, then commits locally. A system step pushes (D12).",
    inputs: [workspaceInput(true)],
    outputs: [workspaceOutput(true)],
    profiles: ["builder"],
    backend:
      "resolveConflictsPrompt (build-pipeline-prompts.ts) without its push sentence: an agent node may not push (D12); 204 needs that variant",
    textMaxBytes: 8 * KIB,
  },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, deepFreeze(definition)]));

export function isGraphBuiltInPromptId(value: unknown): value is GraphBuiltInPromptId {
  return typeof value === "string" && BY_ID.has(value as GraphBuiltInPromptId);
}

/** A built-in prompt by id. */
export function graphBuiltInPrompt(id: string): GraphBuiltInPromptDefinition | undefined {
  return BY_ID.get(id as GraphBuiltInPromptId);
}

/** Every built-in prompt, in a stable order. */
export function graphBuiltInPrompts(): readonly GraphBuiltInPromptDefinition[] {
  return DEFINITIONS;
}
