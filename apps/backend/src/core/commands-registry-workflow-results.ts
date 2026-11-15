import { normalizeWorkflowResultToolsSettings } from "@orkestrator/protocol/workflow-results";
import type { CommandRegistrar } from "./commands-registry-types.js";
import {
  getWorkflowResultMetricsCommand,
  getWorkflowResultToolsRolloutCommand,
} from "@orkestrator/protocol/contract/domains/pipelines";

/**
 * Operational surface for the workflow result transport.
 *
 * Metrics are bounded and content-free: no payloads, prompts, diagnostics,
 * digests, receipt ids, or result keys are recorded or returned. The rollout
 * setting (`global.workflowResultTools` in `config.json`) is deliberately
 * backend-owned rather than a user-facing transport choice; this surface only
 * reads it. A change applies to attempts admitted after it
 * (`WorkflowResultRollout` re-reads it before admission). In-flight tool-mode
 * slots keep their tools and receipts, which is what makes disabling a
 * combination a safe rollback.
 */
export function registerWorkflowResultCommands(register: CommandRegistrar): void {
  register(
    getWorkflowResultMetricsCommand,
    async (_args, { workflowResults, workflowResultRollout }) => {
      if (!workflowResults) throw new Error("Workflow result service is unavailable");
      return {
        metrics: workflowResults.metrics.snapshot(),
        rollout: workflowResultRollout?.snapshot() ?? null,
      };
    },
  );

  register(getWorkflowResultToolsRolloutCommand, async (_args, { storage }) => {
    return normalizeWorkflowResultToolsSettings(
      (await storage.loadConfig()).global.workflowResultTools,
    );
  });
}
