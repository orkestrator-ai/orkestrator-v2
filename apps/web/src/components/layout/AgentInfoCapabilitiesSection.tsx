import { useMemo, useState } from "react";
import { Copy, FlaskConical, Sparkles } from "lucide-react";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { CapabilitySessionView } from "@orkestrator/protocol/capability-resources-api";
import {
  nativeAgentDeniedCapabilities,
  nativeAgentUserMcpGrant,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";

import { Button } from "@/components/ui/button";
import { capabilitiesApi } from "@/lib/backend/capabilities";
import { requestGlobalSettings } from "@/lib/settings-navigation";

import {
  describeError,
  kindLabel,
  liveSemanticsLabel,
  StatusBadge,
} from "@/components/settings/capabilities/capability-format";
import { useCapabilityResource } from "@/components/settings/capabilities/useCapabilityResource";

const READINESS: Record<CapabilitySessionView["readiness"], { status: string; label: string }> = {
  ready: { status: "ready", label: "Ready" },
  "next-session": { status: "installed-next-session", label: "Next session" },
  "needs-attention": { status: "failed", label: "Needs attention" },
  blocked: { status: "blocked-policy", label: "Blocked" },
  unresolved: { status: "pending", label: "Checking" },
};

/**
 * "Capabilities: My setup + Frontend" for one agent session: which setups it
 * uses, what each component means for this running session, a
 * non-destructive test and copyable diagnostics. Changing the setups never
 * restarts the agent: each component says whether it is available next turn,
 * waits until idle, or needs a new session. The session's own permission
 * policy narrows what is shown; a setup never widens it.
 */
export function AgentInfoCapabilitiesSection({
  nodeId,
  environmentId,
  projectId,
  provider,
  sessionKey,
  running,
  policy,
  readOnly,
}: {
  nodeId: string;
  environmentId: string;
  projectId?: string;
  provider: AgentPlatform;
  sessionKey: string;
  running: boolean;
  policy?: NativeAgentExecutionPolicy;
  readOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const ceiling = useMemo(
    () => ({
      denied: nativeAgentDeniedCapabilities(policy),
      userMcpServers: nativeAgentUserMcpGrant(policy) ?? null,
    }),
    [policy],
  );
  const view = useCapabilityResource(
    () =>
      capabilitiesApi.getCapabilitySessionView({
        sessionKey,
        target: { nodeId, provider, environmentId, ...(projectId ? { projectId } : {}) },
        sessionRunning: running,
        ceiling,
      }),
    [sessionKey, nodeId, provider, environmentId, projectId, running, JSON.stringify(ceiling)],
  );
  const setups = useCapabilityResource(() => capabilitiesApi.listCapabilitySetups(), []);
  const data = view.state.data;
  if (view.state.status === "error" && !data) {
    // A node too old to manage capabilities: say nothing rather than a broken section.
    return null;
  }
  const readiness = READINESS[data?.readiness ?? "unresolved"];
  const toolkits = (setups.state.data?.setups ?? []).filter((setup) => !setup.builtIn);

  return (
    <div
      className="space-y-2 rounded-md border border-zinc-800 p-3 text-xs"
      data-testid="agent-info-capabilities"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">Capabilities:</span>
        <span className="font-medium text-foreground">{data?.label ?? "My setup"}</span>
        <StatusBadge status={readiness.status} label={readiness.label} />
      </div>
      <div className="flex flex-wrap gap-1">
        {!readOnly ? (
          <Button variant="ghost" size="sm" className="h-7" onClick={() => setChanging(!changing)}>
            Change
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" className="h-7" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Hide details" : "See details"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7"
          title="Checks the installed files for this agent; never runs anything"
          onClick={() =>
            void capabilitiesApi
              .verifyAgentCapability(
                { nodeId, provider, environmentId },
                (data?.components ?? []).map((component) => component.componentId),
              )
              .then((result) =>
                setTestResult(
                  result.checks.length === 0
                    ? "Nothing to check."
                    : `${result.checks.filter((check) => check.status !== "drifted" && check.status !== "pending").length} of ${result.checks.length} checks found the files in place.`,
                ),
              )
              .catch((testError: unknown) => setError(describeError(testError)))
          }
        >
          <FlaskConical className="h-3.5 w-3.5" /> Test
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={() => {
            const diagnostics = JSON.stringify(
              {
                sessionKey,
                provider,
                setups: data?.setupIds,
                manifestDigest: data?.effective?.manifestDigest,
                permissionPolicyDigest: data?.effective?.permissionPolicyDigest,
                packages: data?.effective?.resolvedPackages.map((entry) => ({
                  id: entry.id,
                  digest: entry.artifactDigest,
                })),
                components: data?.components.map((entry) => ({
                  id: entry.componentId,
                  status: entry.status,
                  live: entry.liveSemantics,
                })),
                blockers: data?.effective?.launchBlockers,
              },
              null,
              2,
            );
            void navigator.clipboard?.writeText(diagnostics).then(() => setCopied(true));
          }}
        >
          <Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy diagnostics"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={() => requestGlobalSettings("capabilities")}
        >
          Manage
        </Button>
      </div>
      {changing ? (
        <fieldset className="space-y-1 rounded border border-zinc-800 p-2">
          <legend className="px-1 text-muted-foreground">
            Toolkits for this session (in addition to My setup)
          </legend>
          {toolkits.length === 0 ? (
            <p className="text-muted-foreground">
              Create toolkits in Settings → Capabilities → Setups.
            </p>
          ) : null}
          {toolkits.map((setup) => {
            const checked = data?.setupIds.includes(setup.id) ?? false;
            return (
              <label key={setup.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    const current = (data?.setupIds ?? []).filter((id) => id !== "my-setup");
                    const next = event.target.checked
                      ? [...current, setup.id]
                      : current.filter((id) => id !== setup.id);
                    void capabilitiesApi
                      .assignCapabilitySetup("session", sessionKey, next)
                      .then(() => view.reload())
                      .catch((assignError: unknown) => setError(describeError(assignError)));
                  }}
                />
                {setup.name}
              </label>
            );
          })}
          {running ? (
            <p className="text-muted-foreground">
              The agent is working. Nothing restarts: each component below says when it becomes
              available.
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {expanded && data ? (
        <ul className="space-y-1">
          {data.components.length === 0 ? (
            <li className="text-muted-foreground">No capability is assigned to this agent.</li>
          ) : null}
          {data.components.map((component) => (
            <li key={component.componentId} className="flex flex-wrap items-center gap-2">
              <span className="text-foreground">{component.name}</span>
              <span className="text-muted-foreground">{kindLabel(component.kind)}</span>
              <StatusBadge status={component.status} title={component.reason} />
              {liveSemanticsLabel(component.liveSemantics) ? (
                <span className="text-muted-foreground">
                  {liveSemanticsLabel(component.liveSemantics)}
                </span>
              ) : null}
              {component.reason ? (
                <span className="w-full text-muted-foreground">{component.reason}</span>
              ) : null}
            </li>
          ))}
          {data.effective?.launchBlockers.map((blocker) => (
            <li key={blocker.componentId} className="text-rose-300">
              Required and unavailable: {blocker.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {testResult ? <p className="text-muted-foreground">{testResult}</p> : null}
      {error ? (
        <p className="text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
