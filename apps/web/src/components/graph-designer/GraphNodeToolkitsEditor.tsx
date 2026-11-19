import { useState } from "react";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  nativeAgentUserMcpGrant,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";

import { capabilitiesApi } from "@/lib/backend/capabilities";
import { requestGlobalSettings } from "@/lib/settings-navigation";

import {
  describeError,
  providerLabel,
  StatusBadge,
} from "@/components/settings/capabilities/capability-format";
import { useCapabilityResource } from "@/components/settings/capabilities/useCapabilityResource";

/**
 * The toolkits an agent node uses (Agent Capabilities), beside, and distinct
 * from, the permission form above it. A toolkit asks for resources; the node's
 * compiled policy is the ceiling, so a component the policy denies (an MCP
 * server without its grant, network for a networked server) is shown as a
 * conflict and never widens the grant.
 */
export function GraphNodeToolkitsEditor({
  templateId,
  nodeId,
  denied,
  policy,
  providers,
}: {
  templateId: string;
  nodeId: string;
  denied: readonly string[];
  policy: NativeAgentExecutionPolicy | undefined;
  providers: readonly AgentPlatform[];
}) {
  const scopeId = `${templateId}/${nodeId}`;
  const [error, setError] = useState<string | null>(null);
  const provider = providers[0] ?? "claude";
  const setups = useCapabilityResource(() => capabilitiesApi.listCapabilitySetups(), []);
  const effective = useCapabilityResource(
    () =>
      capabilitiesApi.getEffectiveAgentResources({
        target: { provider },
        graphNode: scopeId,
        ceiling: { denied: [...denied], userMcpServers: nativeAgentUserMcpGrant(policy) ?? null },
      }),
    [scopeId, provider, denied.join(","), JSON.stringify(nativeAgentUserMcpGrant(policy) ?? null)],
  );
  const toolkits = (setups.state.data?.setups ?? []).filter((setup) => !setup.builtIn);
  const selected = new Set(
    toolkits
      .filter((setup) => setup.targetSelectors?.includes(`graph-node:${scopeId}`))
      .map((setup) => setup.id),
  );
  const assigned = effective.state.data?.setupRevisions.map((entry) => entry.id) ?? [];
  if (setups.state.status === "error" && !setups.state.data) return null;
  return (
    <div className="flex flex-col gap-2 text-xs" data-graph-toolkits-editor="">
      <p className="text-muted-foreground">
        Toolkits add skills, commands and MCP servers to this node's agent. The permissions above
        stay the ceiling.
      </p>
      {toolkits.length === 0 ? (
        <button
          type="button"
          className="self-start text-sky-300"
          onClick={() => requestGlobalSettings("capabilities")}
        >
          Create a toolkit in Settings → Capabilities
        </button>
      ) : null}
      {toolkits.map((setup) => (
        <label key={setup.id} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={selected.has(setup.id) || assigned.includes(setup.id)}
            onChange={(event) => {
              const current = assigned.filter(
                (id) => id !== "my-setup" && toolkits.some((toolkit) => toolkit.id === id),
              );
              const next = event.target.checked
                ? [...new Set([...current, setup.id])]
                : current.filter((id) => id !== setup.id);
              void capabilitiesApi
                .assignCapabilitySetup("graph-node", scopeId, next)
                .then(() => effective.reload())
                .catch((assignError: unknown) => setError(describeError(assignError)));
            }}
          />
          {setup.name}
        </label>
      ))}
      {effective.state.data ? (
        <ul className="flex flex-col gap-1">
          {effective.state.data.blocked.map((entry) => (
            <li key={entry.componentId} className="flex flex-wrap items-center gap-2">
              <StatusBadge status="blocked-policy" />
              <span>{entry.componentId.split("#").pop()}</span>
              <span className="text-muted-foreground">
                {entry.reason} The toolkit cannot widen the node's grant.
              </span>
            </li>
          ))}
          {effective.state.data.unsupported.map((entry) => (
            <li key={entry.componentId} className="flex flex-wrap items-center gap-2">
              <StatusBadge status="unsupported" />
              <span>{entry.componentId.split("#").pop()}</span>
              <span className="text-muted-foreground">
                {providerLabel(provider)}: {entry.reason}
              </span>
            </li>
          ))}
          <li className="text-muted-foreground">
            {effective.state.data.resolvedPackages.length} package(s) for {providerLabel(provider)}{" "}
            · manifest {effective.state.data.manifestDigest.replace("sha256:", "").slice(0, 10)}
          </li>
        </ul>
      ) : null}
      {error ? <p className="text-failure">{error}</p> : null}
    </div>
  );
}
