import { useMemo } from "react";
import {
  GRAPH_CAPABILITY_PROFILE_DEFINITIONS,
  GRAPH_REMOTE_WRITE_CAPABILITIES,
  defaultGraphMinEnforcement,
  graphMinEnforcementLowered,
} from "@orkestrator/protocol/graphs/capability-profiles";
import {
  GRAPH_CAPABILITIES,
  GRAPH_CAPABILITY_PROFILES,
  GRAPH_ENFORCEMENT_TIERS,
  GRAPH_ORKESTRATOR_CAPABILITY_GROUPS,
  GRAPH_WORKSPACE_ACCESS,
  type GraphAgentNode,
  type GraphCapabilityName,
  type GraphCapabilityProfileId,
  type GraphCapabilitySpec,
  type GraphEnforcementTier,
  type GraphWorkspaceAccess,
} from "@orkestrator/protocol/graphs/template";
import { Button } from "@/components/ui/button";
import { GraphEnforcementMatrix, useGraphNodeCapabilities } from "./GraphEnforcementMatrix";
import { GRAPH_ENFORCEMENT_LABELS } from "./graph-designer-model";
import { useGraphEditor, useGraphNodeEdit } from "./graph-editor-context";
import { FormSection, JsonField, SelectField } from "./graph-form-controls";

/**
 * The capabilities form of an agent node (report §6.2–§6.4, item 106):
 * profile, workspace access, per-capability allow and deny overrides (which
 * only narrow), the minimum enforcement tier with D4's lowered-floor
 * acknowledgement, and the per-provider enforcement matrix of the result.
 * Push and GitHub writes are never an agent's (D12).
 */

const ACCESS_LABELS: Readonly<Record<GraphWorkspaceAccess, string>> = {
  none: "None",
  read: "Read",
  write: "Write",
};

type Override = "profile" | "allow" | "deny";

function overrideOf(spec: GraphCapabilitySpec, name: GraphCapabilityName): Override {
  if (spec.deny?.includes(name)) return "deny";
  if (spec.allow?.includes(name)) return "allow";
  return "profile";
}

function withOverride(
  spec: GraphCapabilitySpec,
  name: GraphCapabilityName,
  value: Override,
): GraphCapabilitySpec {
  const allow = (spec.allow ?? []).filter((entry) => entry !== name);
  const deny = (spec.deny ?? []).filter((entry) => entry !== name);
  if (value === "allow") allow.push(name);
  if (value === "deny") deny.push(name);
  const next: GraphCapabilitySpec = { profile: spec.profile };
  if (allow.length > 0) next.allow = allow;
  if (deny.length > 0) next.deny = deny;
  return next;
}

function isCapabilitySpec(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Expected an object";
  const spec = value as Record<string, unknown>;
  if (!GRAPH_CAPABILITY_PROFILES.includes(spec.profile as GraphCapabilityProfileId)) {
    return `profile must be one of ${GRAPH_CAPABILITY_PROFILES.join(", ")}`;
  }
  for (const key of ["allow", "deny"]) {
    const list = spec[key];
    if (
      list !== undefined &&
      (!Array.isArray(list) || list.some((entry) => typeof entry !== "string"))
    ) {
      return `${key} must be a list of capability names`;
    }
  }
  const extra = Object.keys(spec).filter((key) => !["profile", "allow", "deny"].includes(key));
  return extra.length > 0 ? `Unknown field ${extra[0]}` : null;
}

