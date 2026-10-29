import { useMemo } from "react";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import type { CompiledGraphCapabilities } from "@orkestrator/protocol/graphs/capability-profiles";
import type {
  GraphCapabilityName,
  GraphCapabilitySpec,
} from "@orkestrator/protocol/graphs/template";
import { nativeAgentMcpServer } from "@orkestrator/protocol/native-agent";
import { useConfiguredUserMcpServers, type ConfiguredMcpServerSource } from "./graph-designer-mcp";
import { FormSection } from "./graph-form-controls";

/**
 * The MCP servers section of an agent node's capabilities form (item 404).
 * A graph node gets none of the user's own MCP servers unless granted here:
 * `mcp:<server>` in `allow` grants one, in `deny` removes it. The list is
 * the user's configured servers (Settings, MCP servers); a server the spec
 * names but the user has not configured stays listed so it can be removed.
 */

type McpOverride = "off" | "grant" | "deny";

function mcpOverrideOf(spec: GraphCapabilitySpec, name: string): McpOverride {
  const capability = `mcp:${name}` as GraphCapabilityName;
  if (spec.deny?.includes(capability)) return "deny";
  if (spec.allow?.includes(capability)) return "grant";
  return "off";
}

function withMcpOverride(
  spec: GraphCapabilitySpec,
  name: string,
  value: McpOverride,
): GraphCapabilitySpec {
  const capability = `mcp:${name}` as GraphCapabilityName;
  const allow = (spec.allow ?? []).filter((entry) => entry !== capability);
  const deny = (spec.deny ?? []).filter((entry) => entry !== capability);
  if (value === "grant") allow.push(capability);
  if (value === "deny") deny.push(capability);
  const next: GraphCapabilitySpec = { profile: spec.profile };
  if (allow.length > 0) next.allow = allow;
  if (deny.length > 0) next.deny = deny;
  return next;
}

export function GraphMcpServersEditor({
  spec,
  compiled,
  onChange,
  source,
}: {
  spec: GraphCapabilitySpec;
  compiled: CompiledGraphCapabilities | null;
  onChange: (label: string, spec: GraphCapabilitySpec) => void;
  /** Where configured servers are read; the backend's MCP management by default. */
  source?: ConfiguredMcpServerSource;
}) {
  const configured = useConfiguredUserMcpServers(source);
  const rows = useMemo(() => {
    const providers = new Map(
      configured.state === "ready"
        ? configured.servers.map((server) => [server.name, server.providers])
        : [],
    );
    const named = [...(spec.allow ?? []), ...(spec.deny ?? [])]
      .map((capability) => nativeAgentMcpServer(capability))
      .filter((name): name is string => name !== undefined);
    const names = [...new Set([...providers.keys(), ...named])].sort();
    return names.map((name) => ({ name, providers: providers.get(name) }));
  }, [configured, spec]);
  const granted = new Set(compiled?.mcpServers ?? []);
  const denied = new Set<string>(compiled?.denied ?? []);

  return (
    <FormSection title="MCP servers">
      <p className="text-[11px] text-muted-foreground">
        A graph node gets none of your own MCP servers unless you grant them here. Only servers in
        your own configuration can be granted (Settings, MCP servers); a template names a server but
        never defines one. Orkestrator&apos;s own tools are separate.
      </p>
      {configured.state === "loading" ? (
        <p className="text-[11px] text-muted-foreground">Reading your MCP servers…</p>
      ) : configured.state === "unavailable" ? (
        <p className="text-[11px] text-muted-foreground" role="status">
          Your MCP servers could not be read; servers this node already names are listed.
        </p>
      ) : null}
      {rows.length === 0 ? (
        configured.state === "ready" ? (
          <p className="text-[11px] text-muted-foreground">You have no MCP servers configured.</p>
        ) : null
      ) : (
        <table className="w-full border-collapse text-left text-[11px]" data-graph-mcp-servers="">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-0.5 font-normal">Server</th>
              <th className="py-0.5 font-normal">Override</th>
              <th className="py-0.5 font-normal">Result</th>
              <th className="py-0.5 font-normal">Configured for</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ name, providers }) => (
              <tr key={name} data-graph-mcp-server={name}>
                <td className="py-0.5 pr-2 font-mono">{name}</td>
                <td className="py-0.5 pr-2">
                  <select
                    aria-label={`${name} MCP server`}
                    value={mcpOverrideOf(spec, name)}
                    onChange={(event) =>
                      onChange(
                        `mcp:${name}: ${event.target.value}`,
                        withMcpOverride(spec, name, event.target.value as McpOverride),
                      )
                    }
                    className="h-6 rounded border border-border/70 bg-input-surface px-1 text-[11px]"
                  >
                    <option value="off">Off</option>
                    <option value="grant">Grant</option>
                    <option value="deny">Deny</option>
                  </select>
                </td>
                <td
                  className={
                    granted.has(name) ? "py-0.5 text-emerald-300" : "py-0.5 text-muted-foreground"
                  }
                >
                  {granted.has(name) ? "granted" : denied.has(`mcp:${name}`) ? "denied" : "off"}
                </td>
                <td className="py-0.5 text-muted-foreground">
                  {providers
                    ? providers.map((provider) => AGENT_PLATFORM_LABELS[provider]).join(", ")
                    : "not configured"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </FormSection>
  );
}
