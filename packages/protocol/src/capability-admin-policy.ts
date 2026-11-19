/**
 * Administrator (organisation) policy over Agent Capabilities
 * (docs/architecture/agent-capabilities-management.md, "Administrator policy").
 *
 * Two lists in the capabilities store's settings, edited with
 * `set_capability_admin_policy` and enforced by the resolver over every
 * setup layer:
 *
 * - `forbiddenSources`: package id prefixes. `git:github.com/org/` forbids
 *   every package from that organisation's repositories, `registry:team/`
 *   a whole registry, `git:` every Git package;
 * - `forbiddenComponents`: exact package ids, exact component ids
 *   (`<packageId>#<kind>:<key>`), or a whole kind (`kind:hook`).
 *
 * The parsers below normalise what an administrator types (a Git address
 * becomes the canonical `git:<host>/<path>` prefix, `registry:<id>` gains its
 * trailing slash so it cannot match `registry:<id>2/…`) and refuse anything
 * that could never match a package. The same parsers run in the Settings
 * form and in the backend command, which is the authority.
 *
 * Browser-safe.
 */
import {
  canonicalGitRepo,
  COMPONENT_KIND_LABELS,
  isCapabilityRegistryId,
  isComponentKind,
  parseCapabilityComponentId,
  type ComponentKind,
} from "./capability-resources.js";

export const CAPABILITY_ADMIN_POLICY_LIMITS = Object.freeze({
  /** Entries per list. */
  maxEntries: 200,
  maxEntryChars: 300,
});

/** The package id schemes a source prefix can name (`capabilityPackageId`). */
export const CAPABILITY_SOURCE_SCHEMES = [
  "git:",
  "registry:",
  "marketplace:",
  "local:",
  "managed:",
] as const;

/** The administrator policy as Settings shows it. */
export interface CapabilityAdminPolicyView {
  /** Bumped on every policy change: the compare-and-swap basis for `set_capability_admin_policy`. */
  revision: number;
  forbiddenSources: string[];
  forbiddenComponents: string[];
  updatedAt?: string;
  /**
   * Library packages the policy blocks now: the first entry that matches
   * each, and whether any setup uses the package (those show "Blocked by
   * policy" wherever they are assigned).
   */
  blocked: Array<{ packageId: string; displayName: string; entry: string; assigned: boolean }>;
  /** More blocked packages than `blocked` lists. */
  blockedTruncated: number;
}

export type CapabilityPolicyEntryResult = { value: string } | { error: string };

const UNSAFE = /[\s\u0000-\u001f\u007f]/;

function common(raw: string): CapabilityPolicyEntryResult {
  const value = raw.trim();
  if (value.length === 0) return { error: "Enter a value." };
  if (value.length > CAPABILITY_ADMIN_POLICY_LIMITS.maxEntryChars) {
    return { error: `At most ${CAPABILITY_ADMIN_POLICY_LIMITS.maxEntryChars} characters.` };
  }
  if (UNSAFE.test(value)) return { error: "Spaces and control characters are not allowed." };
  return { value };
}

const hasScheme = (value: string) =>
  CAPABILITY_SOURCE_SCHEMES.some((scheme) => value.startsWith(scheme));

/** A Git address or `host/path` as the canonical `git:` prefix, keeping a trailing slash. */
function gitPrefix(rest: string): CapabilityPolicyEntryResult {
  if (rest.length === 0) return { value: "git:" };
  if (/^(?:file|ext)::?/i.test(rest)) return { error: "Only https and SSH Git addresses exist." };
  const trailing = rest.endsWith("/");
  const hasProtocol = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(rest) || /^[^/]+@[^/]+:/.test(rest);
  // A bare `host/path` reads like an https address when its first segment is a host.
  const address = hasProtocol ? rest : /^[^/]+\.[^/]+(?:\/|$)/.test(rest) ? `https://${rest}` : "";
  if (!address) {
    return { error: "Name the host and path, like git:github.com/your-org/." };
  }
  // The same canonical form as package ids: lower-case host (and path on the
  // big forges), no scheme, credentials, port or `.git`.
  const canonical = canonicalGitRepo(address);
  if (!canonical || !canonical.includes("/")) {
    return { error: "Name the host and path, like git:github.com/your-org/." };
  }
  return { value: `git:${canonical}${trailing ? "/" : ""}` };
}

