/**
 * System actions, version 1 (plan P2.7, D12, D20; report §6.6): what each
 * backend action reads, produces and takes as parameters. Browser-safe.
 *
 * The compiler checks every system node against its action's spec
 * (`compile-system.ts`), so the designer reports a bad parameter or a port
 * the action cannot read before a run starts; the backend executor
 * (`graph-node-system.ts`) reads the same table.
 *
 * - **Ports bind by type, not by name.** An action reads at most one input
 *   per type it lists and produces each output type it lists on whichever
 *   port declares it; `open-pull-request` reads its `workspace@1` from a port
 *   called `code` in one template and `target` in another. An `error` output
 *   (`error@1`) is always allowed, for `onFailure: route`.
 * - **Parameters** are scalars (101's bounded record). Unknown keys, wrong
 *   types, out-of-range values and contradictory combinations are compile
 *   errors; absent ones take the default here ({@link graphSystemActionParams}).
 * - **`sideEffect`** is the seam for mock runs (item 213): an action that
 *   changes something outside the run's own records (an environment, the
 *   remote, a pull request, a ticket, a mailbox, the worktree through
 *   validation commands) must record "would have run" in a mock run instead.
 *   `wait-for-checks` only reads.
 */
import type { ArtifactTypeDef } from "./artifact-type-def.js";
import { pullRequestStateType } from "./builtins/build-pipeline.js";
import type { GraphRewind } from "./run-model.js";
import type {
  GraphScalarValue,
  GraphSystemAction,
  GraphSystemParamValue,
} from "./template-model.js";

/** `wait-for-checks` waits this long by default (D20). */
export const GRAPH_WAIT_FOR_CHECKS_DEFAULT_MINUTES = 60;
/** …and never longer than this (D20). */
export const GRAPH_WAIT_FOR_CHECKS_MAX_MINUTES = 360;

/** Kanban columns `update-ticket` may move a ticket to. */
export const GRAPH_TICKET_STATUSES = ["backlog", "in-progress", "review", "done"] as const;
export type GraphTicketStatus = (typeof GRAPH_TICKET_STATUSES)[number];

/**
 * Today's Build Pipeline ticket lifecycle, by event (the backend's
 * `BUILD_PIPELINE_KANBAN_LIFECYCLE` holds the column and comment of each, and
 * the pipeline itself reads it): `build-started` (in progress, "Build
 * started"), `validation-complete` (comment), `pr-raised` (review, the PR
 * link and comment; needs a `pr-result@1` input), `complete` (review) and
 * `failed` (backlog).
 */
export const GRAPH_TICKET_LIFECYCLE_EVENTS = [
  "build-started",
  "validation-complete",
  "pr-raised",
  "complete",
  "failed",
] as const;
export type GraphTicketLifecycleEvent = (typeof GRAPH_TICKET_LIFECYCLE_EVENTS)[number];

/** What `select-workspace` does when the decision names no successful branch (item 403). */
export const GRAPH_SELECT_FALLBACKS = ["fail", "first"] as const;
export type GraphSelectFallback = (typeof GRAPH_SELECT_FALLBACKS)[number];

/** Who `notify` mails. */
export const GRAPH_NOTIFY_TARGETS = ["coordinator", "tab"] as const;

/** Bounds of the free-text parameters. */
export const GRAPH_SYSTEM_PARAM_BOUNDS = Object.freeze({
  /** A Kanban comment (`update-ticket`). */
  commentChars: 2_000,
  /**
   * A mail body before any appended input (`notify`). The template schema caps
   * every parameter string at 2 KiB, so this stays within it.
   */
  messageChars: 2_000,
  /** A mail subject (agent mail's own cap). */
  subjectChars: 200,
  /** Ids and branch names. */
  idChars: 200,
});

export type GraphSystemParamSpec =
  | { type: "boolean"; default?: boolean; description: string }
  | { type: "integer"; min: number; max: number; default?: number; description: string }
  | {
      type: "string";
      maxChars: number;
      /** `branch`: a git branch name; `id`: one line without spaces. */
      format?: "branch" | "id" | "text";
      description: string;
    }
  | { type: "enum"; options: readonly string[]; default?: string; description: string };

export interface GraphSystemActionPort {
  /** `name@version`. */
  type: string;
  required: boolean;
  description: string;
}

