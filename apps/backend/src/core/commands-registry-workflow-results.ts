import {
  normalizeWorkflowResultToolsSettings,
  STRUCTURED_OUTPUT_PROVIDER_VALUES,
  WORKFLOW_RESULT_KINDS,
  type WorkflowResultToolsSettings,
} from "@orkestrator/protocol/workflow-results";
import type { CommandRegistrar } from "./commands-registry-types.js";

/**
 * Operational surface for the workflow result transport.
 *
 * Metrics are bounded and content-free: no payloads, prompts, diagnostics,
 * digests, receipt ids, or result keys are recorded or returned. The rollout
 * setting is deliberately backend-owned rather than a user-facing transport
 * choice, and a change applies to attempts admitted after it. In-flight
 * tool-mode slots keep their tools and receipts, which is what makes disabling
 * a combination a safe rollback.
 */
export function registerWorkflowResultCommands(register: CommandRegistrar): void {
  register(
    "get_workflow_result_metrics",
    async (_args, { workflowResults, workflowResultRollout }) => {
      if (!workflowResults) throw new Error("Workflow result service is unavailable");
      return {
        metrics: workflowResults.metrics.snapshot(),
        rollout: workflowResultRollout?.snapshot() ?? null,
      };
    },
  );

  register("get_workflow_result_tools_rollout", async (_args, { storage }) => {
    return normalizeWorkflowResultToolsSettings(
      (await storage.loadConfig()).global.workflowResultTools,
    );
  });

  register(
    "set_workflow_result_tools_rollout",
    async ({ enabled, providers, kinds }, { storage, workflowResultRollout }) => {
      if (enabled !== undefined && typeof enabled !== "boolean") {
        throw new Error("enabled must be a boolean");
      }
      if (providers !== undefined && !Array.isArray(providers)) {
        throw new Error("providers must be an array");
      }
      if (Array.isArray(providers)) {
        const unknown = providers.filter(
          (provider) =>
            !(STRUCTURED_OUTPUT_PROVIDER_VALUES as readonly unknown[]).includes(provider),
        );
        if (unknown.length > 0)
          throw new Error("providers contains an unknown structured output provider");
      }
      if (kinds !== undefined && !Array.isArray(kinds)) {
        throw new Error("kinds must be an array");
      }
      if (Array.isArray(kinds)) {
        const unknown = kinds.filter(
          (kind) => !(WORKFLOW_RESULT_KINDS as readonly unknown[]).includes(kind),
        );
        if (unknown.length > 0) throw new Error("kinds contains an unknown workflow result kind");
      }
      const current = await storage.loadConfig();
      const existing = normalizeWorkflowResultToolsSettings(current.global.workflowResultTools);
      const next: WorkflowResultToolsSettings = normalizeWorkflowResultToolsSettings({
        enabled: enabled ?? existing.enabled,
        providers: providers ?? existing.providers,
        kinds: kinds ?? existing.kinds,
      });
      await storage.updateGlobalConfig({ ...current.global, workflowResultTools: next });
      await workflowResultRollout?.refresh();
      return next;
    },
  );
}
