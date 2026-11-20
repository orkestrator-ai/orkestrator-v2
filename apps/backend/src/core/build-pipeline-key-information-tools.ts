/**
 * `get_key_information` and `update_key_information`: how a Build Pipeline's
 * stage agents keep the pipeline's key information current
 * (`build-pipeline-key-information.ts`).
 *
 * They are listed only to a credential whose environment a build pipeline
 * owns, on the general agent server and on a stage turn's workflow-result
 * server, so the Build, Fix, Address and Verify turns can reach them whichever
 * connection their turn runs on. They write only to the pipeline record.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import { describe, list, str, toolInput } from "./tool-schema.js";
import { describeJsonTextFault } from "./workflow-result-json-text.js";
import {
  KEY_INFORMATION_CHECK_STATUSES,
  KEY_INFORMATION_FRAMINGS,
  KEY_INFORMATION_ISSUE_STATUSES,
  KEY_INFORMATION_LIMITS,
  KEY_INFORMATION_TEST_RESULTS,
  KEY_INFORMATION_TOOL_NAMES,
  type KeyInformationCheck,
  type KeyInformationCheckStatus,
  type KeyInformationPatch,
} from "@orkestrator/protocol/build-pipeline-key-information";
import {
  MAX_PIPELINE_BUILD_STOP_REASON_LENGTH,
  PIPELINE_BUILD_STOP_KINDS,
  type PipelineBuildOutcomeInput,
} from "@orkestrator/protocol/build-pipeline-build-outcome";
import type {
  BuildPipelineKeyInformationHost,
  KeyInformationScope,
  KeyInformationView,
} from "./build-pipeline-key-information.js";

const [GET_TOOL, UPDATE_TOOL] = KEY_INFORMATION_TOOL_NAMES;

/** Inputs are bounded generously; the stored copy is cut to the record's limits. */
const INPUT_SLACK = 4;

// Each use builds its own schema so the published JSON Schema inlines every
// node rather than sharing one through `$ref`, which some providers reject.
const text = (limit: number) => str({ max: limit * INPUT_SLACK });
const textList = (items: number, limit: number) => list(text(limit), { max: items * INPUT_SLACK });

