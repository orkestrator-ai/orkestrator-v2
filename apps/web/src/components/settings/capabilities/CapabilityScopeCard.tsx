import { useState } from "react";
import { Sparkles } from "lucide-react";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

import { capabilitiesApi } from "@/lib/backend/capabilities";
import { requestGlobalSettings } from "@/lib/settings-navigation";

import { SETTINGS_CARD_CLASS } from "../SettingsPageLayout";
import { describeError, providerLabel, StatusBadge } from "./capability-format";
import { useCapabilityResource } from "./useCapabilityResource";

/**
 * The toolkits a project or an environment adds to every agent session in
 * it, and what that resolves to for one agent. The same resolver as the
 * Capabilities page and the session chip, not a separate manager.
 */
export function CapabilityScopeCard({
  scope,
  scopeId,
  projectId,
  environmentId,
  provider = "claude",
}: {
  scope: "project" | "environment";
  scopeId: string;
  projectId?: string;
  environmentId?: string;
  provider?: AgentPlatform;
}) {
  const [error, setError] = useState<string | null>(null);
  const setups = useCapabilityResource(() => capabilitiesApi.listCapabilitySetups(), []);
  const effective = useCapabilityResource(
    () =>
      capabilitiesApi.getEffectiveAgentResources({
        target: {
          provider,
          ...(projectId ? { projectId } : {}),
          ...(environmentId ? { environmentId } : {}),
        },
      }),
    [provider, projectId, environmentId],
  );
  if (setups.state.status === "error" && !setups.state.data) return null;
  const toolkits = (setups.state.data?.setups ?? []).filter((setup) => !setup.builtIn);
  const active = new Set(effective.state.data?.setupRevisions.map((entry) => entry.id) ?? []);
  return (
    <section
      className={`${SETTINGS_CARD_CLASS} space-y-2 p-4 text-xs`}
      aria-label="Capabilities"
      data-testid="capability-scope-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Capabilities</span>
        <button
          type="button"
          className="ml-auto text-sky-300"
          onClick={() => requestGlobalSettings("capabilities")}
        >
          Manage
        </button>
      </div>
      <p className="text-muted-foreground">
        Toolkits every agent session in this {scope} gets, on top of My setup. To share them through
        Git, export the setup from Capabilities → Setups into the project.
      </p>
      {toolkits.map((setup) => (
        <label key={setup.id} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={active.has(setup.id)}
            onChange={(event) => {
              const current = [...active].filter((id) =>
                toolkits.some((toolkit) => toolkit.id === id),
              );
              const next = event.target.checked
                ? [...current, setup.id]
                : current.filter((id) => id !== setup.id);
              void capabilitiesApi
                .assignCapabilitySetup(scope, scopeId, next)
                .then(() => effective.reload())
                .catch((assignError: unknown) => setError(describeError(assignError)));
            }}
          />
          {setup.name}
        </label>
      ))}
      {effective.state.data ? (
        <p className="text-muted-foreground">
          {providerLabel(provider)} gets {effective.state.data.resolvedPackages.length} package(s)
          {effective.state.data.unsupported.length > 0
            ? `; ${effective.state.data.unsupported.length} component(s) unsupported`
            : ""}
          {effective.state.data.blocked.length > 0
            ? `; ${effective.state.data.blocked.length} blocked by policy`
            : ""}
          .
        </p>
      ) : null}
      {effective.state.data?.launchBlockers.map((blocker) => (
        <p key={blocker.componentId} className="flex items-center gap-2">
          <StatusBadge status="blocked-policy" /> {blocker.reason}
        </p>
      ))}
      {error ? (
        <p className="text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
