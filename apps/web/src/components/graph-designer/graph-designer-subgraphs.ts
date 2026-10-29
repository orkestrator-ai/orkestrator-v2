import { graphTemplateDigest } from "@orkestrator/protocol/graphs/compile";
import type {
  GraphTemplateRef as GraphLibraryRef,
  GraphTemplateSummary,
} from "@orkestrator/protocol/graphs/library";
import {
  graphBuiltinTemplateResolver,
  graphSubgraphPorts,
  graphSubgraphRefKey,
  type GraphTemplateResolution,
  type GraphTemplateResolver,
} from "@orkestrator/protocol/graphs/subgraphs";
import type {
  GraphParameter,
  GraphParameterBinding,
  GraphRole,
  GraphSubgraphNode,
  GraphTemplateRef,
  GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";

/**
 * Sub-graphs in the designer (item 402): which saved templates the palette
 * offers, the reference a picked one gets (pinned to its digest and
 * revision), the node it becomes, and the resolver a browser compile uses.
 *
 * Built-ins resolve from code. User and project children are fetched from
 * the backend once and kept per project (`GraphDesignerSubgraphEntry`); a
 * project child that is not trusted at its current digest resolves as
 * `untrusted`, exactly as the backend compile does.
 */

/** A fetched child: its resolution for the compiler, and what the inspector shows. */
export type GraphDesignerSubgraphEntry =
  | { status: "loading" }
  | {
      status: "ready";
      resolution: GraphTemplateResolution;
      /** The child as read, even when it may not be inlined (untrusted). */
      template?: GraphTemplateV1;
      summary?: GraphTemplateSummary;
    };

/** The cache key of a child reference, per project (project templates are). */
export function graphDesignerSubgraphKey(projectId: string | null, ref: GraphTemplateRef): string {
  return `${projectId ?? ""}|${graphSubgraphRefKey(ref)}`;
}

/** The template-model reference for a library template, pinned to its digest and revision. */
export function graphSubgraphRefFor(summary: GraphTemplateSummary): GraphTemplateRef {
  return {
    scope: summary.scope,
    id: summary.id,
    revision: summary.revision,
    digest: summary.digest,
    ...(summary.ref.scope === "project" ? { path: summary.ref.path } : {}),
  };
}

/** The reference pinned to what `child` is now (built-ins have no summary). */
export function graphSubgraphPinnedRef(
  ref: GraphTemplateRef,
  child: GraphTemplateV1,
  summary?: GraphTemplateSummary,
): GraphTemplateRef {
  return {
    ...ref,
    revision: summary?.revision ?? child.revision,
    digest: summary?.digest ?? graphTemplateDigest(child),
  };
}

/**
 * The library reference a sub-graph reference reads, or why there is none:
 * a project reference without a path must name exactly one project template.
 */
export function graphSubgraphLibraryRef(
  ref: GraphTemplateRef,
  projectId: string | null,
  summaries: readonly GraphTemplateSummary[],
): GraphLibraryRef | { missing: "no-project" | "not-found" | "ambiguous" } {
  if (ref.scope === "builtin") return { scope: "builtin", id: ref.id };
  if (ref.scope === "user") return { scope: "user", id: ref.id };
  if (!projectId) return { missing: "no-project" };
  if (ref.path !== undefined) return { scope: "project", projectId, path: ref.path };
  const matches = summaries.filter(
    (summary) => summary.ref.scope === "project" && summary.id === ref.id,
  );
  if (matches.length === 0) return { missing: "not-found" };
  if (matches.length > 1) return { missing: "ambiguous" };
  return matches[0]!.ref;
}

/** The sub-graph references a template names directly. */
export function graphSubgraphRefs(template: GraphTemplateV1): GraphTemplateRef[] {
  return template.nodes.flatMap((node) => (node.kind === "subgraph" ? [node.template] : []));
}

/**
 * References a compile of `template` needs that the cache does not hold yet:
 * its own, and those of children already fetched (nested sub-graphs).
 */
export function graphSubgraphRefsToFetch(
  template: GraphTemplateV1,
  entries: ReadonlyMap<string, GraphDesignerSubgraphEntry>,
  projectId: string | null,
): GraphTemplateRef[] {
  const wanted: GraphTemplateRef[] = [];
  const seen = new Set<string>();
  const queue = [...graphSubgraphRefs(template)];
  while (queue.length > 0) {
    const ref = queue.shift()!;
    const key = graphDesignerSubgraphKey(projectId, ref);
    if (seen.has(key) || ref.scope === "builtin") continue;
    seen.add(key);
    const entry = entries.get(key);
    if (!entry) {
      wanted.push(ref);
      continue;
    }
    if (entry.status === "ready" && "template" in entry.resolution) {
      queue.push(...graphSubgraphRefs(entry.resolution.template));
    }
  }
  return wanted;
}

/** The resolver a browser compile uses: built-ins from code, the rest from the cache. */
export function graphDesignerSubgraphResolver(
  entries: ReadonlyMap<string, GraphDesignerSubgraphEntry>,
  projectId: string | null,
): GraphTemplateResolver {
  return (ref) => {
    if (ref.scope === "builtin") return graphBuiltinTemplateResolver(ref);
    const entry = entries.get(graphDesignerSubgraphKey(projectId, ref));
    return entry?.status === "ready" ? entry.resolution : undefined;
  };
}

/** The resolution a fetched library template gives a compile. */
export function graphSubgraphResolutionFor(
  summary: GraphTemplateSummary,
  template: GraphTemplateV1,
): GraphTemplateResolution {
  if (summary.trust !== "trusted") return { missing: "untrusted" };
  return {
    template,
    revision: summary.revision,
    ...(summary.ref.scope === "project" ? { path: summary.ref.path } : {}),
  };
}

export interface GraphSubgraphChoice {
  summary: GraphTemplateSummary;
  /** Why it cannot be picked; absent when it can. */
  disabled?: string;
}

/**
 * The saved templates the palette's "Sub-graph" menu offers, in library
 * order: never the template being edited, and an untrusted project template
 * only as a disabled entry.
 */
export function graphSubgraphChoices(
  summaries: readonly GraphTemplateSummary[],
  self: { scope: string; id: string } | null,
): GraphSubgraphChoice[] {
  return summaries
    .filter((summary) => !(self && summary.scope === self.scope && summary.id === self.id))
    .map((summary) =>
      summary.trust === "trusted"
        ? { summary }
        : {
            summary,
            disabled:
              summary.trust === "changed"
                ? "Changed since it was trusted; trust it again to use it"
                : "Not trusted; trust it to use it",
          },
    );
}

/** A sub-graph node for `child`: ports from its run inputs and outputs, roles bound by key. */
export function graphSubgraphNode(
  id: string,
  ref: GraphTemplateRef,
  child: GraphTemplateV1,
): GraphSubgraphNode {
  return {
    id,
    kind: "subgraph",
    label: child.name,
    template: ref,
    ...graphSubgraphPorts(child),
  };
}

/** The parent's roles plus a copy of every child role it lacks (bound by the same key). */
export function graphSubgraphRoles(
  parent: readonly GraphRole[],
  child: GraphTemplateV1,
): GraphRole[] {
  const keys = new Set(parent.map((role) => role.key));
  return [
    ...parent,
    ...child.roles.filter((role) => !keys.has(role.key)).map((role) => structuredClone(role)),
  ];
}

/** The node with its ports replaced by the child's current run inputs and outputs. */
export function graphSubgraphRefreshPorts(
  node: GraphSubgraphNode,
  child: GraphTemplateV1,
): GraphSubgraphNode {
  return { ...node, ...graphSubgraphPorts(child) };
}

export type GraphSubgraphParamMode = "default" | "value" | "param";

export function graphSubgraphParamMode(
  binding: GraphParameterBinding | undefined,
): GraphSubgraphParamMode {
  if (binding === undefined) return "default";
  return binding !== null && typeof binding === "object" ? "param" : "value";
}

/** A starting literal for a child parameter: its default, or the type's simplest value. */
export function graphSubgraphParamLiteral(parameter: GraphParameter): string | number | boolean {
  if (parameter.default !== undefined) return parameter.default;
  switch (parameter.type) {
    case "boolean":
      return false;
    case "integer":
    case "number":
      return parameter.min ?? 0;
    case "string":
      return "";
    case "enum":
      return parameter.options[0] ?? "";
  }
}

/** The node with one parameter binding set (`undefined` falls back to the child's default). */
export function graphSubgraphBindParam(
  node: GraphSubgraphNode,
  key: string,
  binding: GraphParameterBinding | undefined,
): GraphSubgraphNode {
  const params = { ...node.params };
  if (binding === undefined) delete params[key];
  else params[key] = binding;
  const next: GraphSubgraphNode = { ...node, params };
  if (Object.keys(params).length === 0) delete next.params;
  return next;
}

/** The node with one role binding set (`undefined` binds the parent role of the same key). */
export function graphSubgraphBindRole(
  node: GraphSubgraphNode,
  key: string,
  role: string | undefined,
): GraphSubgraphNode {
  const roles = { ...node.roles };
  if (role === undefined) delete roles[key];
  else roles[key] = role;
  const next: GraphSubgraphNode = { ...node, roles };
  if (Object.keys(roles).length === 0) delete next.roles;
  return next;
}

/** The plan id's top-level node: a diagnostic on `review/plan` belongs to node `review`. */
export function graphDesignerNodeOf(planId: string): string {
  const slash = planId.indexOf("/");
  return slash < 0 ? planId : planId.slice(0, slash);
}
