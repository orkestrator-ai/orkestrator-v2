/**
 * Bounded validator for the JSON-Schema subset workflow result contracts use.
 *
 * It lives in the protocol so the backend (submit-time validation of every
 * workflow result) and the browser (the graph designer checking a custom
 * type's example, mock runs) apply exactly the same rules. Supported keywords:
 * `type` (one string), `anyOf`, `const`, `enum`, `minimum`, `maximum`,
 * `minLength`, `maxLength`, `items`, `minItems`, `maxItems`, `properties`,
 * `required` and `additionalProperties: false`. Anything else is ignored here;
 * `graphs/schema-subset.ts` rejects it before a graph type can use it.
 */
import type { JsonSchema } from "./structured-output.js";
import type { WorkflowResultValidationIssue } from "./workflow-results.js";

/** Issues one validation reports at most. */
export const WORKFLOW_JSON_SCHEMA_MAX_ISSUES = 32;
/** Nesting depth beyond which a value is rejected rather than walked. */
export const WORKFLOW_JSON_SCHEMA_MAX_DEPTH = 32;
/** Array entries validated per array; longer arrays are rejected. */
export const WORKFLOW_JSON_SCHEMA_MAX_ARRAY_ITEMS = 4096;

function issue(path: string, code: string, message: string): WorkflowResultValidationIssue {
  return { path: path.slice(0, 256), code, message: message.slice(0, 512) };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaTypeMatches(type: unknown, value: unknown): boolean {
  if (type === "object") return record(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

/** Bounded validator for the JSON-Schema subset used by workflow result contracts. */
export function validateWorkflowJsonSchema(
  schema: JsonSchema | undefined,
  value: unknown,
): WorkflowResultValidationIssue[] {
  if (!schema) return [];
  const issues: WorkflowResultValidationIssue[] = [];
  const visit = (
    candidateSchema: unknown,
    candidate: unknown,
    path: string,
    depth: number,
  ): void => {
    if (issues.length >= WORKFLOW_JSON_SCHEMA_MAX_ISSUES) return;
    if (depth > WORKFLOW_JSON_SCHEMA_MAX_DEPTH) {
      issues.push(issue(path, "too_deep", "Result exceeds the maximum nesting depth"));
      return;
    }
    if (!record(candidateSchema)) return;
    if (Array.isArray(candidateSchema.anyOf)) {
      const alternatives = candidateSchema.anyOf;
      if (
        !alternatives.some(
          (alternative) =>
            validateWorkflowJsonSchema(alternative as JsonSchema, candidate).length === 0,
        )
      ) {
        issues.push(issue(path, "invalid_type", "Value does not match any allowed shape"));
      }
      return;
    }
    if (candidateSchema.const !== undefined && candidate !== candidateSchema.const) {
      issues.push(
        issue(path, "invalid_value", `Value must equal ${JSON.stringify(candidateSchema.const)}`),
      );
      return;
    }
    if (Array.isArray(candidateSchema.enum) && !candidateSchema.enum.includes(candidate)) {
      issues.push(
        issue(
          path,
          "invalid_enum",
          `Value must be one of ${candidateSchema.enum.map(String).join(", ")}`,
        ),
      );
      return;
    }
    if (!schemaTypeMatches(candidateSchema.type, candidate)) {
      issues.push(issue(path, "invalid_type", `Expected ${String(candidateSchema.type)}`));
      return;
    }
    if (typeof candidate === "number") {
      if (typeof candidateSchema.minimum === "number" && candidate < candidateSchema.minimum)
        issues.push(issue(path, "too_small", `Value must be at least ${candidateSchema.minimum}`));
      if (typeof candidateSchema.maximum === "number" && candidate > candidateSchema.maximum)
        issues.push(issue(path, "too_large", `Value must be at most ${candidateSchema.maximum}`));
    }
    if (typeof candidate === "string") {
      if (
        typeof candidateSchema.minLength === "number" &&
        candidate.length < candidateSchema.minLength
      )
        issues.push(
          issue(
            path,
            "too_short",
            `Text must contain at least ${candidateSchema.minLength} characters`,
          ),
        );
      if (
        typeof candidateSchema.maxLength === "number" &&
        candidate.length > candidateSchema.maxLength
      )
        issues.push(
          issue(
            path,
            "too_long",
            `Text must contain at most ${candidateSchema.maxLength} characters`,
          ),
        );
    }
    if (Array.isArray(candidate) && candidateSchema.items !== undefined) {
      if (
        typeof candidateSchema.minItems === "number" &&
        candidate.length < candidateSchema.minItems
      )
        issues.push(
          issue(
            path,
            "too_few_items",
            `Array must contain at least ${candidateSchema.minItems} items`,
          ),
        );
      if (
        typeof candidateSchema.maxItems === "number" &&
        candidate.length > candidateSchema.maxItems
      )
        issues.push(
          issue(
            path,
            "too_many_items",
            `Array must contain at most ${candidateSchema.maxItems} items`,
          ),
        );
      candidate
        .slice(0, WORKFLOW_JSON_SCHEMA_MAX_ARRAY_ITEMS)
        .forEach((entry, index) =>
          visit(candidateSchema.items, entry, `${path}[${index}]`, depth + 1),
        );
      if (candidate.length > WORKFLOW_JSON_SCHEMA_MAX_ARRAY_ITEMS)
        issues.push(issue(path, "too_many_items", "Array exceeds the validation item limit"));
      return;
    }
    if (!record(candidate)) return;
    const properties = record(candidateSchema.properties) ? candidateSchema.properties : {};
    const required = Array.isArray(candidateSchema.required)
      ? candidateSchema.required.filter((key): key is string => typeof key === "string")
      : [];
    for (const key of required) {
      if (!Object.hasOwn(candidate, key))
        issues.push(issue(`${path}.${key}`, "missing_field", "Required field is missing"));
    }
    if (candidateSchema.additionalProperties === false) {
      for (const key of Object.keys(candidate)) {
        if (!Object.hasOwn(properties, key))
          issues.push(issue(`${path}.${key}`, "unknown_field", "Field is not allowed"));
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(candidate, key))
        visit(propertySchema, candidate[key], `${path}.${key}`, depth + 1);
    }
  };
  visit(schema, value, "$", 0);
  return issues.slice(0, WORKFLOW_JSON_SCHEMA_MAX_ISSUES);
}