export interface GraphSystemActionSpec {
  action: GraphSystemAction;
  label: string;
  description: string;
  /** Changes something outside the run's records; a mock run records "would have run" (213). */
  sideEffect: boolean;
  /** What a retry or a restart of the node will not repeat (the backend's effect journal). */
  idempotency: string;
  params: Readonly<Record<string, GraphSystemParamSpec>>;
  inputs: readonly GraphSystemActionPort[];
  outputs: readonly GraphSystemActionPort[];
}

const port = (type: string, required: boolean, description: string): GraphSystemActionPort => ({
  type,
  required,
  description,
});

const TARGET_BRANCH: GraphSystemParamSpec = {
  type: "string",
  maxChars: GRAPH_SYSTEM_PARAM_BOUNDS.idChars,
  format: "branch",
  description: "The branch to compare against; default the project's pull request base branch.",
};

/** The type `open-pull-request` reports a pull request's merge state as (item 108). */
export const GRAPH_PULL_REQUEST_STATE_TYPE = "pull-request-state@1";

/**
 * The definition of {@link GRAPH_PULL_REQUEST_STATE_TYPE} the action
 * produces: the Build Pipeline template's custom type, mirroring
 * `PullRequestDetection`. A template declares it as a custom type (it is not
 * built in); the compiler requires the declared one to accept this shape.
 */
export function graphPullRequestStateType(): ArtifactTypeDef {
  return pullRequestStateType();
}

