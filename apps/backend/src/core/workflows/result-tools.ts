import type { McpServer } from "@modelcontextprotocol/server";
import type {
  WorkflowResultKind,
  WorkflowResultSubmission,
  WorkflowResultValidation,
} from "@orkestrator/protocol/workflow-results";
import {
  REPORT_FINDING_TOOL_NAME,
  WORKFLOW_RESULT_KINDS,
  WORKFLOW_RESULT_TOOL_META,
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultToolName,
} from "@orkestrator/protocol/workflow-results";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import { STRUCTURED_REVIEW_REPORT_JSON_SCHEMA } from "@orkestrator/protocol/structured-review";
import { Schema } from "effect";
import {
  jsonSchemaField,
  jsonSchemaFieldCheck,
  str,
  strictObject,
  toolInput,
} from "../tool-schema.js";
import {
  CONSOLIDATED_REVIEW_ANY_SLOT_JSON_SCHEMA,
  CONSOLIDATED_REVIEW_SUBMISSION_JSON_SCHEMA,
} from "../review/consolidation-scope.js";
// Registers the built-in kinds the registry functions below look up.
import "./result-contracts.js";
import { graphOutputContext } from "./result-graph-output.js";
import { acceptsOnlyDeclaredFields, decodeJsonTextResult } from "./result-json-text.js";
import {
  workflowResultAnySlotSchema,
  workflowResultKindDefinition,
  workflowResultProviderSchema,
  type WorkflowResultSlotView,
} from "./result-registry.js";
import type { WorkflowResultCallerScope, WorkflowResultService } from "./result-service.js";
import type { ProvisionalFindingSink, ReportFindingResult } from "../review/index.js";

export interface WorkflowResultToolScope extends WorkflowResultCallerScope {
  workflowResultKey: string;
  kind: WorkflowResultKind;
  /**
   * The slot-specific contract (`WorkflowResultService.binding().slot`).
   * Graph outputs carry their port schema, tool name and context. Scoped
   * consolidations carry the backend-filled lists in their context.
   */
  slot?: WorkflowResultSlotView;
}

function resultResponse(result: WorkflowResultSubmission | WorkflowResultValidation) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
    ...(!result.ok ? { isError: true as const } : {}),
  };
}

function storageFailure(): WorkflowResultSubmission {
  return {
    ok: false,
    error: {
      code: "storage_unavailable",
      nextAction: "lookup_or_resubmit",
      message:
        "The backend could not durably record or read the result. Check status before retrying.",
    },
  };
}

function capabilityDenied(): WorkflowResultSubmission {
  return {
    ok: false,
    error: {
      code: "capability_denied",
      nextAction: "stop",
      message: "This tool connection cannot access that workflow result key.",
    },
  };
}

/**
 * An attempt-scoped connection's bearer is bound to exactly one result key, so
 * a different key in the arguments is a transcription slip, not a reach for
 * another attempt. Naming the bound key discloses nothing the bearer cannot
 * already use, and lets the model correct the call instead of stopping.
 */
function resultKeyMismatch(expected: string): WorkflowResultSubmission {
  return {
    ok: false,
    error: {
      code: "invalid_result",
      nextAction: "correct",
      message: `This tool connection serves resultKey "${expected}". Repeat the call with that exact resultKey; nothing else needs to change.`,
      issues: [
        {
          path: "$.resultKey",
          code: "result_key_mismatch",
          message: `Expected "${expected}".`,
        },
      ],
    },
  };
}

/** The same correction for a connection that serves several slots (one activation). */
function resultKeysMismatch(expected: readonly string[]): WorkflowResultSubmission {
  const listed = expected.map((key) => `"${key}"`).join(", ");
  return {
    ok: false,
    error: {
      code: "invalid_result",
      nextAction: "correct",
      message: `This tool connection serves resultKeys ${listed}. Repeat the call with the resultKey of the output you mean; nothing else needs to change.`,
      issues: [
        {
          path: "$.resultKey",
          code: "result_key_mismatch",
          message: `Expected one of ${listed}.`,
        },
      ],
    },
  };
}

