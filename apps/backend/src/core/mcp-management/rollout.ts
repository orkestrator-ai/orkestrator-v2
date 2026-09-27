/**
 * Rollout gate and kill switch for MCP configuration management (plan step 14).
 *
 * The settings live in the backend's global config (`global.mcpManagement`),
 * never in the renderer. The gate only ever *narrows* what the service does:
 *
 * - it refuses new mutations and applies with `management-disabled`;
 * - it overlays the reason onto target capabilities so the UI shows disabled
 *   controls with an explanation instead of failing on submit;
 * - it pauses the apply scheduler and retires queued runtime work as
 *   `cancelled` with an explicit reason.
 *
 * It never touches a saved native file: configuration already saved remains
 * what providers load, whichever way the switch is set.
 */

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  DEFAULT_MCP_MANAGEMENT_ROLLOUT,
  mcpFailure,
  normalizeMcpManagementRolloutSettings,
  type McpCapabilityFlag,
  type McpManagementRolloutSettings,
  type McpTargetCapabilities,
} from "@orkestrator/protocol/mcp-management";

import { providerLabel } from "./providers.js";

export const MANAGEMENT_DISABLED_REASON =
  "MCP configuration management is turned off on this backend. Saved configuration is unchanged and providers keep using it.";

const denied = (reason: string): McpCapabilityFlag => ({ supported: false, reason });

export class McpRolloutGate {
  private settings: McpManagementRolloutSettings = normalizeMcpManagementRolloutSettings(
    DEFAULT_MCP_MANAGEMENT_ROLLOUT,
  );

  constructor(private readonly load?: () => Promise<unknown>) {}

  /** Re-read the stored settings. A failed read keeps the last known settings. */
  async refresh(): Promise<McpManagementRolloutSettings> {
    if (!this.load) return this.settings;
    try {
      this.settings = normalizeMcpManagementRolloutSettings(await this.load());
    } catch {
      // Keep the previous settings; a transient config read must not widen or
      // narrow the gate by accident.
    }
    return this.settings;
  }

  current(): McpManagementRolloutSettings {
    return this.settings;
  }

  /** Why saving `provider` configuration is refused, if it is. */
  writeBlock(provider: AgentPlatform): string | undefined {
    if (!this.settings.enabled) return MANAGEMENT_DISABLED_REASON;
    if (!this.settings.writeProviders.includes(provider))
      return `Changing ${providerLabel(provider)} MCP configuration is not enabled on this backend.`;
    return undefined;
  }

  /** Why applying saved `provider` configuration is refused, if it is. */
  applyBlock(provider: AgentPlatform): string | undefined {
    if (!this.settings.enabled) return MANAGEMENT_DISABLED_REASON;
    if (!this.settings.applyProviders.includes(provider))
      return `Applying ${providerLabel(provider)} MCP changes to running sessions is not enabled on this backend; sessions read saved configuration when they next load it.`;
    return undefined;
  }

  assertWritable(provider: AgentPlatform): void {
    const reason = this.writeBlock(provider);
    if (reason) throw mcpFailure("management-disabled", { message: reason });
  }

  assertApplicable(provider: AgentPlatform): void {
    const reason = this.applyBlock(provider);
    if (reason) throw mcpFailure("management-disabled", { message: reason });
  }

  /** Capabilities as the gate allows them. Never widens what the provider reports. */
  overlay(provider: AgentPlatform, capabilities: McpTargetCapabilities): McpTargetCapabilities {
    const write = this.writeBlock(provider);
    const apply = this.applyBlock(provider);
    const next: McpTargetCapabilities = {
      ...capabilities,
      rollout: {
        write: write ? denied(write) : { supported: true },
        apply: apply ? denied(apply) : { supported: true },
      },
    };
    if (!this.settings.enabled) next.management = denied(MANAGEMENT_DISABLED_REASON);
    if (write) {
      const block = (flag: McpCapabilityFlag) => (flag.supported ? denied(write) : flag);
      next.operations = {
        add: block(capabilities.operations.add),
        update: block(capabilities.operations.update),
        rename: block(capabilities.operations.rename),
        remove: block(capabilities.operations.remove),
        setEnabled: block(capabilities.operations.setEnabled),
      };
    }
    return next;
  }
}