export const GRAPH_SYSTEM_ACTION_SPECS: Readonly<Record<GraphSystemAction, GraphSystemActionSpec>> =
  Object.freeze({
    "prepare-environment": {
      action: "prepare-environment",
      label: "Prepare environment",
      description:
        "Starts the run's environment (created by the run's provisioner when the template asks for a new one), runs its setup script once, and reports the commit work starts from.",
      sideEffect: true,
      idempotency:
        "Once per run, node and iteration: a retry or restart reports the same commit without starting or setting up again.",
      params: {
        setup: {
          type: "boolean",
          default: true,
          description: "Run the environment's setup script when it has not completed.",
        },
      },
      inputs: [port("ticket@1", false, "Orders the node after the ticket; not read otherwise.")],
      outputs: [port("workspace@1", false, "The branch and the commit work starts from.")],
    },
    "run-validation": {
      action: "run-validation",
      label: "Run validation",
      description:
        "Runs the validation plan's commands in the environment, through the review validation worker, and reports what failed. Nothing is sealed.",
      sideEffect: true,
      idempotency:
        "One validation run per run, node, iteration and plan; a retry or restart reads the same run's results. A run that was cancelled is started again.",
      params: {
        outputBytes: {
          type: "integer",
          min: 1_024,
          max: 32_768,
          default: 8_192,
          description: "Bytes of each failing command's output (its tail) to report.",
        },
      },
      inputs: [
        port("validation-plan@1", true, "The commands to run, for the commit they name."),
        port("workspace@1", true, "The commit to validate; it must be the environment's HEAD."),
      ],
      outputs: [
        port("validation-results@1", false, "The outcome and each failing command."),
        port("workspace@1", false, "The validated commit, passed through."),
      ],
    },
    "run-validation-and-seal": {
      action: "run-validation-and-seal",
      label: "Validate and seal",
      description:
        "Runs the validation plan once, then seals one immutable, hash-verified review package (`generate_review_package`) every reviewer shares.",
      sideEffect: true,
      idempotency:
        "One validation run and one package per run, node, iteration and plan; a retry or restart reads them back.",
      params: { targetBranch: TARGET_BRANCH },
      inputs: [
        port("validation-plan@1", true, "The commands to run, for the commit they name."),
        port("workspace@1", true, "The commit to validate; it must be the environment's HEAD."),
      ],
      outputs: [port("review-package@2", false, "The sealed package, by reference.")],
    },
    "push-branch": {
      action: "push-branch",
      label: "Push branch",
      description:
        "Pushes a commit to the run's branch on origin. Force-with-lease only after a code rewind dropped commits the upstream had; otherwise a branch that moved is refused.",
      sideEffect: true,
      idempotency: "Once per run, branch and commit.",
      params: {},
      inputs: [port("workspace@1", true, "The branch and commit to push.")],
      outputs: [port("workspace@1", false, "The pushed commit, passed through.")],
    },
    "open-pull-request": {
      action: "open-pull-request",
      label: "Open pull request",
      description:
        "Pushes the commit, then opens the branch's pull request, or updates the one that exists (reopening it when closed), and reports its merge state.",
      sideEffect: true,
      idempotency:
        "One pull request per run and branch; pushes once per commit; title and body are set only when they differ.",
      params: {
        targetBranch: {
          ...TARGET_BRANCH,
          description: "The base branch; default the project's pull request base branch.",
        },
        draft: {
          type: "boolean",
          default: false,
          description: "Open a new pull request as a draft.",
        },
      },
      inputs: [
        port("workspace@1", true, "The branch and commit to publish."),
        port("pr-description@1", true, "The title and body an agent wrote (D12)."),
      ],
      outputs: [
        port("pr-result@1", false, "The pull request's URL."),
        port(
          GRAPH_PULL_REQUEST_STATE_TYPE,
          false,
          "URL, state and whether GitHub reports merge conflicts (null while unknown).",
        ),
      ],
    },
    "wait-for-checks": {
      action: "wait-for-checks",
      label: "Wait for checks",
      description:
        "Waits for the pull request's CI checks through the PR monitor, without polling of its own, within a bound, then reports passed, failed (with the failing checks), pending at timeout, or no checks.",
      sideEffect: false,
      idempotency: "The wait's deadline is fixed when it first starts; a restart keeps it.",
      params: {
        timeoutMinutes: {
          type: "integer",
          min: 1,
          max: GRAPH_WAIT_FOR_CHECKS_MAX_MINUTES,
          default: GRAPH_WAIT_FOR_CHECKS_DEFAULT_MINUTES,
          description: "How long to wait before reporting the checks still pending.",
        },
      },
      inputs: [
        port("pr-result@1", true, "The pull request."),
        port("workspace@1", false, "The commit the checks should be for."),
      ],
      outputs: [port("check-summary@1", false, "The checks' rolled-up state.")],
    },
    "update-ticket": {
      action: "update-ticket",
      label: "Update ticket",
      description:
        "Moves the run's Kanban ticket, comments on it, or records acceptance criteria results (`record_kanban_criteria_checks`), as the Build Pipeline does.",
      sideEffect: true,
      idempotency:
        "Once per run, node and iteration; a comment is never added twice, a column move or criteria result is set, not appended.",
      params: {
        lifecycle: {
          type: "enum",
          options: GRAPH_TICKET_LIFECYCLE_EVENTS,
          description: "One of the Build Pipeline's ticket updates, exactly as it makes them.",
        },
        status: {
          type: "enum",
          options: GRAPH_TICKET_STATUSES,
          description: "Move the ticket to this column.",
        },
        comment: {
          type: "string",
          maxChars: GRAPH_SYSTEM_PARAM_BOUNDS.commentChars,
          format: "text",
          description: "Add this comment, once.",
        },
        record: {
          type: "enum",
          options: ["criteria"],
          description: "Record the verdict's acceptance criteria results on the ticket.",
        },
        taskId: {
          type: "string",
          maxChars: GRAPH_SYSTEM_PARAM_BOUNDS.idChars,
          format: "id",
          description: "The ticket; default the Kanban ticket linked to the run's environment.",
        },
      },
      inputs: [
        port("verification-verdict@1", false, "The verdict whose criteria results to record."),
        port("pr-result@1", false, "The pull request a pr-raised update links."),
        port("ticket@1", false, "The ticket as the run saw it: criteria results match its text."),
      ],
      outputs: [],
    },
    notify: {
      action: "notify",
      label: "Notify",
      description:
        "Sends agent mail to the project's coordinator or a tab of the run's environment.",
      sideEffect: true,
      idempotency: "One message per run, node, iteration and branch (agent mail's request id).",
      params: {
        to: {
          type: "enum",
          options: GRAPH_NOTIFY_TARGETS,
          description: "The project's coordinator, or a tab of the run's environment.",
        },
        tabId: {
          type: "string",
          maxChars: GRAPH_SYSTEM_PARAM_BOUNDS.idChars,
          format: "id",
          description: "The tab to mail when `to` is tab.",
        },
        subject: {
          type: "string",
          maxChars: GRAPH_SYSTEM_PARAM_BOUNDS.subjectChars,
          format: "text",
          description: "A one-line subject.",
        },
        message: {
          type: "string",
          maxChars: GRAPH_SYSTEM_PARAM_BOUNDS.messageChars,
          format: "text",
          description: "The message; a text or markdown input is appended to it.",
        },
      },
      inputs: [
        port("text@1", false, "Appended to the message."),
        port("markdown@1", false, "Appended to the message."),
      ],
      outputs: [],
    },
    "select-workspace": {
      action: "select-workspace",
      label: "Select branch",
      description:
        "Picks one isolated branch's commit (item 403): the decision's choice names the branch, and the run's branch is fast-forwarded to its commit. Every candidate branch's worktree and branch is then removed.",
      sideEffect: true,
      idempotency:
        "Once per run, node, iteration and chosen commit; a retry or restart reports the same commit without moving the branch again.",
      params: {
        fallback: {
          type: "enum",
          options: GRAPH_SELECT_FALLBACKS,
          default: "fail",
          description:
            "When the choice names no successful branch: fail the node, or take the first successful branch in branch order.",
        },
      },
      inputs: [
        port(
          "list<workspace@1>",
          true,
          "The candidate branches: the fan-in of a replicated node with isolation: worktree.",
        ),
        port(
          "decision@1",
          true,
          "Its choice names the winning branch: its branch key, the key's last part, or its Git branch.",
        ),
      ],
      outputs: [port("workspace@1", false, "The chosen commit, now on the run's branch.")],
    },
  } satisfies Record<GraphSystemAction, GraphSystemActionSpec>);