const validatedDigestSchema = str({ pattern: /^[a-f0-9]{64}$/ });

/**
 * Records a refused call against the slot it names, when the service can.
 * Test doubles and older services without the method are left alone.
 */
function recordRefusal(
  workflowResults: WorkflowResultService,
  scope: WorkflowResultCallerScope,
  resultKey: string,
  reason: string,
): void {
  if (typeof workflowResults.recordRefusedCall !== "function") return;
  try {
    workflowResults.recordRefusedCall(scope, resultKey, reason);
  } catch {
    // Counting is evidence for the user, never a reason to change the answer.
  }
}

/**
 * Counts a call the input check refused (the SDK answers it; the handler never
 * runs) against the slot it names. Only a key this connection serves is
 * counted, so a stray key cannot grow another slot's counters.
 */
function countInputRefusal(
  workflowResults: WorkflowResultService,
  scope: WorkflowResultCallerScope,
  servedKeys: readonly string[],
) {
  return (
    value: unknown,
    issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }>,
  ) => {
    if (typeof value !== "object" || value === null) return;
    const resultKey = (value as { resultKey?: unknown }).resultKey;
    if (typeof resultKey !== "string" || !servedKeys.includes(resultKey)) return;
    const reason = issues
      .map((issue) => {
        const path = (issue.path ?? []).map(String).join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    recordRefusal(workflowResults, scope, resultKey, reason || "The arguments were refused.");
  };
}

type DecodedResultArgument =
  { ok: true; result: unknown } | { ok: false; refusal: WorkflowResultSubmission; reason: string };

/** The checks for parsed JSON text and for a candidate repaired from invalid text. */
interface ResultAcceptance {
  check: (value: unknown) => true | string;
  checkRepair: ((value: unknown) => true | string) | undefined;
}

function resultAcceptance(schema: JsonSchema, kind: WorkflowResultKind): ResultAcceptance {
  const check = jsonSchemaFieldCheck(schema);
  // A custom graph port can accept distinct single-bracket repairs even with
  // a closed schema, for example by allowing both strings and nested arrays.
  return {
    check,
    checkRepair: kind !== "graph-output" && acceptsOnlyDeclaredFields(schema) ? check : undefined,
  };
}

/**
 * `result` as the tool's handler should use it. An object (already checked by
 * the input schema) or a missing value passes through. A string is JSON text:
 * it is parsed and the decoded object gets the same check the input schema
 * gives an object. Text that does not parse is refused with where it breaks,
 * so the model can repair that one point (issue #2470). Like an input-schema
 * refusal, this uses no correction attempt.
 *
 * Text whose only fault is one closing bracket too many is used without that
 * bracket for eligible built-in result kinds, when the closed acceptance
 * schema accepts the candidate. A stray closing bracket was the most common
 * reason a consolidation agent's first submission failed, forcing it to resend
 * the report. A repaired object that fails the check gets the original
 * JSON-text refusal, because the repair itself may be what broke it, followed
 * by what the check found in the repaired object, so a report with a second
 * fault can be fixed in one resend.
 */
function decodeResultArgument(
  result: unknown,
  acceptance: ResultAcceptance,
): DecodedResultArgument {
  if (typeof result !== "string") return { ok: true, result };
  const decoded = decodeJsonTextResult(result);
  if (!decoded.ok) {
    let afterRepair = "";
    if (decoded.repaired && acceptance.checkRepair) {
      const repairedCheck = acceptance.checkRepair(decoded.repaired.value);
      if (repairedCheck === true) return { ok: true, result: decoded.repaired.value };
      // Named too, so one resend can fix both faults.
      afterRepair = ` If the extra bracket is the \`${decoded.repaired.bracket}\` at character ${decoded.repaired.offset}, the object without it still does not match the contract: ${repairedCheck}.`;
    }
    return {
      ok: false,
      reason: decoded.summary,
      refusal: {
        ok: false,
        error: {
          code: "invalid_result",
          nextAction: "correct",
          message: `${decoded.message}${afterRepair}`,
          issues: [{ path: "$", code: "invalid_json_text", message: decoded.summary }],
        },
      },
    };
  }
  const checked = acceptance.check(decoded.value);
  if (checked === true) return { ok: true, result: decoded.value };
  const reason = `\`result\` was sent as a string of JSON text. It parses, but the object does not match the contract: ${checked}`;
  return {
    ok: false,
    reason,
    refusal: {
      ok: false,
      error: {
        code: "invalid_result",
        nextAction: "correct",
        message: `${reason}. Correct those fields and pass the result as a JSON object in \`result\`, not as a string.`,
        issues: [{ path: "$", code: "invalid_arguments", message: checked }],
      },
    },
  };
}

function submissionDescription(
  label: string,
  authorized: boolean,
  validationTool: string = WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
): string {
  return `Submit the complete and final ${label} for ${authorized ? "the authorized" : "this"} workflow attempt. One call validates and submits: an invalid ${label} is not accepted, and the refusal names each field at fault by its path, so correct those fields and call again. Calling ${validationTool} first is optional. Never use this tool for a probe, placeholder, partial draft, or transport test. Pass exactly one of \`result\` (the complete payload) or \`validatedDigest\` (the digest ${validationTool} returned, which commits that exact validated payload without re-sending it). The first accepted payload is final and cannot be replaced. Only retry an accepted submission with the exact same payload.`;
}

/**
 * Commits either a full payload or a previously validated one. Exactly one must
 * be given: both would be ambiguous, and neither would be an empty probe.
 */
async function commitSubmission(
  workflowResults: WorkflowResultService,
  scope: WorkflowResultCallerScope,
  resultKey: string,
  result: unknown,
  validatedDigest: string | undefined,
): Promise<WorkflowResultSubmission> {
  if ((result === undefined) === (validatedDigest === undefined)) {
    return {
      ok: false,
      error: {
        code: "invalid_result",
        nextAction: "correct",
        message: "Provide exactly one of `result` or `validatedDigest`.",
        issues: [
          {
            path: "$",
            code: "invalid_arguments",
            message:
              "Pass the complete `result`, or the `validatedDigest` from validation, not both.",
          },
        ],
      },
    };
  }
  return validatedDigest !== undefined
    ? workflowResults.submitValidated(scope, resultKey, validatedDigest)
    : workflowResults.submit(scope, resultKey, result);
}

/**
 * One entry of a report's `issues`, as `report_finding` takes it. Provenance
 * and the alternative fixes may be left out: the backend assigns the first and
 * the report carries the second.
 */
const PROVISIONAL_FINDING_OPTIONAL_FIELDS = new Set([
  "reviewModels",
  "reviewSourceIds",
  "alternativeFixes",
]);

function provisionalFindingJsonSchema(): JsonSchema {
  const issue = (
    STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as unknown as {
      properties: { issues: { items: JsonSchema & { required: readonly string[] } } };
    }
  ).properties.issues.items;
  return {
    ...issue,
    required: issue.required.filter((field) => !PROVISIONAL_FINDING_OPTIONAL_FIELDS.has(field)),
  };
}

function findingResponse(result: ReportFindingResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
    ...(!result.ok ? { isError: true as const } : {}),
  };
}