export function GraphCapabilitiesEditor({ node }: { node: GraphAgentNode }) {
  const { plan, compile, ceiling, providers, acknowledge } = useGraphEditor();
  const editNode = useGraphNodeEdit(node.id);
  const planNode = plan?.nodes.find((candidate) => candidate.id === node.id);
  const compiled = useGraphNodeCapabilities(node, planNode, ceiling);
  const profile = GRAPH_CAPABILITY_PROFILE_DEFINITIONS[node.capabilities.profile];
  const denied = useMemo(() => new Set<string>(compiled?.denied ?? []), [compiled]);
  const defaultFloor = compiled ? defaultGraphMinEnforcement(compiled) : undefined;
  const lowered = compiled ? graphMinEnforcementLowered(node.minEnforcement, compiled) : false;
  const floorAck = compile?.diagnostics.find(
    (diagnostic) =>
      diagnostic.nodeId === node.id && diagnostic.acknowledgement?.kind === "enforcement-floor",
  );
  const pendingFloor = compile?.pendingAcknowledgements.find(
    (ref) => ref.nodeId === node.id && ref.kind === "enforcement-floor",
  );
  const setSpec = (label: string, spec: GraphCapabilitySpec) =>
    editNode<GraphAgentNode>(label, (current) => ({ ...current, capabilities: spec }));

  const plain = GRAPH_CAPABILITIES.filter(
    (name) => !(GRAPH_REMOTE_WRITE_CAPABILITIES as readonly string[]).includes(name),
  );
  return (
    <div className="flex flex-col gap-3" data-graph-capabilities-editor="">
      <FormSection title="Profile">
        <SelectField
          label="Capability profile"
          value={node.capabilities.profile}
          hint={`${profile.description} Today: ${profile.equivalent}.`}
          options={GRAPH_CAPABILITY_PROFILES.map((id) => ({
            value: id,
            label: GRAPH_CAPABILITY_PROFILE_DEFINITIONS[id].label,
          }))}
          onChange={(value) =>
            setSpec(`Profile ${value}`, {
              ...node.capabilities,
              profile: value as GraphCapabilityProfileId,
            })
          }
        />
        <SelectField
          label="Workspace access"
          value={node.workspaceAccess}
          hint="At most one writer runs on the workspace at a time; replicated nodes must not write (D3)."
          options={GRAPH_WORKSPACE_ACCESS.map((access) => ({
            value: access,
            label: ACCESS_LABELS[access],
          }))}
          onChange={(value) =>
            editNode<GraphAgentNode>(`Workspace access ${value}`, (current) => ({
              ...current,
              workspaceAccess: value as GraphWorkspaceAccess,
            }))
          }
        />
      </FormSection>

      <FormSection title="Overrides">
        <p className="text-[11px] text-muted-foreground">
          Overrides only narrow: <em>allow</em> carves an exception out of the profile's denials
          (such as web search under a network denial), <em>deny</em> removes a capability.
        </p>
        <table
          className="w-full border-collapse text-left text-[11px]"
          data-graph-capability-table=""
        >
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-0.5 font-normal">Capability</th>
              <th className="py-0.5 font-normal">Override</th>
              <th className="py-0.5 font-normal">Result</th>
            </tr>
          </thead>
          <tbody>
            {plain.map((name) => (
              <tr key={name} data-graph-capability={name}>
                <td className="py-0.5 pr-2 font-mono">{name}</td>
                <td className="py-0.5 pr-2">
                  <select
                    aria-label={`${name} override`}
                    value={overrideOf(node.capabilities, name)}
                    onChange={(event) =>
                      setSpec(
                        `${name}: ${event.target.value}`,
                        withOverride(node.capabilities, name, event.target.value as Override),
                      )
                    }
                    className="h-6 rounded border border-border/70 bg-input-surface px-1 text-[11px]"
                  >
                    <option value="profile">Profile</option>
                    <option value="allow">Allow</option>
                    <option value="deny">Deny</option>
                  </select>
                </td>
                <td
                  className={
                    denied.has(name) ? "py-0.5 text-muted-foreground" : "py-0.5 text-emerald-300"
                  }
                >
                  {name === "web.search"
                    ? compiled?.webSearch
                      ? "allowed"
                      : "denied"
                    : denied.has(name)
                      ? "denied"
                      : "allowed"}
                </td>
              </tr>
            ))}
            {GRAPH_REMOTE_WRITE_CAPABILITIES.map((name) => (
              <tr key={name} className="text-muted-foreground">
                <td className="py-0.5 pr-2 font-mono">{name}</td>
                <td className="py-0.5 pr-2" colSpan={2}>
                  never: a system node pushes (D12)
                </td>
              </tr>
            ))}
            {GRAPH_ORKESTRATOR_CAPABILITY_GROUPS.map((group) => {
              const name = `orkestrator:${group}` as GraphCapabilityName;
              const on = node.capabilities.allow?.includes(name) ?? false;
              return (
                <tr key={name} data-graph-capability={name}>
                  <td className="py-0.5 pr-2 font-mono">{name}</td>
                  <td className="py-0.5 pr-2">
                    <select
                      aria-label={`${name} override`}
                      value={on ? "allow" : "profile"}
                      onChange={(event) =>
                        setSpec(
                          `${name}: ${event.target.value}`,
                          withOverride(node.capabilities, name, event.target.value as Override),
                        )
                      }
                      className="h-6 rounded border border-border/70 bg-input-surface px-1 text-[11px]"
                    >
                      <option value="profile">Off</option>
                      <option value="allow">Opt in</option>
                    </select>
                  </td>
                  <td className="py-0.5 text-muted-foreground">
                    {compiled?.orkestratorGroups.includes(group) ? "granted" : "off"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {compiled && compiled.removedByCeiling.length > 0 ? (
          <p className="text-[11px] text-muted-foreground">
            The project's ceiling removes {compiled.removedByCeiling.join(", ")}.
          </p>
        ) : null}
        <JsonField
          label="Capabilities as JSON"
          value={node.capabilities}
          rows={4}
          validate={isCapabilitySpec}
          onCommit={(value) => setSpec("Edit capabilities JSON", value as GraphCapabilitySpec)}
        />
      </FormSection>

      <FormSection title="Minimum enforcement">
        <SelectField
          label="Providers must hold this node at least at"
          value={node.minEnforcement ?? ""}
          hint="Model pickers hide providers below the floor."
          options={[
            {
              value: "",
              label: defaultFloor
                ? `Profile default (${GRAPH_ENFORCEMENT_LABELS[defaultFloor]})`
                : "No floor (the profile may write)",
            },
            ...GRAPH_ENFORCEMENT_TIERS.map((tier) => ({
              value: tier,
              label: GRAPH_ENFORCEMENT_LABELS[tier],
            })),
          ]}
          onChange={(value) =>
            editNode<GraphAgentNode>(`Minimum enforcement ${value || "default"}`, (current) => {
              const next = { ...current };
              if (value) next.minEnforcement = value as GraphEnforcementTier;
              else delete next.minEnforcement;
              return next;
            })
          }
        />
        {lowered ? (
          <div
            role="note"
            data-graph-floor-lowered={pendingFloor ? "pending" : "acknowledged"}
            className="flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200"
          >
            <p>
              This lowers the {profile.label.toLowerCase()} profile's floor from{" "}
              {defaultFloor ? GRAPH_ENFORCEMENT_LABELS[defaultFloor] : "its default"}: providers
              that only advise the model may run this read-only node (D4). The template records your
              acknowledgement.
            </p>
            {pendingFloor ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6 self-start text-[11px]"
                onClick={() => acknowledge(pendingFloor)}
              >
                Acknowledge the lowered floor
              </Button>
            ) : floorAck?.acknowledgement?.accepted ? (
              <p className="text-muted-foreground">Acknowledged.</p>
            ) : (
              <p className="text-muted-foreground">Compile the template to acknowledge it.</p>
            )}
          </div>
        ) : null}
      </FormSection>

      {compiled ? (
        <FormSection title="Enforcement by provider">
          <GraphEnforcementMatrix compiled={compiled} providers={providers} />
        </FormSection>
      ) : (
        <p className="text-[11px] text-failure">
          The capability spec is not valid; see diagnostics.
        </p>
      )}
    </div>
  );
}
