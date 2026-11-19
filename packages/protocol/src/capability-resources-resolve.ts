/**
 * Deterministic resolution of the capability packages one agent target gets
 * (docs/architecture/agent-capabilities-management.md, "Resolution").
 *
 * Two independent passes:
 *
 * 1. **Desired resources.** My setup, then the selected toolkits, then the
 *    project manifest, then agent template / graph-node assignments, then
 *    explicit session changes. A later, more specific layer may override a
 *    package version or exclude a component; a version override is reported
 *    as a conflict diagnostic. Administrator policy can forbid a source or a
 *    component whatever any layer asks.
 * 2. **Permission ceiling.** The existing native-agent execution policy,
 *    graph capability ceilings and MCP grants. An assignment can request a
 *    resource but can never grant an operation the policy denies; an
 *    explicit denial always wins.
 *
 * The result is compiled against the provider's support matrix: a
 * component the provider cannot take is `unsupported` with its reason. A
 * required component that is unsupported or blocked becomes a launch
 * blocker; an optional one is skipped with a warning.
 *
 * Browser-safe and pure: the caller supplies the hash function.
 */
import type { AgentPlatform } from "./agent-platforms.js";
import {
  CAPABILITY_LIMITS,
  MY_SETUP_ID,
  capabilityRiskRank,
  isCapabilitySelector,
  type CapabilityComponent,
  type CapabilityComponentChange,
  type CapabilityPackage,
  type CapabilityPackageSelection,
  type CapabilitySetup,
  type CapabilityTarget,
  type CapabilityUpdatePolicy,
  type EffectiveAgentResources,
} from "./capability-resources.js";
import type { CapabilitySupportMatrix } from "./capability-resources-support.js";

// --- Canonical JSON ---------------------------------------------------------

/** JSON with object keys sorted at every level: the input of every digest. */
export function canonicalCapabilityJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) sorted[key] = sortKeys(entry);
    }
    return sorted;
  }
  return value;
}

// --- Layers -------------------------------------------------------------------

export const CAPABILITY_LAYER_SCOPES = [
  "my-setup",
  "toolkit",
  "project",
  "template",
  "graph-node",
  "session",
] as const;
export type CapabilityLayerScope = (typeof CAPABILITY_LAYER_SCOPES)[number];

/** One layer of desired resources, from least to most specific. */
export interface CapabilityLayer {
  scope: CapabilityLayerScope;
  /** Setups this layer brings in (expanded with their parents). */
  setupIds?: string[];
  /** Selections made directly at this layer (a project manifest, a session change). */
  selections?: CapabilityPackageSelection[];
  /** Package or component ids removed at this layer. */
  exclusions?: string[];
}

/** Where a target sits, so selectors can match it. */
export interface CapabilityTargetFacts {
  target: CapabilityTarget;
  /** Device groups the target's machine belongs to. */
  groups: string[];
  templateId?: string;
  graphNode?: string;
  /** The machine is enrolled in My setup. */
  enrolled: boolean;
}

/** System and organisation restrictions that no layer can lift. */
export interface CapabilityAdminPolicy {
  /** Package id prefixes that may not be used (`git:github.com/untrusted/`). */
  forbiddenSources?: string[];
  /** Exact package or component ids that may not be used. */
  forbiddenComponents?: string[];
  /** Highest risk any component may have. */
  maxRisk?: CapabilityComponent["risk"];
}

/**
 * The permission ceiling, from the session's execution policy: the
 * capabilities it denies (`shell`, `network`, `mcp:<server>`), and the user
 * MCP servers it grants (`null` means the policy does not restrict them).
 */
export interface CapabilityPermissionCeiling {
  denied: string[];
  userMcpServers: string[] | null;
  /** A digest of the policy the ceiling came from; changes with the policy. */
  digest: string;
}

export const UNRESTRICTED_CAPABILITY_CEILING: CapabilityPermissionCeiling = Object.freeze({
  denied: [],
  userMcpServers: null,
  digest: "unrestricted",
}) as CapabilityPermissionCeiling;

export interface CapabilityResolutionInput {
  facts: CapabilityTargetFacts;
  layers: CapabilityLayer[];
  setups: ReadonlyMap<string, CapabilitySetup>;
  packages: ReadonlyMap<string, CapabilityPackage>;
  components: ReadonlyMap<string, CapabilityComponent>;
  support: CapabilitySupportMatrix;
  /** When resolving a launch, return the reason a required revision is unavailable. */
  requiredDelivery?: (component: CapabilityComponent, artifactDigest: string) => string | undefined;
  ceiling: CapabilityPermissionCeiling;
  admin?: CapabilityAdminPolicy;
  hash: (text: string) => string;
  now?: () => string;
}