function findingDenied(): ReportFindingResult {
  return {
    ok: false,
    error: {
      code: "capability_denied",
      nextAction: "stop",
      message: "This tool connection cannot report findings for that result key.",
    },
  };
}

function findingResultKeyMismatch(expected: string): ReportFindingResult {
  return {
    ok: false,
    error: {
      code: "invalid_finding",
      nextAction: "correct",
      message: `This tool connection serves resultKey "${expected}". Repeat the call with that exact resultKey; nothing else needs to change.`,
    },
  };
}

function findingStorageFailure(): ReportFindingResult {
  return {
    ok: false,
    error: {
      code: "storage_unavailable",
      nextAction: "continue",
      message:
        "The backend could not record the finding. Keep reviewing; it still belongs in your report.",
    },
  };
}

const REPORT_FINDING_DESCRIPTION =
  "Report one finding of this review as soon as you are confident in it, so the user can follow your progress. Optional: the user sees it as provisional, and the report you submit must still list it. Pass the fields of one entry of the report's `issues` in `finding`. Repeating a call with the same finding is safe.";

const REPORT_FINDING_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const VALIDATION_DESCRIPTION =
  "Validate one complete workflow result without accepting it, consuming a correction attempt, or changing workflow state. Use this instead of probing the submission tool. A valid result returns a validatedDigest that the submission tool can commit without re-sending the result.";