function updateInputSchema() {
  const limits = KEY_INFORMATION_LIMITS;
  return Schema.Struct({
    framing: Schema.optionalKey(
      describe(
        Schema.Literals(KEY_INFORMATION_FRAMINGS),
        "`problem` when the ticket fixes something wrong (the default); `objective` when it adds or changes something that was not broken.",
      ),
    ),
    summary: Schema.optionalKey(
      describe(
        text(limits.proseLength),
        "The change as a whole, in plain language for a reader who does not know the code: what changed and why it matters. No file names, identifiers or jargon. Two to four short paragraphs separated by a blank line, with `- ` bullet lines where the points are a list; never one long block.",
      ),
    ),
    statement: Schema.optionalKey(
      describe(
        text(limits.proseLength),
        "The problem being solved, or the objective being completed, in a few sentences. Separate paragraphs with a blank line; `- ` lines show as bullets.",
      ),
    ),
    context: Schema.optionalKey(
      describe(
        text(limits.proseLength),
        "The situation around the work: where it lives, what it affects, constraints. Separate paragraphs with a blank line; `- ` lines show as bullets.",
      ),
    ),
    solution: Schema.optionalKey(
      describe(
        text(limits.proseLength),
        "The solution, as a reader would want it summarised. Separate paragraphs with a blank line; `- ` lines show as bullets.",
      ),
    ),
    workDone: Schema.optionalKey(
      describe(
        textList(limits.listItems, limits.itemLength),
        "What the agents did, one entry per notable piece of work.",
      ),
    ),
    decisions: Schema.optionalKey(
      describe(
        list(
          Schema.Struct({
            decision: describe(
              text(limits.decisionLength),
              "The material technical choice the user should know about.",
            ),
            options: list(
              Schema.Struct({
                option: text(limits.optionLength),
                pros: textList(limits.prosCons, limits.optionLength),
                cons: textList(limits.prosCons, limits.optionLength),
              }),
              { max: limits.options * INPUT_SLACK },
            ),
            chosen: describe(text(limits.optionLength), "The option implemented or selected."),
            rationale: Schema.optionalKey(
              describe(
                text(limits.rationaleLength),
                "Brief engineering justification supported by requirements, code, constraints or tests; never private internal reasoning or chain of thought.",
              ),
            ),
          }),
          { max: limits.decisions * INPUT_SLACK },
        ),
        "Concise records of material technical decisions: the chosen option and relevant alternatives with engineering pros and cons. Do not invent alternatives or claim an exhaustive record of options considered. Do not perform reasoning extraction or disclose or reconstruct private internal reasoning, hidden deliberations or chain of thought.",
      ),
    ),
    notDone: Schema.optionalKey(
      describe(
        textList(limits.listItems, limits.itemLength),
        "What was not done or needs further work.",
      ),
    ),
    tests: Schema.optionalKey(
      describe(
        list(
          Schema.Struct({
            name: describe(text(limits.testNameLength), "The command or test that ran."),
            result: Schema.Literals(KEY_INFORMATION_TEST_RESULTS),
            details: Schema.optionalKey(text(limits.itemLength)),
          }),
          { max: limits.tests * INPUT_SLACK },
        ),
        "The tests and checks that were run, with their result.",
      ),
    ),
    issues: Schema.optionalKey(
      describe(
        list(
          Schema.Struct({
            issue: text(limits.issueLength),
            severity: Schema.optionalKey(text(limits.severityLength)),
            resolution: describe(text(limits.resolutionLength), "How it was solved, or why not."),
            status: Schema.Literals(KEY_INFORMATION_ISSUE_STATUSES),
          }),
          { max: limits.issues * INPUT_SLACK },
        ),
        "The current round's review issues and how each was handled. Replaces this round's issues only; earlier rounds are kept.",
      ),
    ),
    verification: Schema.optionalKey(
      describe(
        Schema.Struct({
          passed: Schema.optionalKey(Schema.Boolean),
          summary: text(limits.summaryLength),
          checks: list(
            Schema.Struct({
              check: text(limits.checkLength),
              status: Schema.optionalKey(
                describe(
                  Schema.Literals(KEY_INFORMATION_CHECK_STATUSES),
                  "`passed`, `failed`, or `not-checked` for a check you did not or could not run (it needs a live provider, another platform, credentials or a person). Never record a check you did not run as `failed`.",
                ),
              ),
              passed: Schema.optionalKey(
                describe(
                  Schema.Boolean,
                  "Older form of `status`: true is passed, false is failed. Prefer `status`.",
                ),
              ),
              details: Schema.optionalKey(
                describe(
                  text(limits.itemLength),
                  "What failed; for `not-checked`, required: why it was not checked.",
                ),
              ),
            }).check(
              Schema.makeFilter((check) => checkInputProblem(check) ?? true, {
                toJsonSchema: () => ({}),
              }),
            ),
            { max: limits.checks * INPUT_SLACK },
          ),
        }),
        "The current round's verification: each check with its status (`passed`, `failed` or `not-checked`), what failed, and why a not-checked check was not run. Replaces this round's entry only.",
      ),
    ),
    capability: Schema.optionalKey(
      describe(
        str({ max: 4096 }),
        "Signed worker or workflow capability, required on a shared connection when reporting a Build outcome.",
      ),
    ),
    continueReview: Schema.optionalKey(
      describe(
        Schema.Boolean,
        "Build stage only. `true` when the work is ready for the rest of the pipeline (package preparation, validation, review, fixes, verification and the pull request). `false` when none of that should run: no work was needed, or the build had to stop. Omitting it continues the pipeline.",
      ),
    ),
    stopKind: Schema.optionalKey(
      describe(
        Schema.Literals(PIPELINE_BUILD_STOP_KINDS),
        "Build stage only, with `continueReview: false`. `no-work-needed` completes the pipeline without review or a pull request (the default); `blocked` pauses it for the user, who can resume the Build.",
      ),
    ),
    stopReason: Schema.optionalKey(
      describe(
        str({ max: MAX_PIPELINE_BUILD_STOP_REASON_LENGTH * INPUT_SLACK }),
        "Required with `continueReview: false`: why the pipeline stops, in a sentence or two the user can act on.",
      ),
    ),
  });
}

/** A check as the tool takes it: `status`, or the older `passed`, or both when they agree. */
interface CheckInput {
  check: string;
  status?: KeyInformationCheckStatus;
  passed?: boolean;
  details?: string;
}