interface Selected {
  selection: CapabilityPackageSelection;
  scope: CapabilityLayerScope;
}

/** Whether `selector` names this target. */
export function capabilitySelectorMatches(selector: string, facts: CapabilityTargetFacts): boolean {
  if (selector === "*") return true;
  const colon = selector.indexOf(":");
  if (colon <= 0) return false;
  const kind = selector.slice(0, colon);
  const value = selector.slice(colon + 1);
  const target = facts.target;
  switch (kind) {
    case "provider":
      return target.provider === value;
    case "machine":
      return target.nodeId === value;
    case "group":
      return facts.groups.includes(value);
    case "project":
      return target.projectId === value;
    case "environment":
      return target.environmentId === value;
    case "session":
      return target.sessionId === value;
    case "account":
      return target.accountHomeId === value;
    case "template":
      return facts.templateId === value;
    case "graph-node":
      return facts.graphNode === value;
    default:
      return false;
  }
}

function setupApplies(setup: CapabilitySetup, facts: CapabilityTargetFacts): boolean {
  if (setup.id === MY_SETUP_ID && !facts.enrolled) return false;
  const anyOf = (selectors: readonly string[]) =>
    selectors.length === 0 ||
    selectors.some((selector) => capabilitySelectorMatches(selector, facts));
  if (!anyOf(setup.providerSelectors)) return false;
  if (!anyOf(setup.machineSelectors)) return false;
  if (setup.targetSelectors && setup.targetSelectors.length > 0) {
    return setup.targetSelectors.some((selector) => capabilitySelectorMatches(selector, facts));
  }
  return true;
}

/**
 * A setup with its parents, parents first. A cycle or a chain deeper than
 * the limit is reported, never followed forever.
 */
export function expandCapabilitySetup(
  setupId: string,
  setups: ReadonlyMap<string, CapabilitySetup>,
): { order: CapabilitySetup[]; errors: string[] } {
  const order: CapabilitySetup[] = [];
  const errors: string[] = [];
  const done = new Set<string>();
  const visit = (id: string, stack: string[]) => {
    if (done.has(id)) return;
    if (stack.includes(id)) {
      errors.push(
        `Setup ${[...stack, id].join(" → ")} forms a cycle; the repeated parent is ignored.`,
      );
      return;
    }
    if (stack.length >= CAPABILITY_LIMITS.maxSetupDepth) {
      errors.push(`Setup ${id} is nested deeper than ${CAPABILITY_LIMITS.maxSetupDepth} levels.`);
      return;
    }
    const setup = setups.get(id);
    if (!setup) {
      errors.push(`Setup ${id} does not exist.`);
      return;
    }
    for (const parent of setup.parentSetupIds) visit(parent, [...stack, id]);
    done.add(id);
    order.push(setup);
  };
  visit(setupId, []);
  return { order, errors };
}

/** `selector|id` exclusions apply to matching targets; a bare id applies everywhere. */
function exclusionApplies(exclusion: string, facts: CapabilityTargetFacts): string | null {
  const bar = exclusion.indexOf("|");
  if (bar < 0) return exclusion;
  const selector = exclusion.slice(0, bar);
  if (!isCapabilitySelector(selector) || !capabilitySelectorMatches(selector, facts)) return null;
  return exclusion.slice(bar + 1);
}

/**
 * Resolves one target's effective resources. Pure and deterministic: the
 * same inputs give the same manifest digest.
 */
