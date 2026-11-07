/**
 * Contract domains (docs/reports/unified-federation.md §11.2, Decision 13.9).
 *
 * A domain groups the commands and events that change together. Each has one
 * integer version; a backend accepts a range `[min, version]` of it and
 * advertises that range in its hello (`domains`, plan item 1004). The version
 * goes up only for a change an older peer cannot handle silently: a field
 * removed, renamed or changed in type or meaning, a new must-understand
 * (critical) field, or a command removed or changed in meaning. Adding an
 * optional field or a new command never bumps it.
 *
 * Version 0 is reserved: it is the legacy, pre-contract behaviour a client
 * uses for a node that advertises no range for the domain (§11.4). A defined
 * domain therefore starts at version 1.
 *
 * Browser-safe: no Node or Bun imports.
 */

/**
 * The hello capability name pattern (`parseBackendHello`), which domain names
 * share so that the hello's `domains` field can be parsed with the same rules.
 * The `u` flag lets the pattern appear in a JSON Schema export.
 */
export const DOMAIN_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;

/** The longest domain name, the same bound as a hello capability name. */
export const MAX_DOMAIN_NAME_LENGTH = 64;

/** The highest domain version a definition or a hello may carry. */
export const MAX_DOMAIN_VERSION = 1_000;

/**
 * Every contract domain, seeded from the report's Appendix E grouping. A new
 * domain is added here first: `defineDomain` accepts only these names, so the
 * list stays the one place a reviewer sees the domain set.
 */
export const DOMAIN_NAMES = [
  "environments",
  "projects",
  "config",
  "native-sessions",
  "transcripts",
  "terminals",
  "files",
  "git",
  "pull-requests",
  "pipelines",
  "graphs",
  "multi-review",
  "kanban",
  "agent-mail",
  "accounts",
  "docker",
  "previews",
  "web-annotations",
  "design",
  "mcp",
  "nodes",
  "node-mail",
  "node-files",
  "ticket-sync",
  "system",
  "coordinator",
  "agent-servers",
  "claude-tmux",
  // Appendix E's "Public API (`public_action`)" group (plan item 1006).
  "public-api",
] as const;

export type DomainName = (typeof DOMAIN_NAMES)[number];

const DOMAIN_NAME_SET: ReadonlySet<string> = new Set(DOMAIN_NAMES);

/** Whether `value` has the shape of a domain name (known or not). */
export function isDomainNameShape(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DOMAIN_NAME_LENGTH &&
    DOMAIN_NAME_PATTERN.test(value)
  );
}

/** Whether `value` is one of {@link DOMAIN_NAMES}. */
export function isDomainName(value: unknown): value is DomainName {
  return typeof value === "string" && DOMAIN_NAME_SET.has(value);
}

/** A domain definition. Create it with {@link defineDomain}; it is frozen. */
export interface DomainDef<Name extends DomainName = DomainName> {
  readonly kind: "domain";
  readonly name: Name;
  /** The current version: the highest this build speaks. */
  readonly version: number;
  /**
   * The oldest version this build still accepts from a peer. The hello
   * advertises `{ min, max: version }` (plan item 1004).
   */
  readonly min: number;
}

/** Any domain definition, for constraints. */
export type AnyDomainDef = DomainDef<DomainName>;

function isVersion(value: unknown, minimum: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= MAX_DOMAIN_VERSION
  );
}

/**
 * Defines a domain. `min` defaults to `version`: a build accepts only its own
 * version unless it declares the older ones it still handles, so a bump that
 * keeps accepting older peers says so explicitly.
 *
 * Throws on an unknown name or an invalid version range, at module load.
 */
export function defineDomain<const Name extends DomainName>(spec: {
  readonly name: Name;
  readonly version: number;
  readonly min?: number;
}): DomainDef<Name> {
  const { name, version } = spec;
  const min = spec.min ?? version;
  if (!isDomainName(name)) {
    throw new Error(`Unknown contract domain "${String(name)}": add it to DOMAIN_NAMES.`);
  }
  if (!isVersion(version, 1) || !isVersion(min, 1) || min > version) {
    throw new Error(`Contract domain "${name}" has an invalid version range.`);
  }
  return Object.freeze({ kind: "domain", name, version, min });
}