/** Why a check is refused, or undefined when it is well formed. */
function checkInputProblem(check: CheckInput): string | undefined {
  if (check.status === undefined && check.passed === undefined) {
    return "Give the check a `status`: `passed`, `failed` or `not-checked`.";
  }
  if (
    check.status !== undefined &&
    check.passed !== undefined &&
    check.passed !== (check.status === "passed")
  ) {
    return `\`passed: ${check.passed}\` contradicts \`status: "${check.status}"\`. Give only \`status\`.`;
  }
  if (check.status === "not-checked" && !check.details?.trim()) {
    return "A `not-checked` check needs `details` saying why it was not checked (for example what it needs that is missing here).";
  }
  return undefined;
}

function toCheck(input: CheckInput): KeyInformationCheck {
  const status: KeyInformationCheckStatus = input.status ?? (input.passed ? "passed" : "failed");
  return {
    check: input.check,
    passed: status === "passed",
    status,
    ...(input.details !== undefined ? { details: input.details } : {}),
  };
}

/**
 * Appended to every refusal of `update_key_information`: the arguments it
 * takes, so a model that sent a malformed call can repair it in one step.
 */
const KEY_INFORMATION_UPDATE_SHAPE = [
  "Expected arguments are one JSON object. Include only sections you want to replace. Send structured fields as arrays or objects directly.",
  `Use ${KEY_INFORMATION_FRAMINGS.join(" or ")} for framing. Use strings for summary, statement, context and solution, and arrays of strings for workDone and notDone.`,
  "Each decisions entry needs decision, options (entries with option, pros and cons), and chosen. You may add rationale.",
  `Each tests entry needs name and result (${KEY_INFORMATION_TEST_RESULTS.join(", ")}). You may add details.`,
  `Each issues entry needs issue, resolution and status (${KEY_INFORMATION_ISSUE_STATUSES.join(", ")}). You may add severity.`,
  `A verification needs summary and a checks array. You may add a round-level passed boolean. Each check entry needs check and status (${KEY_INFORMATION_CHECK_STATUSES.join(", ")}). Use details to explain a failed check or give the required reason for a not-checked check. Older calls may use a passed boolean for each check.`,
  'Example verification update\n{"verification":{"summary":"Live sign-in could not run","checks":[{"check":"Live sign-in","status":"not-checked","details":"No test account was available"}]}}',
].join("\n");

/** The fields a model may send as a string of JSON instead of the value. */
const JSON_TEXT_FIELDS = [
  "workDone",
  "notDone",
  "decisions",
  "tests",
  "issues",
  "verification",
] as const;