export function resolveEffectiveAgentResources(
  input: CapabilityResolutionInput,
): EffectiveAgentResources {
  const { facts, setups, packages, components, support, ceiling } = input;
  const warnings: string[] = [];
  const selected = new Map<string, Selected>();
  const excluded = new Set<string>();
  const setupRevisions = new Map<string, number>();

  const select = (selection: CapabilityPackageSelection, scope: CapabilityLayerScope) => {
    const previous = selected.get(selection.packageId);
    if (
      previous &&
      previous.selection.version !== selection.version &&
      previous.selection.version !== "latest"
    ) {
      warnings.push(
        `${packages.get(selection.packageId)?.displayName ?? selection.packageId}: the ${scope} layer overrides version ${previous.selection.version} from the ${previous.scope} layer with ${selection.version}.`,
      );
    }
    selected.set(selection.packageId, {
      selection: {
        ...selection,
        // A more specific layer that names no components keeps the earlier choice.
        ...(selection.components === undefined && previous?.selection.components
          ? { components: previous.selection.components }
          : {}),
        required: selection.required ?? previous?.selection.required ?? false,
      },
      scope,
    });
  };

  for (const layer of input.layers) {
    for (const setupId of layer.setupIds ?? []) {
      const { order, errors } = expandCapabilitySetup(setupId, setups);
      warnings.push(...errors);
      for (const setup of order) {
        if (!setupApplies(setup, facts)) continue;
        setupRevisions.set(setup.id, setup.revision);
        for (const selection of setup.packageSelections) select(selection, layer.scope);
        for (const exclusion of setup.exclusions) {
          const id = exclusionApplies(exclusion, facts);
          if (id) excluded.add(id);
        }
      }
    }
    for (const selection of layer.selections ?? []) select(selection, layer.scope);
    for (const exclusion of layer.exclusions ?? []) {
      const id = exclusionApplies(exclusion, facts);
      if (id) excluded.add(id);
    }
  }

  const resolvedPackages: EffectiveAgentResources["resolvedPackages"] = [];
  const unsupported: EffectiveAgentResources["unsupported"] = [];
  const blocked: EffectiveAgentResources["blocked"] = [];
  const launchBlockers: EffectiveAgentResources["launchBlockers"] = [];
  const admin = input.admin ?? {};
  const denied = new Set(ceiling.denied);

  for (const packageId of [...selected.keys()].sort()) {
    const { selection } = selected.get(packageId)!;
    const required = selection.required === true;
    const pkg = packages.get(packageId);
    if (!pkg) {
      const reason = "The package is not in the library.";
      blocked.push({ componentId: packageId, reason });
      if (required) launchBlockers.push({ componentId: packageId, reason });
      continue;
    }
    if (excluded.has(packageId)) continue;
    if (pkg.paused) {
      if (required)
        launchBlockers.push({ componentId: packageId, reason: "The required package is paused." });
      warnings.push(`${pkg.displayName} is paused and is not delivered.`);
      continue;
    }
    const digest = revisionDigest(pkg, selection.version);
    if (!digest) {
      const reason = `Revision ${selection.version} is no longer available; update the selection.`;
      blocked.push({ componentId: packageId, reason });
      if (required) launchBlockers.push({ componentId: packageId, reason });
      continue;
    }
    const forbiddenSource = (admin.forbiddenSources ?? []).find((prefix) =>
      packageId.startsWith(prefix),
    );
    const revisionComponents = capabilityRevisionComponents(pkg, digest, components);
    if (!revisionComponents) {
      const reason = "The selected revision's component inventory is unavailable.";
      blocked.push({ componentId: packageId, reason });
      if (required) launchBlockers.push({ componentId: packageId, reason });
      continue;
    }
    const byId = new Map(revisionComponents.map((component) => [component.id, component]));
    const wanted = (selection.components ?? [...byId.keys()]).filter(
      (componentId) => !excluded.has(componentId),
    );
    const delivered: string[] = [];
    for (const componentId of wanted) {
      const component = byId.get(componentId);
      if (!component) {
        const reason = "The selected revision does not contain this component.";
        blocked.push({ componentId, reason });
        if (required) launchBlockers.push({ componentId, reason });
        continue;
      }
      const reasonBlocked =
        (forbiddenSource !== undefined ? "Administrator policy forbids this source." : undefined) ??
        ((admin.forbiddenComponents ?? []).some((id) => id === componentId || id === packageId)
          ? "Administrator policy forbids this component."
          : undefined) ??
        (admin.maxRisk && capabilityRiskRank(component.risk) > capabilityRiskRank(admin.maxRisk)
          ? `Administrator policy allows at most ${admin.maxRisk} components.`
          : undefined) ??
        ceilingDenial(component, denied, ceiling.userMcpServers);
      if (reasonBlocked) {
        blocked.push({ componentId, reason: reasonBlocked });
        if (required) launchBlockers.push({ componentId, reason: reasonBlocked });
        continue;
      }
      const install = support.kinds[component.kind].install;
      if (install.level === "unsupported") {
        const reason = install.reason ?? "Not supported by this provider.";
        unsupported.push({ componentId, reason });
        if (required) launchBlockers.push({ componentId, reason });
        else warnings.push(`${component.name}: skipped on ${facts.target.provider}. ${reason}`);
        continue;
      }
      if (component.kind === "skill" && component.risk === "executable" && denied.has("shell")) {
        warnings.push(
          `${component.name}: its scripts cannot run because the session denies shell; its instructions are still available.`,
        );
      }
      if (required) {
        const reason = input.requiredDelivery?.(component, digest);
        if (reason) launchBlockers.push({ componentId, reason });
      }
      delivered.push(componentId);
    }
    if (delivered.length > 0) {
      resolvedPackages.push({
        id: packageId,
        artifactDigest: digest,
        components: delivered.sort(),
      });
    }
  }

  const sortedRevisions = [...setupRevisions.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, revision]) => ({ id, revision }));
  const manifestDigest = input.hash(
    canonicalCapabilityJson({
      target: facts.target,
      packages: resolvedPackages,
      policy: ceiling.digest,
    }),
  );
  return {
    target: facts.target,
    setupRevisions: sortedRevisions,
    resolvedPackages,
    permissionPolicyDigest: ceiling.digest,
    manifestDigest,
    unsupported,
    blocked,
    launchBlockers,
    warnings: [...new Set(warnings)],
    resolvedAt: (input.now ?? (() => new Date().toISOString()))(),
  };
}

