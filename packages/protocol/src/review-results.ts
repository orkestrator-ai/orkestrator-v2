/**
 * Fix and pull-request results: the provider-facing schemas and their domain
 * parsers. The backend validates workflow results of these kinds with them,
 * and graph types `fix-result@1` and `pr-result@1` reuse them, so both live
 * here where the browser can run them too.
 */
import type { JsonSchema } from "./structured-output.js";

export interface ReviewFixResult {
  complete: boolean;
  summary: string;
  filesChanged: string[];
  commandsRun: Array<{
    command: string;
    result: "passed" | "failed";
    summary: string;
  }>;
  notes: string[];
  limitations: string[];
}

export interface ReviewPrResult {
  status: "created";
  url: string;
  summary: string;
}

export const REVIEW_FIX_RESULT_JSON_SCHEMA: JsonSchema = {
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
        required: ["command", "result", "summary"],
        properties: {
          command: { type: "string" },
          result: { type: "string", enum: ["passed", "failed"] },
          summary: { type: "string" },
        },
      },
    },
    notes: { type: "array", items: { type: "string" } },
    limitations: { type: "array", items: { type: "string" } },
  },
};

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
  commands: ReviewFixResult["commandsRun"],
): ReviewFixResult["commandsRun"] {
  const final = new Map<string, ReviewFixResult["commandsRun"][number]>();
  for (const command of commands) final.set(command.command.trim(), command);
  return [...final.values()];
}

export function parseFixResult(value: unknown): ReviewFixResult {
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
        entry.summary.trim().length > 0,
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
    notes: notes.map((entry) => entry.trim()).filter(Boolean),
    limitations: limitations.map((entry) => entry.trim()).filter(Boolean),
  } as unknown as ReviewFixResult;
  const blockers = [
    ...finalCommandResults(result.commandsRun).filter((entry) => entry.result === "failed"),
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