/**
 * A forbidden source prefix, normalised: `git:<host>/<path>` (an https or SSH
 * address is accepted and canonicalised), `registry:<id>/…`,
 * `marketplace:<provider>:…`, `local:…` or `managed:…`.
 */
export function parseForbiddenSource(raw: string): CapabilityPolicyEntryResult {
  const checked = common(raw);
  if ("error" in checked) return checked;
  let value = checked.value;
  if (/^(?:https?|ssh):\/\//i.test(value) || /^[^/:]+@[^/:]+:/.test(value)) value = `git:${value}`;
  if (!hasScheme(value)) {
    return {
      error: `Start with ${CAPABILITY_SOURCE_SCHEMES.join(", ")} (for example git:github.com/your-org/ or registry:team/).`,
    };
  }
  if (value.startsWith("git:")) return gitPrefix(value.slice("git:".length));
  if (value.startsWith("registry:")) {
    const rest = value.slice("registry:".length);
    if (rest.length === 0) return { value: "registry:" };
    const slash = rest.indexOf("/");
    const id = slash < 0 ? rest : rest.slice(0, slash);
    if (!isCapabilityRegistryId(id)) {
      return { error: "A registry id is lower-case letters, digits and dashes." };
    }
    // `registry:team` would also match `registry:team2/…`.
    return { value: slash < 0 ? `registry:${id}/` : value };
  }
  return { value };
}

/** The `forbiddenComponents` entry that forbids every component of a kind. */
export function forbiddenKindEntry(kind: ComponentKind): string {
  return `kind:${kind}`;
}

/**
 * A forbidden component, normalised: `kind:<kind>` (a bare kind such as
 * `hook` is accepted), an exact component id (`<packageId>#<kind>:<key>`), or
 * an exact package id.
 */
export function parseForbiddenComponent(raw: string): CapabilityPolicyEntryResult {
  const checked = common(raw);
  if ("error" in checked) return checked;
  const { value } = checked;
  const kind = value.startsWith("kind:") ? value.slice("kind:".length) : value;
  if (isComponentKind(kind)) return { value: forbiddenKindEntry(kind) };
  if (value.startsWith("kind:")) return { error: `"${kind}" is not a component kind.` };
  if (value.includes("#")) {
    const parsed = parseCapabilityComponentId(value);
    if (!parsed || !hasScheme(parsed.packageId)) {
      return { error: "A component id is <package id>#<kind>:<name>, as Capabilities shows it." };
    }
    return { value };
  }
  if (!hasScheme(value) || value.endsWith(":")) {
    return {
      error:
        "Name a component kind (hook, mcp-server, …), a component id or a package id such as git:github.com/org/tools.",
    };
  }
  return { value };
}

/** Why the policy forbids a component, or `undefined`. Sources win over components. */
export function capabilityPolicyDenial(
  policy: { forbiddenSources?: readonly string[]; forbiddenComponents?: readonly string[] },
  packageId: string,
  component: { id: string; kind: ComponentKind },
): string | undefined {
  if ((policy.forbiddenSources ?? []).some((prefix) => packageId.startsWith(prefix))) {
    return "Administrator policy forbids this source.";
  }
  const forbidden = policy.forbiddenComponents ?? [];
  if (forbidden.some((id) => id === component.id || id === packageId)) {
    return "Administrator policy forbids this component.";
  }
  if (forbidden.includes(forbiddenKindEntry(component.kind))) {
    return `Administrator policy forbids every component of kind ${COMPONENT_KIND_LABELS[component.kind]}.`;
  }
  return undefined;
}

/** The first policy entry that blocks a package (its source, its id, or one of its components). */
export function capabilityPolicyPackageMatch(
  policy: { forbiddenSources?: readonly string[]; forbiddenComponents?: readonly string[] },
  packageId: string,
  components: ReadonlyArray<{ id: string; kind: ComponentKind }>,
): string | undefined {
  const source = (policy.forbiddenSources ?? []).find((prefix) => packageId.startsWith(prefix));
  if (source !== undefined) return source;
  const forbidden = policy.forbiddenComponents ?? [];
  if (forbidden.includes(packageId)) return packageId;
  for (const component of components) {
    const entry = forbidden.find(
      (id) => id === component.id || id === forbiddenKindEntry(component.kind),
    );
    if (entry !== undefined) return entry;
  }
  return undefined;
}