export function graphSystemActionSpec(action: GraphSystemAction): GraphSystemActionSpec {
  return GRAPH_SYSTEM_ACTION_SPECS[action];
}

// ------------------------------------------------------------------ params

export const GRAPH_SYSTEM_PARAM_ISSUE_CODES = [
  "unknown",
  "type",
  "range",
  "format",
  "required",
  "conflict",
] as const;
export type GraphSystemParamIssueCode = (typeof GRAPH_SYSTEM_PARAM_ISSUE_CODES)[number];

export interface GraphSystemParamIssue {
  /** The parameter; absent for a rule about the node's parameters as a whole. */
  param?: string;
  code: GraphSystemParamIssueCode;
  message: string;
}

const BRANCH_PATTERN =
  /^(?!-)(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]+(?<!\/)(?<!\.lock)(?<!\.)$/;
const ID_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function checkParam(
  key: string,
  spec: GraphSystemParamSpec,
  value: GraphSystemParamValue,
): GraphSystemParamIssue | null {
  const issue = (code: GraphSystemParamIssueCode, message: string) => ({
    param: key,
    code,
    message,
  });
  if (Array.isArray(value) || value === null) {
    return issue("type", `${key} takes one ${spec.type === "enum" ? "option" : spec.type}`);
  }
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? null : issue("type", `${key} is true or false`);
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return issue("type", `${key} is a whole number`);
      }
      return value < spec.min || value > spec.max
        ? issue("range", `${key} is from ${spec.min} to ${spec.max}`)
        : null;
    case "enum":
      return typeof value === "string" && spec.options.includes(value)
        ? null
        : issue("type", `${key} is one of ${spec.options.join(", ")}`);
    case "string": {
      if (typeof value !== "string") return issue("type", `${key} is text`);
      if (value.trim().length === 0) return issue("format", `${key} must not be blank`);
      if (value.length > spec.maxChars) {
        return issue("range", `${key} is at most ${spec.maxChars} characters`);
      }
      if (spec.format === "branch" && !BRANCH_PATTERN.test(value)) {
        return issue("format", `${key} is not a valid branch name`);
      }
      if (spec.format === "id" && !ID_PATTERN.test(value)) {
        return issue("format", `${key} is one word without spaces`);
      }
      if (spec.format === "text" && CONTROL.test(value)) {
        return issue("format", `${key} must not contain control characters`);
      }
      return null;
    }
  }
}

