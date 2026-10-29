/**
 * Compiler pass: agent nodes. Capability checks (item 106, including D12's
 * ban on push and GitHub writes), compiled policies over the environment and
 * the project ceiling, enforcement floors (D4: the profile default, unmet
 * floors, lowered floors needing an acknowledgement), and the constraints on
 * continued sessions (report §5.2).
 */
import { AGENT_PLATFORM_LABELS } from "../agent-platforms.js";
import {
  agentPlatformsMeetingFloor,
  agentPolicyEnforcement,
  checkGraphCapabilities,
  compileGraphCapabilities,
  defaultGraphMinEnforcement,
  effectiveGraphMinEnforcement,
  graphMinEnforcementLowered,
} from "./capability-profiles.js";
import type { GraphCompileState } from "./compile-state.js";
import { type GraphAgentNode, isGraphRunInputRef } from "./template-model.js";

function checkCapabilities(state: GraphCompileState, node: GraphAgentNode, path: string): void {
  for (const issue of checkGraphCapabilities(node.capabilities, node.workspaceAccess, {
    providers: state.options.providers,
  })) {
    const field =
      issue.code === "capability-workspace-write-denied" ||
      issue.code === "capability-workspace-read-writable"
        ? "workspaceAccess"
        : "capabilities";
    state.diagnostics.push({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      nodeId: node.id,
      path: `${path}.${field}`,
      ...(issue.capability ? { detail: issue.capability } : {}),
    });
  }
}

function checkEnforcement(state: GraphCompileState, node: GraphAgentNode, path: string): void {
  const compiled = compileGraphCapabilities({
    spec: node.capabilities,
    environment: state.options.environment,
    ceiling: state.options.ceiling,
  });
  state.capabilities.set(node.id, compiled);
  const floor = effectiveGraphMinEnforcement(node.minEnforcement, compiled);
  if (floor !== undefined) state.floors.set(node.id, floor);

  if (graphMinEnforcementLowered(node.minEnforcement, compiled)) {
    state.floorLowered.add(node.id);
    const defaultFloor = defaultGraphMinEnforcement(compiled)!;
    state.requireAcknowledgement(
      "enforcement-floor",
      "enforcement-floor-lowered",
      `${node.id} lowers the ${node.capabilities.profile} profile's enforcement floor from ${defaultFloor} to ${node.minEnforcement}, so providers that only advise the model can run it.`,
      { nodeId: node.id, path: `${path}.minEnforcement` },
      {
        node: node.id,
        profile: node.capabilities.profile,
        minEnforcement: node.minEnforcement,
        defaultFloor,
      },
    );
  }

  if (floor === undefined) return;
  const { providers, host } = state.options;
  if (agentPlatformsMeetingFloor(compiled.policy, floor, host, providers).length > 0) return;
  const tiers = providers
    .map(
      (platform) =>
        `${AGENT_PLATFORM_LABELS[platform]} ${agentPolicyEnforcement(compiled.policy, platform, host).tier}`,
    )
    .join(", ");
  state.diagnostics.add(
    "enforcement-unmet",
    `No enabled provider holds ${node.id}'s ${node.capabilities.profile} profile at ${floor} (${tiers || "no providers enabled"}); enable one that does, narrow the profile, or lower the floor with an acknowledgement`,
    {
      nodeId: node.id,
      path: node.minEnforcement !== undefined ? `${path}.minEnforcement` : `${path}.capabilities`,
      detail: floor,
    },
  );
}

function checkSession(state: GraphCompileState, node: GraphAgentNode, path: string): void {
  if (node.session?.mode !== "continue") return;
  const from = node.session.from;
  const at = { nodeId: node.id, path: `${path}.session.from` };
  const source = state.nodes.get(from)?.node;
  if (!source || source.kind !== "agent" || from === node.id) {
    state.diagnostics.add(
      "session-source-invalid",
      !source
        ? `There is no node ${from} to continue`
        : from === node.id
          ? "A node cannot continue its own session"
          : `${from} is a ${source.kind} node; only agent sessions can be continued`,
      at,
    );
    return;
  }
  const role = state.roles.get(node.role);
  if (source.role !== node.role || role?.multiplicity === "panel") {
    state.diagnostics.add(
      "session-role-mismatch",
      source.role !== node.role
        ? `${node.id} uses role ${node.role} but continues ${from}'s session on role ${source.role}; a continued session keeps its agent and model`
        : `${node.role} is a panel role; a continued session needs one model`,
      at,
    );
  }
  if (state.isReplicated(node.id) || state.isReplicated(from)) {
    state.diagnostics.add(
      "session-replicated",
      "A continued session joins one session to one session; neither node may be replicated",
      at,
    );
  }
  const direct =
    state.edges.some(
      ({ edge }) =>
        edge.to.node === node.id && !isGraphRunInputRef(edge.from) && edge.from.node === from,
    ) ||
    state.carries.some((carry) => carry.carry!.to.node === node.id && carry.sourceNode === from);
  if (!direct) {
    state.diagnostics.add(
      "session-not-predecessor",
      `${from} does not feed ${node.id} directly; a continued session follows an edge from the node it continues`,
      at,
    );
  }
}

/** Every agent-node check. */
export function checkGraphAgents(state: GraphCompileState): void {
  for (const { node, path } of state.nodes.values()) {
    if (node.kind !== "agent") continue;
    checkCapabilities(state, node, path);
    checkEnforcement(state, node, path);
    checkSession(state, node, path);
  }
}
