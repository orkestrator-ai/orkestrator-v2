/**
 * Compiler pass: taint (report §5.13).
 *
 * Sources are nodes that read untrusted content by design: an agent node
 * whose profile or own overrides grant web access (`researcher`, or `allow:
 * ["web.search"]` / `["network"]`) and that keeps it after the ceiling and
 * environment, and `wait-for-checks`, which reads CI output. A builder's
 * environment-level network (package installs) is not counted as a source:
 * otherwise every graph with two builders would warn, and the warning would
 * stop meaning anything (decision recorded in item 107's Notes).
 *
 * Taint follows edges and carries. Side-effecting nodes are agent nodes that
 * keep both a shell and the network (or a remote write), and the system
 * actions that push, open pull requests or run validation commands. Each
 * tainted side-effecting node gets one warning, which the user acknowledges
 * by its digest.
 */
import { GRAPH_CAPABILITY_PROFILE_DEFINITIONS } from "./capability-profiles.js";
import type { GraphCompileState } from "./compile-state.js";
import {
  compareStrings,
  type GraphPlanTaint,
  type GraphSideEffectReason,
  type GraphTaintSourceReason,
} from "./plan.js";
import { type GraphNodeSpec, isGraphRunInputRef } from "./template-model.js";

function sourceReason(
  state: GraphCompileState,
  node: GraphNodeSpec,
): GraphTaintSourceReason | undefined {
  if (node.kind === "system")
    return node.action === "wait-for-checks" ? "external-checks" : undefined;
  if (node.kind !== "agent") return undefined;
  const compiled = state.capabilities.get(node.id);
  if (!compiled) return undefined;
  const allow = node.capabilities.allow ?? [];
  const profileSearch =
    GRAPH_CAPABILITY_PROFILE_DEFINITIONS[node.capabilities.profile].allow.includes("web.search");
  const networkOpen = !compiled.denied.includes("network");
  if (allow.includes("network") && networkOpen) return "network";
  if ((profileSearch || allow.includes("web.search")) && compiled.webSearch) return "web-search";
  return undefined;
}

function sideEffect(
  state: GraphCompileState,
  node: GraphNodeSpec,
): GraphSideEffectReason | undefined {
  switch (node.kind) {
    case "agent": {
      const compiled = state.capabilities.get(node.id);
      if (!compiled) return undefined;
      const denied = new Set<string>(compiled.denied);
      if (!denied.has("git.push") || !denied.has("github.write")) return "remote-write";
      return !denied.has("shell") && !denied.has("network") ? "shell-and-network" : undefined;
    }
    case "system":
      switch (node.action) {
        case "push-branch":
          return "push";
        case "open-pull-request":
          return "pull-request";
        case "run-validation":
        case "run-validation-and-seal":
          return "validation-commands";
        default:
          return undefined;
      }
    case "subgraph":
      return "subgraph";
    default:
      return undefined;
  }
}

const EFFECT_TEXT: Readonly<Record<GraphSideEffectReason, string>> = {
  "shell-and-network": "runs shell commands with network access",
  "remote-write": "can push or write to GitHub",
  push: "pushes the branch",
  "pull-request": "opens or updates a pull request",
  "validation-commands": "runs validation commands",
  subgraph: "runs a sub-graph that may have side effects",
};

const SOURCE_TEXT: Readonly<Record<GraphTaintSourceReason, string>> = {
  "web-search": "searches the web",
  network: "has network access",
  "external-checks": "reads CI check output",
};

/** Taint per node; warns where it reaches a side effect. */
export function computeGraphTaint(state: GraphCompileState): Map<string, GraphPlanTaint> {
  const reasons = new Map<string, GraphTaintSourceReason>();
  const reached = new Map<string, Set<string>>();
  for (const { node } of state.nodes.values()) {
    const reason = sourceReason(state, node);
    reached.set(node.id, new Set(reason ? [node.id] : []));
    if (reason) reasons.set(node.id, reason);
  }
  const flows = [
    ...state.edges.map(({ edge }) =>
      isGraphRunInputRef(edge.from) ? undefined : { from: edge.from.node, to: edge.to.node },
    ),
    ...state.carries.map((carry) => ({ from: carry.sourceNode!, to: carry.carry!.to.node })),
  ].filter((flow): flow is { from: string; to: string } => flow !== undefined);
  for (let changed = true, rounds = 0; changed && rounds <= state.nodes.size + 1; rounds++) {
    changed = false;
    for (const { from, to } of flows) {
      const target = reached.get(to)!;
      for (const source of reached.get(from)!) {
        if (!target.has(source)) {
          target.add(source);
          changed = true;
        }
      }
    }
  }

  const taint = new Map<string, GraphPlanTaint>();
  for (const { node, path } of state.nodes.values()) {
    const sources = [...reached.get(node.id)!].sort(compareStrings);
    const effect = sideEffect(state, node);
    const source = reasons.get(node.id);
    taint.set(node.id, {
      tainted: sources.length > 0,
      ...(source ? { source } : {}),
      ...(effect ? { sideEffect: effect } : {}),
      sources,
    });
    if (!effect || sources.length === 0) continue;
    const humans = [...state.nodes.values()]
      .filter(
        ({ node: other }) =>
          other.kind === "human" &&
          state.reaches(other.id, node.id) &&
          sources.some((origin) => reached.get(other.id)!.has(origin)),
      )
      .map(({ node: other }) => other.id);
    const origins = sources
      .filter((origin) => origin !== node.id)
      .map((origin) => `${origin} (${SOURCE_TEXT[reasons.get(origin)!]})`)
      .join(", ");
    const self = source ? `${node.id} ${SOURCE_TEXT[source]} and ${EFFECT_TEXT[effect]}` : "";
    const reach = origins
      ? `content from ${origins} can reach ${node.id}, which ${EFFECT_TEXT[effect]}`
      : "";
    const summary = [self, reach].filter(Boolean).join("; ");
    state.requireAcknowledgement(
      "taint",
      "taint-reaches-side-effect",
      `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.${humans.length > 0 ? ` ${humans.join(", ")} let${humans.length > 1 ? "" : "s"} a person check it on the way.` : ""}`,
      { nodeId: node.id, path },
      {
        node: node.id,
        effect,
        sources: sources.map((origin) => ({ node: origin, reason: reasons.get(origin)! })),
      },
    );
  }
  return taint;
}
