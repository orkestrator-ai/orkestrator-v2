/**
 * Address Findings and pull-request results: the provider-facing schemas and their domain
 * parsers. The backend validates workflow results of these kinds with them,
 * and the graph Address Findings and PR result types reuse them, so both live
 * here where the browser can run them too.
 */
import type { JsonSchema } from "./structured-output.js";

export interface ReviewAddressFindingsResult {
  complete: boolean;
  summary: string;
  filesChanged: string[];
  commandsRun: Array<{
    command: string;
    result: "passed" | "failed";
    summary: string;
    /** Multi Review only, and only when every remaining failure has evidence for an excuse. */
    excusedFailures?: Array<{
      failure: string;
      reason: "pre-existing" | "flaky" | "unrelated" | "environmental";
      evidence: string;
    }>;
  }>;
  notes: string[];
  limitations: string[];
}

export interface ReviewPrResult {
  status: "created";
  url: string;
  summary: string;
}

function addressFindingsResultSchema(scope: "pipeline" | "multi-review" | "graph"): JsonSchema {
  const excusedFailures: JsonSchema = {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["failure", "reason", "evidence"],
      properties: {
        failure: { type: "string" },
        reason: { type: "string", enum: [...EXCUSE_REASONS] },
        evidence: { type: "string" },
      },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["complete", "summary", "filesChanged", "commandsRun", "notes", "limitations"],
    properties: {
      complete: { type: "boolean" },
      summary: { type: "string" },
      filesChanged: { type: "array", items: { type: "string" } },
      commandsRun: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "command",
            "result",
            "summary",
            ...(scope === "graph" ? ["excusedFailures"] : []),
          ],
          properties: {
            command: { type: "string" },
            result: { type: "string", enum: ["passed", "failed"] },
            summary: { type: "string" },
            ...(scope !== "pipeline"
              ? {
                  excusedFailures: { anyOf: [excusedFailures, { type: "null" }] },
                }
              : {}),
          },
        },
      },
      notes: { type: "array", items: { type: "string" } },
      limitations: { type: "array", items: { type: "string" } },
    },
  };
}

const EXCUSE_REASONS = ["pre-existing", "flaky", "unrelated", "environmental"] as const;
export const REVIEW_ADDRESS_FINDINGS_RESULT_JSON_SCHEMA = addressFindingsResultSchema("pipeline");
export const MULTI_REVIEW_ADDRESS_FINDINGS_RESULT_JSON_SCHEMA =
  addressFindingsResultSchema("multi-review");
export const GRAPH_ADDRESS_FINDINGS_RESULT_V2_SCHEMA = addressFindingsResultSchema("graph");

export const REVIEW_PR_RESULT_JSON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "url", "summary"],
  properties: {
    status: { type: "string", enum: ["created"] },
    url: { type: "string" },
    summary: { type: "string" },
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function finalCommandResults(
  commands: ReviewAddressFindingsResult["commandsRun"],
): ReviewAddressFindingsResult["commandsRun"] {
  const final = new Map<string, ReviewAddressFindingsResult["commandsRun"][number]>();
  for (const command of commands) final.set(command.command.trim(), command);
  return [...final.values()];
}

export function isExcusedValidationFailures(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 128 &&
    value.every(
      (entry) =>
        record(entry) &&
        Object.keys(entry).length === 3 &&
        typeof entry.failure === "string" &&
        entry.failure.length <= 16_384 &&
        entry.failure.trim().length > 0 &&
        EXCUSE_REASONS.some((reason) => reason === entry.reason) &&
        typeof entry.evidence === "string" &&
        entry.evidence.length <= 16_384 &&
        entry.evidence.trim().length > 0,
    )
  );
}

export function parseAddressFindingsResult(
  value: unknown,
  { allowExcuses = false }: { allowExcuses?: boolean } = {},
): ReviewAddressFindingsResult {
  if (
    !record(value) ||
    typeof value.complete !== "boolean" ||
    typeof value.summary !== "string" ||
    value.summary.trim().length === 0 ||
    !textList(value.filesChanged) ||
    value.filesChanged.some((entry) => entry.trim().length === 0) ||
    new Set(value.filesChanged).size !== value.filesChanged.length ||
    !Array.isArray(value.commandsRun) ||
    !value.commandsRun.every(
      (entry) =>
        record(entry) &&
        typeof entry.command === "string" &&
        entry.command.trim().length > 0 &&
        (entry.result === "passed" || entry.result === "failed") &&
        typeof entry.summary === "string" &&
        entry.summary.trim().length > 0 &&
        (entry.excusedFailures === undefined ||
          (allowExcuses &&
            (entry.excusedFailures === null ||
              (entry.result === "failed" && isExcusedValidationFailures(entry.excusedFailures))))),
    ) ||
    !textList(value.notes) ||
    !textList(value.limitations)
  ) {
    throw new Error("Fix result failed runtime validation");
  }
  const notes = value.notes as string[];
  const limitations = value.limitations as string[];
  const result = {
    ...value,
    commandsRun: value.commandsRun.map((entry) => {
      if (entry.excusedFailures !== null) return entry;
      const { excusedFailures: _unused, ...command } = entry;
      return command;
    }),
    notes: notes.map((entry) => entry.trim()).filter(Boolean),
    limitations: limitations.map((entry) => entry.trim()).filter(Boolean),
  } as unknown as ReviewAddressFindingsResult;
  const blockers = [
    ...finalCommandResults(result.commandsRun).filter(
      (entry) => entry.result === "failed" && !entry.excusedFailures,
    ),
    ...result.limitations,
  ];
  if (result.complete && blockers.length > 0) {
    throw new Error(
      "Fix result cannot be complete while validation failures or limitations remain",
    );
  }
  if (!result.complete && blockers.length === 0) {
    throw new Error("Fix result cannot be incomplete without a failed validation or limitation");
  }
  return result;
}

export function parseMultiReviewAddressFindingsResult(value: unknown): ReviewAddressFindingsResult {
  return parseAddressFindingsResult(value, { allowExcuses: true });
}

export function parsePrResult(value: unknown): ReviewPrResult {
  if (
    !record(value) ||
    value.status !== "created" ||
    typeof value.url !== "string" ||
    typeof value.summary !== "string" ||
    value.summary.trim().length === 0
  ) {
    throw new Error("PR result failed runtime validation");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("PR result failed runtime validation");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(url.pathname)
  ) {
    throw new Error("PR result failed runtime validation");
  }
  return value as unknown as ReviewPrResult;
}