export function capabilityRevisionComponents(
  pkg: CapabilityPackage,
  digest: string,
  current: ReadonlyMap<string, CapabilityComponent>,
): CapabilityComponent[] | undefined {
  if (digest !== pkg.artifactDigest) {
    return pkg.previousRevisions?.find((revision) => revision.artifactDigest === digest)
      ?.components;
  }
  return pkg.componentIds.flatMap((id) => {
    const component = current.get(id);
    return component ? [component] : [];
  });
}

export function revisionDigest(pkg: CapabilityPackage, version: string): string | null {
  if (version === "latest" || version === pkg.revision || version === pkg.artifactDigest) {
    return pkg.artifactDigest;
  }
  const previous = pkg.previousRevisions?.find(
    (entry) => entry.revision === version || entry.artifactDigest === version,
  );
  return previous?.artifactDigest ?? null;
}

/**
 * Why the permission ceiling refuses a component, or `undefined`. Deny wins:
 * a package asking for an MCP server never widens the session's grant.
 */
export function ceilingDenial(
  component: Pick<CapabilityComponent, "kind" | "name" | "pathOrKey" | "risk" | "endpoints">,
  denied: ReadonlySet<string>,
  userMcpServers: readonly string[] | null,
): string | undefined {
  if (component.kind === "mcp-server") {
    const server = component.pathOrKey;
    if (denied.has(`mcp:${server}`)) return `The session's policy denies mcp:${server}.`;
    if (userMcpServers !== null && !userMcpServers.includes(server)) {
      return `The session's MCP grant does not include ${server}.`;
    }
    if (denied.has("network") && (component.endpoints?.length ?? 0) > 0) {
      return "The session's policy denies network access, which this server needs.";
    }
    if (denied.has("shell") && component.risk === "executable") {
      return "The session's policy denies running programs, which this server needs.";
    }
    return undefined;
  }
  if (component.kind === "hook") {
    if (denied.has("shell") || denied.has("shell.mutate")) {
      return "The session's policy denies running programs, and a hook runs one on its own trigger.";
    }
    return undefined;
  }
  if (component.kind === "subagent" && denied.has("subagents")) {
    return "The session's policy denies subagents.";
  }
  if (component.risk === "network" && denied.has("network")) {
    return "The session's policy denies network access.";
  }
  return undefined;
}

// --- Updates --------------------------------------------------------------

/**
 * What changed between two revisions of a package, component by component,
 * and which changes raise its risk: a new hook, a new program it runs, a new
 * network endpoint, a new MCP server, or a higher risk level.
 */
export function compareCapabilityRevisions(
  before: readonly CapabilityComponent[],
  after: readonly CapabilityComponent[],
  contentChanged: (componentId: string) => boolean = () => false,
): CapabilityComponentChange[] {
  const old = new Map(before.map((component) => [component.id, component]));
  const changes: CapabilityComponentChange[] = [];
  for (const component of after) {
    const previous = old.get(component.id);
    if (!previous) {
      changes.push({
        componentId: component.id,
        kind: component.kind,
        change: "added",
        ...escalationOf(undefined, component),
      });
      continue;
    }
    old.delete(component.id);
    const modified =
      canonicalCapabilityJson(stripIds(previous)) !==
        canonicalCapabilityJson(stripIds(component)) || contentChanged(component.id);
    if (modified) {
      changes.push({
        componentId: component.id,
        kind: component.kind,
        change: "modified",
        ...escalationOf(previous, component),
      });
    }
  }
  for (const component of old.values()) {
    changes.push({ componentId: component.id, kind: component.kind, change: "removed" });
  }
  return changes.sort((a, b) => a.componentId.localeCompare(b.componentId));
}