/**
 * What the model reads about a graph output port (report §5.5): the port's
 * description and type beside the generic contract text. The type's schema is
 * the tool's input schema.
 */
function portDescription(scope: WorkflowResultToolScope): string {
  const context = graphOutputContext(scope.slot ?? {});
  if (!context) return "";
  const described = context.description ? ` ${context.description}` : "";
  return ` This is the \`${context.port}\` output, of type ${context.artifactType}.${described}`;
}

/** Registers the tools exposed by one attempt-scoped result capability. */
export function registerWorkflowResultTools(
  server: McpServer,
  workflowResults: WorkflowResultService,
  scope: WorkflowResultToolScope,
  findings?: ProvisionalFindingSink | null,
): void {
  registerWorkflowResultSlotTools(server, workflowResults, [scope], findings);
}

/**
 * Registers the tools of one activation's result slots: for each slot its
 * validation and submission tools (`validate_<port>` and `submit_<port>` for a
 * graph output port, the kind's tools otherwise), then one status tool that
 * answers for every slot. Each slot's tools answer only for that slot's key.
 * Tool names must not repeat across the slots.
 */
export function registerWorkflowResultSlotTools(
  server: McpServer,
  workflowResults: WorkflowResultService,
  scopes: readonly WorkflowResultToolScope[],
  findings?: ProvisionalFindingSink | null,
): void {
  if (scopes.length === 0) throw new Error("A result capability serves at least one slot");
  const names = new Set<string>();
  const slots = scopes.map((scope) => {
    const view = scope.slot ?? {};
    const definition = workflowResultKindDefinition(scope.kind);
    const tools = {
      submit: definition.toolName(view),
      validate: definition.validationToolName(view),
    };
    for (const name of [tools.submit, tools.validate]) {
      if (names.has(name))
        throw new Error(`Result tool ${name} is offered twice on one connection`);
      names.add(name);
    }
    return { scope, view, definition, tools };
  });
  for (const { scope, view, definition, tools } of slots) {
    const publishedSchema = workflowResultProviderSchema(scope.kind, view);
    // Saved prompts can still send full reports to a slot that now fills in scope.
    const acceptanceSchema =
      publishedSchema === CONSOLIDATED_REVIEW_SUBMISSION_JSON_SCHEMA
        ? CONSOLIDATED_REVIEW_ANY_SLOT_JSON_SCHEMA
        : publishedSchema;
    // A string is decoded by the handler, which reports where JSON text breaks.
    const resultSchema = jsonSchemaField(publishedSchema, acceptanceSchema, { jsonText: true });
    const acceptResult = resultAcceptance(acceptanceSchema, scope.kind);
    const onRefused = countInputRefusal(workflowResults, scope, [scope.workflowResultKey]);
    const graphPort = graphOutputContext(view);
    const port = portDescription(scope);
    server.registerTool(
      tools.validate,
      {
        title: graphPort ? `Validate ${graphPort.port}` : "Validate workflow result",
        description: graphPort
          ? `Validate one complete ${definition.label(view)} without accepting it, consuming a correction attempt, or changing workflow state. Use this instead of probing ${tools.submit}. A valid result returns a validatedDigest that ${tools.submit} can commit without re-sending the result.${port}`
          : VALIDATION_DESCRIPTION,
        inputSchema: toolInput(
          strictObject({
            resultKey: str({ uuid: true }),
            result: resultSchema,
          }),
          { onRefused },
        ),
        _meta: { ...WORKFLOW_RESULT_TOOL_META },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ resultKey, result }) => {
        if (resultKey !== scope.workflowResultKey) {
          return resultResponse(resultKeyMismatch(scope.workflowResultKey));
        }
        const decoded = decodeResultArgument(result, acceptResult);
        if (!decoded.ok) {
          recordRefusal(workflowResults, scope, resultKey, decoded.reason);
          return resultResponse(decoded.refusal);
        }
        try {
          return resultResponse(await workflowResults.validate(scope, resultKey, decoded.result));
        } catch {
          return resultResponse(storageFailure());
        }
      },
    );
    server.registerTool(
      tools.submit,
      {
        title: graphPort ? `Submit ${graphPort.port}` : "Submit workflow result",
        description: `${submissionDescription(definition.label(view), false, tools.validate)}${port}`,
        inputSchema: toolInput(
          strictObject({
            resultKey: str({ uuid: true }),
            result: Schema.optionalKey(resultSchema),
            validatedDigest: Schema.optionalKey(validatedDigestSchema),
          }),
          { onRefused },
        ),
        _meta: { ...WORKFLOW_RESULT_TOOL_META },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ resultKey, result, validatedDigest }) => {
        if (resultKey !== scope.workflowResultKey) {
          return resultResponse(resultKeyMismatch(scope.workflowResultKey));
        }
        const decoded = decodeResultArgument(result, acceptResult);
        if (!decoded.ok) {
          recordRefusal(workflowResults, scope, resultKey, decoded.reason);
          return resultResponse(decoded.refusal);
        }
        try {
          return resultResponse(
            await commitSubmission(
              workflowResults,
              scope,
              resultKey,
              decoded.result,
              validatedDigest,
            ),
          );
        } catch {
          return resultResponse(storageFailure());
        }
      },
    );
  }
  const keys = scopes.map((scope) => scope.workflowResultKey);
  const caller = scopes[0]!;
  server.registerTool(
    "get_workflow_result_status",
    {
      title: "Get workflow result status",
      description:
        "Check whether this workflow result was accepted before retrying. For an open result it also reports which validation and submission calls actually reached the backend.",
      inputSchema: toolInput(strictObject({ resultKey: str({ uuid: true }) })),
      _meta: { ...WORKFLOW_RESULT_TOOL_META },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ resultKey }) => {
      if (!keys.includes(resultKey)) {
        return resultResponse(
          keys.length === 1 ? resultKeyMismatch(keys[0]!) : resultKeysMismatch(keys),
        );
      }
      let status;
      try {
        status = await workflowResults.status(caller, resultKey);
      } catch {
        return resultResponse(storageFailure());
      }
      if (status) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(status) }],
          structuredContent: status as unknown as Record<string, unknown>,
        };
      }
      return resultResponse({
        ok: false,
        error: {
          code: "result_status_unavailable",
          nextAction: "stop",
          message: "The workflow result status is unavailable.",
        },
      });
    },
  );
  const only = scopes.length === 1 ? scopes[0]! : undefined;
  if (
    only &&
    findings &&
    only.kind === "review-report" &&
    findings.accepts(only, only.workflowResultKey)
  ) {
    registerReportFindingTool(server, only, findings);
  }
}