type PreparedInput =
  | { readonly value: unknown }
  | { readonly issues: ReadonlyArray<{ message: string; path?: PropertyKey[] }> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a field sent as JSON text. Text that does not look like JSON (a
 * plain sentence) is left for the schema to refuse as the wrong type.
 */
function parseJsonTextField(
  raw: string,
  path: PropertyKey[],
  expected: "array" | "object",
): { ok: true; value: unknown } | { ok: false; issue: { message: string; path: PropertyKey[] } } {
  if (!/^[[{"]/.test(raw.trimStart())) return { ok: true, value: raw };
  let text = raw;
  try {
    let value: unknown = JSON.parse(text);
    if (typeof value === "string" && /^[[{]/.test(value.trimStart())) {
      text = value;
      value = JSON.parse(text);
    }
    return { ok: true, value };
  } catch {
    const fault = describeJsonTextFault(text, expected);
    const decoded = text === raw ? "" : " after decoding the outer JSON string";
    const message = [
      `was sent as a string of JSON text, and it is not valid JSON${decoded}: ${fault.location}`,
      fault.advice,
      `Near the fault: ${fault.excerpt}. Fix that point and send the JSON ${expected} directly.`,
    ]
      .filter(Boolean)
      .join(" ");
    return { ok: false, issue: { message, path } };
  }
}

/**
 * Accepts the structured fields sent as JSON text, as some models do: valid
 * text is used as the value it encodes, and invalid text is refused with
 * where it breaks rather than with "expected an array, received a string".
 */
export function prepareKeyInformationInput(input: unknown): PreparedInput {
  if (!isRecord(input)) return { value: input };
  const next: Record<string, unknown> = { ...input };
  const issues: Array<{ message: string; path: PropertyKey[] }> = [];
  for (const field of JSON_TEXT_FIELDS) {
    const raw = next[field];
    if (typeof raw !== "string") continue;
    const parsed = parseJsonTextField(raw, [field], field === "verification" ? "object" : "array");
    if (parsed.ok) next[field] = parsed.value;
    else issues.push(parsed.issue);
  }
  const verification = next.verification;
  if (isRecord(verification) && typeof verification.checks === "string") {
    const parsed = parseJsonTextField(verification.checks, ["verification", "checks"], "array");
    if (parsed.ok) next.verification = { ...verification, checks: parsed.value };
    else issues.push(parsed.issue);
  }
  return issues.length > 0 ? { issues } : { value: next };
}

type UpdateInput = Omit<KeyInformationPatch, "verification"> & {
  verification?: Omit<NonNullable<KeyInformationPatch["verification"]>, "checks"> & {
    checks: CheckInput[];
  };
  capability?: string;
  continueReview?: boolean;
  stopKind?: PipelineBuildOutcomeInput["stopKind"];
  stopReason?: string;
};

/** Splits the tool input into the brief's patch and the Build outcome, if any. */
export function splitKeyInformationUpdate(input: UpdateInput): {
  patch: KeyInformationPatch;
  outcome?: PipelineBuildOutcomeInput;
} {
  const {
    continueReview,
    stopKind,
    stopReason,
    capability: _capability,
    verification,
    ...rest
  } = input;
  const patch: KeyInformationPatch = verification
    ? { ...rest, verification: { ...verification, checks: verification.checks.map(toCheck) } }
    : rest;
  if (continueReview === true && (stopKind !== undefined || stopReason !== undefined)) {
    throw new Error("`stopKind` and `stopReason` need `continueReview: false`.");
  }
  if (continueReview === undefined) {
    if (stopKind !== undefined || stopReason !== undefined) {
      throw new Error("`stopKind` and `stopReason` need `continueReview: false`.");
    }
    return { patch };
  }
  return {
    patch,
    outcome: {
      continueReview,
      ...(stopKind !== undefined ? { stopKind } : {}),
      ...(stopReason !== undefined ? { stopReason } : {}),
    },
  };
}

function viewResult(view: KeyInformationView) {
  const value = { ...view } as unknown as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/**
 * Registers both tools when a build pipeline owns the scope's environment.
 * Resolves whether it registered them.
 */
export async function registerKeyInformationTools(
  server: McpServer,
  host: BuildPipelineKeyInformationHost,
  scope: KeyInformationScope,
  resolveOutcomeScope?: (capability: string | undefined) => Promise<KeyInformationScope>,
): Promise<boolean> {
  const owner = await host.read(scope).catch(() => null);
  if (!owner) return false;
  server.registerTool(
    GET_TOOL,
    {
      title: "Read the pipeline's key information",
      description:
        "Read the key information of the build pipeline you are working in: the summary, the problem or objective, context, solution, work done, decisions, what was not done, tests, review issues and verification results recorded so far. Read it before updating so you keep what earlier stages wrote.",
      inputSchema: toolInput(Schema.Struct({})),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const view = await host.read(scope);
      if (!view) throw new Error("No build pipeline owns this environment.");
      return viewResult(view);
    },
  );
  server.registerTool(
    UPDATE_TOOL,
    {
      title: "Update the pipeline's key information",
      description:
        "Update the key information the user reads in the build pipeline header. Each field you pass replaces that whole section, so include the entries you want to keep; omitted fields are left unchanged. `issues` and `verification` apply to the current round only. The Build stage also says here whether the rest of the pipeline should run (`continueReview`, with `stopKind` and `stopReason` when it should not). Write for a reader who has not seen the transcript: short, specific and accurate. Record observable work and concise engineering decision summaries only. Do not perform reasoning extraction: do not disclose, reconstruct or request private internal reasoning, hidden deliberations or chain of thought.",
      inputSchema: toolInput(updateInputSchema(), {
        prepare: prepareKeyInformationInput,
        refusalNote: KEY_INFORMATION_UPDATE_SHAPE,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const { patch, outcome } = splitKeyInformationUpdate(input as UpdateInput);
      if (!outcome && Object.values(patch).every((value) => value === undefined)) {
        throw new Error(
          `Provide at least one key information section to update. ${KEY_INFORMATION_UPDATE_SHAPE}`,
        );
      }
      const caller =
        outcome && resolveOutcomeScope
          ? await resolveOutcomeScope((input as UpdateInput).capability)
          : scope;
      return viewResult(await host.update(caller, patch, outcome));
    },
  );
  return true;
}