function stripIds(component: CapabilityComponent): Omit<CapabilityComponent, "id" | "packageId"> {
  const { id: _id, packageId: _packageId, ...rest } = component;
  return rest;
}

function escalationOf(
  before: CapabilityComponent | undefined,
  after: CapabilityComponent,
): { escalation?: string } {
  if (!before) {
    if (after.kind === "hook")
      return { escalation: "Adds a hook that runs a program on its own trigger." };
    if (after.kind === "mcp-server") return { escalation: "Adds an MCP server connection." };
    if (capabilityRiskRank(after.risk) >= capabilityRiskRank("network")) {
      return { escalation: `Adds a ${after.risk} component.` };
    }
    return {};
  }
  if (capabilityRiskRank(after.risk) > capabilityRiskRank(before.risk)) {
    return { escalation: `Risk rises from ${before.risk} to ${after.risk}.` };
  }
  const newPrograms = (after.executes ?? []).filter(
    (entry) => !(before.executes ?? []).includes(entry),
  );
  if (newPrograms.length > 0) return { escalation: "Runs a program it did not run before." };
  const newEndpoints = (after.endpoints ?? []).filter(
    (entry) => !(before.endpoints ?? []).includes(entry),
  );
  if (newEndpoints.length > 0) return { escalation: "Connects to a new network endpoint." };
  const newTriggers = (after.triggers ?? []).filter(
    (entry) => !(before.triggers ?? []).includes(entry),
  );
  if (newTriggers.length > 0) return { escalation: "Fires on a new hook trigger." };
  return {};
}

/**
 * Whether an update needs the user's approval. Approval is the default; a
 * trusted-source rule lets an update through only when nothing in it raises
 * the package's risk. A pinned package is never updated automatically.
 */
export function capabilityUpdateApproval(
  policy: CapabilityUpdatePolicy,
  changes: readonly CapabilityComponentChange[],
  trustedSource: boolean,
): { requiresApproval: boolean; autoApply: boolean; reasons: string[] } {
  const escalations = changes
    .map((change) => change.escalation)
    .filter((reason): reason is string => Boolean(reason));
  if (policy === "pinned") {
    return { requiresApproval: true, autoApply: false, reasons: ["The package is pinned."] };
  }
  if (policy === "trusted-auto" && trustedSource && escalations.length === 0) {
    return { requiresApproval: false, autoApply: true, reasons: [] };
  }
  const reasons =
    escalations.length > 0
      ? [...new Set(escalations)]
      : policy === "trusted-auto" && !trustedSource
        ? ["The source is not on the trusted list."]
        : ["Updates need approval."];
  return { requiresApproval: true, autoApply: false, reasons };
}

/** Whether a plan needs approval before it is applied, and why. */
export function capabilityInstallApproval(components: readonly CapabilityComponent[]): {
  requiresApproval: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  for (const component of components) {
    if (component.kind === "hook") {
      reasons.push(
        `${component.name} is a hook that runs ${component.executes?.join(", ") || "a program"} on ${component.triggers?.join(", ") || "its trigger"}.`,
      );
    } else if (component.kind === "mcp-server") {
      reasons.push(
        `${component.name} starts an MCP server${component.endpoints?.length ? ` connecting to ${component.endpoints.join(", ")}` : component.executes?.length ? ` running ${component.executes.join(", ")}` : ""}.`,
      );
    } else if (component.risk === "executable" || component.risk === "privileged") {
      reasons.push(`${component.name} includes scripts an agent can run.`);
    }
  }
  return { requiresApproval: reasons.length > 0, reasons };
}

/** The providers a package can reach at all, from its components and the support matrices. */
export function compatibleProviders(
  components: readonly CapabilityComponent[],
  matrices: readonly CapabilitySupportMatrix[],
): AgentPlatform[] {
  return matrices
    .filter((matrix) =>
      components.some(
        (component) =>
          matrix.kinds[component.kind].install.level !== "unsupported" &&
          (component.providerHints.length === 0 ||
            component.providerHints.includes(matrix.provider)),
      ),
    )
    .map((matrix) => matrix.provider);
}