/**
 * A Multi Review reviewer's own attempt also takes `report_finding`. It is
 * listed only while the reviewer is live, so a build-pipeline reviewer, or one
 * that has finished, never sees it.
 */
function registerReportFindingTool(
  server: McpServer,
  scope: WorkflowResultToolScope,
  findings: ProvisionalFindingSink,
): void {
  server.registerTool(
    REPORT_FINDING_TOOL_NAME,
    {
      title: "Report a finding",
      description: REPORT_FINDING_DESCRIPTION,
      inputSchema: toolInput(
        strictObject({
          resultKey: str({ uuid: true }),
          finding: jsonSchemaField(provisionalFindingJsonSchema()),
        }),
      ),
      _meta: { ...WORKFLOW_RESULT_TOOL_META },
      annotations: REPORT_FINDING_ANNOTATIONS,
    },
    async ({ resultKey, finding }) => {
      if (resultKey !== scope.workflowResultKey) {
        return findingResponse(findingResultKeyMismatch(scope.workflowResultKey));
      }
      try {
        return findingResponse(await findings.report(scope, resultKey, finding));
      } catch {
        return findingResponse(findingStorageFailure());
      }
    },
  );
}

/**
 * Resolve the capability's own attempt before comparing caller-supplied keys.
 * Only disclose its key after authenticating scope, provider and result kind.
 */