/** Rules across one action's parameters. */
function crossParamIssues(
  action: GraphSystemAction,
  params: Readonly<Record<string, GraphSystemParamValue>>,
): GraphSystemParamIssue[] {
  const issues: GraphSystemParamIssue[] = [];
  if (action === "notify") {
    if (params.to === undefined) {
      issues.push({ param: "to", code: "required", message: "notify needs `to`" });
    }
    if (params.message === undefined) {
      issues.push({ param: "message", code: "required", message: "notify needs a `message`" });
    }
    if (params.to === "tab" && params.tabId === undefined) {
      issues.push({ param: "tabId", code: "required", message: "Mailing a tab needs `tabId`" });
    }
    if (params.to === "coordinator" && params.tabId !== undefined) {
      issues.push({
        param: "tabId",
        code: "conflict",
        message: "`tabId` is only for `to: tab`; the coordinator has its own address",
      });
    }
  }
  if (action === "update-ticket") {
    const acts = ["lifecycle", "status", "comment", "record"].filter(
      (key) => params[key] !== undefined,
    );
    if (acts.length === 0) {
      issues.push({
        code: "required",
        message: "update-ticket needs at least one of lifecycle, status, comment or record",
      });
    }
    if (params.lifecycle !== undefined) {
      for (const key of ["status", "comment"]) {
        if (params[key] === undefined) continue;
        issues.push({
          param: key,
          code: "conflict",
          message: `\`lifecycle\` sets the column and comment itself; drop \`${key}\``,
        });
      }
    }
  }
  return issues;
}

/**
 * A system node's parameters against its action: unknown keys, types,
 * ranges, formats, required and contradictory combinations.
 */
export function checkGraphSystemParams(
  action: GraphSystemAction,
  params: Readonly<Record<string, GraphSystemParamValue>> = {},
): GraphSystemParamIssue[] {
  const spec = GRAPH_SYSTEM_ACTION_SPECS[action];
  const issues: GraphSystemParamIssue[] = [];
  for (const [key, value] of Object.entries(params)) {
    const paramSpec = spec.params[key];
    if (!paramSpec) {
      const known = Object.keys(spec.params);
      issues.push({
        param: key,
        code: "unknown",
        message: `${action} takes no parameter ${key}${known.length > 0 ? ` (it takes ${known.join(", ")})` : " (it takes none)"}`,
      });
      continue;
    }
    const issue = checkParam(key, paramSpec, value);
    if (issue) issues.push(issue);
  }
  return [...issues, ...crossParamIssues(action, params)];
}

/** Resolved parameters: what the node set, then each default. */
export type GraphSystemResolvedParams = Readonly<Record<string, GraphScalarValue | undefined>>;

/** A system node's parameters with defaults filled in. The node must have passed {@link checkGraphSystemParams}. */
export function graphSystemActionParams(
  action: GraphSystemAction,
  params: Readonly<Record<string, GraphSystemParamValue>> = {},
): GraphSystemResolvedParams {
  const resolved: Record<string, GraphScalarValue | undefined> = {};
  for (const [key, spec] of Object.entries(GRAPH_SYSTEM_ACTION_SPECS[action].params)) {
    const value = params[key];
    resolved[key] =
      value !== undefined && !Array.isArray(value)
        ? value
        : "default" in spec
          ? (spec.default as GraphScalarValue | undefined)
          : undefined;
  }
  return resolved;
}

/**
 * Inputs a node's parameters make required: `record: criteria` reads a
 * verdict, a `pr-raised` update links a pull request.
 */
export function graphSystemRequiredInputs(
  action: GraphSystemAction,
  params: Readonly<Record<string, GraphSystemParamValue>> = {},
): Array<{ type: string; because: string }> {
  const required = GRAPH_SYSTEM_ACTION_SPECS[action].inputs
    .filter((input) => input.required)
    .map((input) => ({ type: input.type, because: `${action} reads it` }));
  if (action === "update-ticket") {
    if (params.record === "criteria") {
      required.push({ type: "verification-verdict@1", because: "record: criteria reads it" });
    }
    if (params.lifecycle === "pr-raised") {
      required.push({ type: "pr-result@1", because: "a pr-raised update links it" });
    }
  }
  return required;
}

// ------------------------------------------------------------------ pushes

/**
 * The code rewind the next push of the run's branch must force over, if any
 * (P2.10, D12): the newest `rewind-code` that dropped commits the upstream
 * already had, unless a push has completed since (`pushedAfter` holds the
 * rewind ids a completed forced push consumed). Every other push is a plain
 * push, so a branch someone else moved is refused, never overwritten.
 */
export function graphForcePushRewind(
  rewinds: readonly GraphRewind[],
  pushedAfter: ReadonlySet<string>,
): { rewindId: string; upstream: string } | null {
  const rewind = rewinds.findLast((entry) => entry.kind === "rewind-code" && entry.code);
  const code = rewind?.code;
  if (!rewind || !code?.upstream || !code.upstreamCommitsDropped) return null;
  return pushedAfter.has(rewind.id) ? null : { rewindId: rewind.id, upstream: code.upstream };
}
