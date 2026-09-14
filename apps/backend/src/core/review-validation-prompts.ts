import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import {
  REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION,
  reviewValidationDiscoveryBody,
  wrapSystemInstructions,
} from "@orkestrator/protocol/review-evidence-frames";

export const REVIEW_VALIDATION_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headRef", "commands", "limitations"],
  properties: {
    headRef: { type: "string" },
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "command", "cwd", "dependsOn", "resources", "weight", "timeoutMs"],
        properties: {
          id: { type: "string" },
          command: { type: "string" },
          cwd: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          resources: { type: "array", items: { type: "string" } },
          weight: { type: "integer", enum: [1, 2] },
          timeoutMs: { type: "integer" },
        },
      },
    },
    limitations: { type: "array", items: { type: "string" } },
  },
};

export function reviewValidationDiscoveryPrompt(targetBranch: string): string {
  return `${REVIEW_PACKAGE_PREPARATION_USER_INSTRUCTION}\n\n${wrapSystemInstructions(
    reviewValidationDiscoveryBody(targetBranch),
  )}`;
}

export const IMPLEMENTATION_VALIDATION_HANDOFF =
  "Commit every relevant implementation and test change without bypassing hooks. Run focused checks needed during implementation. The next preparation stage discovers and executes final full validation once against the committed snapshot; do not run a separate full test/typecheck/build pass or prepare validation artifacts here.";