async function brokerAttempt(
  workflowResults: WorkflowResultService,
  scope: WorkflowResultCallerScope,
  capability: string,
  kind?: WorkflowResultKind,
  resultKey?: string,
): Promise<{ key: string; kind: WorkflowResultKind } | null> {
  const authorized = await workflowResults.authenticateCapability(capability);
  let key: string | undefined;
  if (authorized) {
    if (
      authorized.environmentId !== scope.environmentId ||
      authorized.projectId !== scope.projectId
    ) {
      return null;
    }
    key = authorized.workflowResultKey;
  } else if (resultKey !== undefined) {
    // A graph activation on the broker presents one capability for every
    // output slot (item 204): it authorizes the slot the call names.
    const activation =
      typeof workflowResults.authenticateActivationCapability === "function"
        ? await workflowResults.authenticateActivationCapability(capability)
        : null;
    if (
      !activation ||
      activation.environmentId !== scope.environmentId ||
      activation.projectId !== scope.projectId ||
      !activation.workflowResultKeys.includes(resultKey)
    ) {
      return null;
    }
    key = resultKey;
  } else {
    return null;
  }
  const binding = await workflowResults.binding(scope, key);
  if (binding?.provider !== "opencode" || (kind !== undefined && binding.kind !== kind)) {
    return null;
  }
  return { key, kind: binding.kind };
}

/** Any object: the broker's validation tool serves every kind, and the service checks the slot. */
const BROKER_VALIDATION_RESULT_SCHEMA = { type: "object" } as const;
const checkBrokerValidationResult = jsonSchemaFieldCheck(BROKER_VALIDATION_RESULT_SCHEMA);

/**
 * Registers the stable OpenCode broker surface.
 *
 * The bearer credential identifies only the environment/project. Every call
 * must additionally present the signed, one-attempt capability embedded in the
 * trusted workflow prompt, so directory-scoped MCP registration cannot widen
 * access to another attempt.
 */
