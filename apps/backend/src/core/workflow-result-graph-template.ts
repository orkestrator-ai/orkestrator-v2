/**
 * The `graph-template` workflow result kind (item 215): the "Describe a
 * graph" agent's draft.
 *
 * - Contract schema: `graphTemplateJsonSchema()`, a portable tool-input
 *   schema (the template does not fit the structured-output subset; see
 *   `@orkestrator/protocol/graphs/describe`). Its submission tool is
 *   `submit_graph_template` and validation runs through the shared
 *   `validate_workflow_result`.
 * - Structure: the template guard (101) replaces the JSON-schema check, so the
 *   agent gets the guard's precise field paths rather than a schema walk.
 * - Domain: the authoring rules (no acknowledgements, no engine) and the
 *   compiler's errors (107), under the slot's trusted context (enabled
 *   providers and the project ceiling). A rejected draft returns these as
 *   issues, and the agent corrects it within the slot's rejection budget.
 */
import {
  GRAPH_TEMPLATE_RESULT_KIND,
  graphTemplateJsonSchema,
  graphTemplateResultIssues,
  type GraphTemplateResultContext,
} from "@orkestrator/protocol/graphs/describe";
import { validateGraphTemplate } from "@orkestrator/protocol/graphs/template";
import {
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultToolName,
  type WorkflowResultValidationIssue,
} from "@orkestrator/protocol/workflow-results";
import {
  WORKFLOW_RESULT_MAX_ISSUES,
  type WorkflowResultKindDefinition,
  type WorkflowResultSlotView,
} from "./workflow-result-registry.js";

function context(slot: WorkflowResultSlotView): GraphTemplateResultContext | undefined {
  return slot.context?.type === "graph-template" ? slot.context : undefined;
}

function guardIssues(value: unknown): WorkflowResultValidationIssue[] {
  const guard = validateGraphTemplate(value);
  if (guard.ok) return [];
  return graphTemplateResultIssues(value).slice(0, WORKFLOW_RESULT_MAX_ISSUES);
}

export const graphTemplateKindDefinition: WorkflowResultKindDefinition = {
  kind: GRAPH_TEMPLATE_RESULT_KIND,
  schema: () => graphTemplateJsonSchema(),
  toolName: () => workflowResultToolName(GRAPH_TEMPLATE_RESULT_KIND),
  validationToolName: () => WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  label: () => "graph template",
  structural: (value) => guardIssues(value),
  validator: (value, slot) =>
    graphTemplateResultIssues(value, context(slot)).slice(0, WORKFLOW_RESULT_MAX_ISSUES),
};