export function registerWorkflowResultBrokerTools(
  server: McpServer,
  workflowResults: WorkflowResultService,
  scope: WorkflowResultCallerScope,
  findings?: ProvisionalFindingSink | null,
): void {
  if (findings) {
    server.registerTool(
      REPORT_FINDING_TOOL_NAME,
      {
        title: "Report a finding",
        description: REPORT_FINDING_DESCRIPTION,
        inputSchema: toolInput(
          strictObject({
            resultKey: str({ uuid: true }),
            capability: str({ min: 32, max: 2_048 }),
            finding: jsonSchemaField(provisionalFindingJsonSchema()),
          }),
        ),
        _meta: { ...WORKFLOW_RESULT_TOOL_META },
        annotations: REPORT_FINDING_ANNOTATIONS,
      },
      async ({ resultKey, capability, finding }) => {
        try {
          const attempt = await brokerAttempt(workflowResults, scope, capability, "review-report");
          if (!attempt) return findingResponse(findingDenied());
          if (resultKey !== attempt.key) {
            return findingResponse(findingResultKeyMismatch(attempt.key));
          }
          return findingResponse(await findings.report(scope, resultKey, finding));
        } catch {
          return findingResponse(findingStorageFailure());
        }
      },
    );
  }

  const acceptances = new Map<WorkflowResultKind, ResultAcceptance>();
  for (const kind of WORKFLOW_RESULT_KINDS) {
    const anySlotSchema = workflowResultAnySlotSchema(kind);
    const acceptResult = resultAcceptance(anySlotSchema, kind);
    acceptances.set(kind, acceptResult);
    server.registerTool(
      workflowResultToolName(kind),
      {
        title: `Submit ${kind.replaceAll("-", " ")}`,
        description: submissionDescription(kind.replaceAll("-", " "), true),
        inputSchema: toolInput(
          strictObject({
            resultKey: str({ uuid: true }),
            capability: str({ min: 32, max: 2_048 }),
            // One tool serves every slot of the kind, so it takes any shape a
            // slot's own tool would; the service checks the slot's contract.
            result: Schema.optionalKey(
              jsonSchemaField(anySlotSchema, anySlotSchema, { jsonText: true }),
            ),
            validatedDigest: Schema.optionalKey(validatedDigestSchema),
          }),
        ),
        _meta: { ...WORKFLOW_RESULT_TOOL_META },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ resultKey, capability, result, validatedDigest }) => {
        try {
          const attempt = await brokerAttempt(workflowResults, scope, capability, kind, resultKey);
          if (!attempt) return resultResponse(capabilityDenied());
          if (resultKey !== attempt.key) return resultResponse(resultKeyMismatch(attempt.key));
          const decoded = decodeResultArgument(result, acceptResult);
          if (!decoded.ok) {
            recordRefusal(workflowResults, scope, resultKey, decoded.reason);
            return resultResponse(decoded.refusal);
          }
          return resultResponse(
            await commitSubmission(
              workflowResults,
              scope,
              resultKey,
              decoded.result,
              validatedDigest,
            ),
          );
        } catch {
          return resultResponse(storageFailure());
        }
      },
    );
  }

  server.registerTool(
    WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
    {
      title: "Validate workflow result",
      description:
        "Validate one complete authorized workflow result without accepting it, consuming a correction attempt, or changing workflow state. Use this instead of probing a submission tool. A valid result returns a validatedDigest that a submission tool can commit without re-sending the result.",
      inputSchema: toolInput(
        strictObject({
          resultKey: str({ uuid: true }),
          capability: str({ min: 32, max: 2_048 }),
          // Every result kind is an object; the service validates the contract.
          // z.json() would publish a recursive $ref that some providers reject.
          // JSON text is decoded by the handler, which says where it breaks.
          result: jsonSchemaField(
            BROKER_VALIDATION_RESULT_SCHEMA,
            BROKER_VALIDATION_RESULT_SCHEMA,
            {
              jsonText: true,
            },
          ),
        }),
      ),
      _meta: { ...WORKFLOW_RESULT_TOOL_META },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ resultKey, capability, result }) => {
      try {
        const attempt = await brokerAttempt(
          workflowResults,
          scope,
          capability,
          undefined,
          resultKey,
        );
        if (!attempt) return resultResponse(capabilityDenied());
        if (resultKey !== attempt.key) return resultResponse(resultKeyMismatch(attempt.key));
        // Keep the generic object check for valid JSON text. A repair needs
        // the same kind-specific check as submit, after authenticating the slot.
        const decoded = decodeResultArgument(result, {
          check: checkBrokerValidationResult,
          checkRepair: acceptances.get(attempt.kind)?.checkRepair,
        });
        if (!decoded.ok) {
          recordRefusal(workflowResults, scope, resultKey, decoded.reason);
          return resultResponse(decoded.refusal);
        }
        return resultResponse(await workflowResults.validate(scope, resultKey, decoded.result));
      } catch {
        return resultResponse(storageFailure());
      }
    },
  );

  server.registerTool(
    "get_workflow_result_status",
    {
      title: "Get workflow result status",
      description: "Check whether the authorized workflow result was accepted before retrying.",
      inputSchema: toolInput(
        strictObject({
          resultKey: str({ uuid: true }),
          capability: str({ min: 32, max: 2_048 }),
        }),
      ),
      _meta: { ...WORKFLOW_RESULT_TOOL_META },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ resultKey, capability }) => {
      try {
        const attempt = await brokerAttempt(
          workflowResults,
          scope,
          capability,
          undefined,
          resultKey,
        );
        if (!attempt) return resultResponse(capabilityDenied());
        if (resultKey !== attempt.key) return resultResponse(resultKeyMismatch(attempt.key));
        const status = await workflowResults.status(scope, resultKey);
        if (status) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(status) }],
            structuredContent: status as unknown as Record<string, unknown>,
          };
        }
      } catch {
        return resultResponse(storageFailure());
      }
      return resultResponse({
        ok: false,
        error: {
          code: "result_status_unavailable",
          nextAction: "stop",
          message: "The workflow result status is unavailable.",
        },
      });
    },
  );
}
