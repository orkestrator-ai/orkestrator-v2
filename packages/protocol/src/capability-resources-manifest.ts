/**
 * Portable capability manifests (docs/architecture/agent-capabilities-management.md,
 * "Portable manifests and lockfiles").
 *
 * A project or an export bundle carries two files:
 *
 * - `orkestrator.capabilities.yaml`: the human-editable **intent**: named
 *   toolkits, package sources and channels, abstract target selectors,
 *   provider requirements, exclusions and required/optional components.
 * - `orkestrator.capabilities.lock.json`: the resolved immutable package
 *   digests and component ids, and the manifest format version.
 *
 * Neither file may hold a credential, a token or a host path; the
 * validators below refuse both, so an export can be committed to Git and an
 * import can never smuggle a secret into a machine's provider home.
 *
 * Browser-safe: the YAML text itself is parsed by the backend (`Bun.YAML`),
 * and this module validates the parsed value.
 */
import { AGENT_PLATFORMS, isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";
import {
  CAPABILITY_LIMITS,
  CAPABILITY_UPDATE_POLICIES,
  capabilityPackageId,
  isCapabilitySelector,
  isComponentKind,
  isPackageSource,
  type CapabilityUpdatePolicy,
  type ComponentKind,
  type PackageSource,
} from "./capability-resources.js";

export const CAPABILITY_INTENT_FILE = "orkestrator.capabilities.yaml";
export const CAPABILITY_LOCK_FILE = "orkestrator.capabilities.lock.json";
export const CAPABILITY_MANIFEST_VERSION = 1;

export interface CapabilityIntentPackage {
  source: PackageSource;
  /** A commit or version; the lockfile pins the exact digest. */
  revision?: string;
  components?: string[];
  required?: boolean;
}

export interface CapabilityIntentSetup {
  description?: string;
  packages: CapabilityIntentPackage[];
  providers?: AgentPlatform[];
  /** Abstract machine selectors: device group names, `*`. Never a machine id. */
  machines?: string[];
  exclusions?: string[];
  parents?: string[];
  updatePolicy?: CapabilityUpdatePolicy;
}

export interface CapabilityIntent {
  version: 1;
  setups: Record<string, CapabilityIntentSetup>;
}

export interface CapabilityLockPackage {
  id: string;
  source: PackageSource;
  revision: string;
  artifactDigest: string;
  components: Array<{ id: string; kind: ComponentKind; pathOrKey: string }>;
}

export interface CapabilityLockfile {
  formatVersion: 1;
  generatedBy: string;
  packages: CapabilityLockPackage[];
  setups: Record<string, { packageIds: string[] }>;
}

export interface CapabilityManifestIssue {
  path: string;
  message: string;
}

const SETUP_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Secret shapes refused in manifests, authored content and previews. A
 * finding names only the kind and where it was, never the value.
 */
const SECRET_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { kind: "GitHub token", pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { kind: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "OpenAI key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { kind: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    kind: "credential assignment",
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|bearer)\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{12,}/i,
  },
];

/** The kinds of secret found in `text` (deduplicated), or an empty list. */
export function findCapabilitySecrets(text: string): string[] {
  const found = new Set<string>();
  for (const { kind, pattern } of SECRET_PATTERNS) if (pattern.test(text)) found.add(kind);
  return [...found];
}

/** A string that looks like a host path (absolute, home-relative or a Windows drive). */
export function looksLikeHostPath(value: string): boolean {
  return /^(?:\/|~\/|~$|[A-Za-z]:[\\/]|\\\\)/.test(value.trim());
}

function scanValues(
  value: unknown,
  path: string,
  issues: CapabilityManifestIssue[],
  allowRepo: boolean,
) {
  if (typeof value === "string") {
    for (const kind of findCapabilitySecrets(value)) {
      issues.push({
        path,
        message: `Contains what looks like a ${kind}; manifests never carry credentials.`,
      });
    }
    if (!allowRepo && looksLikeHostPath(value)) {
      issues.push({
        path,
        message: "Contains a host path; manifests are portable and name no machine paths.",
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanValues(entry, `${path}[${index}]`, issues, allowRepo));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:token|password|secret|apiKey|api_key|credentials?|auth|env)$/i.test(key)) {
        issues.push({
          path: `${path}.${key}`,
          message: `A "${key}" field is not allowed in a manifest.`,
        });
        continue;
      }
      scanValues(entry, `${path}.${key}`, issues, allowRepo || key === "repo");
    }
  }
}

/** Validates a parsed intent document. Returns the typed value and every issue found. */
export function validateCapabilityIntent(value: unknown): {
  intent: CapabilityIntent | null;
  issues: CapabilityManifestIssue[];
} {
  const issues: CapabilityManifestIssue[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { intent: null, issues: [{ path: "$", message: "The manifest must be a mapping." }] };
  }
  const record = value as Record<string, unknown>;
  if (record.version !== CAPABILITY_MANIFEST_VERSION) {
    issues.push({ path: "$.version", message: `Expected version ${CAPABILITY_MANIFEST_VERSION}.` });
  }
  scanValues(record, "$", issues, false);
  const setupsValue = record.setups;
  if (setupsValue === null || typeof setupsValue !== "object" || Array.isArray(setupsValue)) {
    issues.push({ path: "$.setups", message: "Expected a mapping of setup names." });
    return { intent: null, issues };
  }
  const setups: Record<string, CapabilityIntentSetup> = {};
  const entries = Object.entries(setupsValue as Record<string, unknown>);
  if (entries.length > CAPABILITY_LIMITS.maxSetups) {
    issues.push({ path: "$.setups", message: `At most ${CAPABILITY_LIMITS.maxSetups} setups.` });
  }
  for (const [name, raw] of entries.slice(0, CAPABILITY_LIMITS.maxSetups)) {
    const at = `$.setups.${name}`;
    if (!SETUP_NAME.test(name)) {
      issues.push({ path: at, message: "Setup names are lower-case letters, digits and dashes." });
      continue;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push({ path: at, message: "Expected a mapping." });
      continue;
    }
    const setup = raw as Record<string, unknown>;
    const packages: CapabilityIntentPackage[] = [];
    const list = Array.isArray(setup.packages) ? setup.packages : [];
    if (!Array.isArray(setup.packages))
      issues.push({ path: `${at}.packages`, message: "Expected a list." });
    if (list.length > CAPABILITY_LIMITS.maxSelectionsPerSetup) {
      issues.push({ path: `${at}.packages`, message: "Too many packages." });
    }
    list
      .slice(0, CAPABILITY_LIMITS.maxSelectionsPerSetup)
      .forEach((entry: unknown, index: number) => {
        const where = `${at}.packages[${index}]`;
        if (entry === null || typeof entry !== "object") {
          issues.push({ path: where, message: "Expected a mapping." });
          return;
        }
        const item = entry as Record<string, unknown>;
        if (!isPackageSource(item.source)) {
          issues.push({ path: `${where}.source`, message: "Not a valid package source." });
          return;
        }
        if (item.source.kind === "local") {
          issues.push({
            path: `${where}.source`,
            message:
              "A local installation is specific to one machine and cannot be shared; adopt it as a managed package first.",
          });
          return;
        }
        packages.push({
          source: item.source,
          ...(typeof item.revision === "string" ? { revision: item.revision } : {}),
          ...(Array.isArray(item.components)
            ? { components: item.components.filter((c): c is string => typeof c === "string") }
            : {}),
          ...(typeof item.required === "boolean" ? { required: item.required } : {}),
        });
      });
    const providers = Array.isArray(setup.providers)
      ? setup.providers.filter((provider): provider is AgentPlatform => {
          const ok = isAgentPlatform(provider);
          if (!ok)
            issues.push({
              path: `${at}.providers`,
              message: `Unknown provider ${String(provider)}.`,
            });
          return ok;
        })
      : undefined;
    const machines = Array.isArray(setup.machines)
      ? setup.machines.filter((machine): machine is string => {
          const ok =
            typeof machine === "string" &&
            (machine === "*" || /^[a-z0-9][a-z0-9-]{0,63}$/.test(machine));
          if (!ok)
            issues.push({
              path: `${at}.machines`,
              message: "Machines are device group names or *.",
            });
          return ok;
        })
      : undefined;
    const exclusions = Array.isArray(setup.exclusions)
      ? setup.exclusions.filter((exclusion): exclusion is string => typeof exclusion === "string")
      : undefined;
    const parents = Array.isArray(setup.parents)
      ? setup.parents.filter(
          (parent): parent is string => typeof parent === "string" && SETUP_NAME.test(parent),
        )
      : undefined;
    const updatePolicy = (CAPABILITY_UPDATE_POLICIES as readonly unknown[]).includes(
      setup.updatePolicy,
    )
      ? (setup.updatePolicy as CapabilityUpdatePolicy)
      : undefined;
    if (setup.updatePolicy !== undefined && !updatePolicy) {
      issues.push({
        path: `${at}.updatePolicy`,
        message: "Expected approve, trusted-auto or pinned.",
      });
    }
    setups[name] = {
      ...(typeof setup.description === "string"
        ? { description: setup.description.slice(0, 500) }
        : {}),
      packages,
      ...(providers ? { providers } : {}),
      ...(machines ? { machines } : {}),
      ...(exclusions ? { exclusions } : {}),
      ...(parents ? { parents } : {}),
      ...(updatePolicy ? { updatePolicy } : {}),
    };
  }
  return { intent: { version: 1, setups }, issues };
}

/** Validates a parsed lockfile and checks it against the intent it should resolve. */
export function validateCapabilityLockfile(
  value: unknown,
  intent?: CapabilityIntent | null,
): { lock: CapabilityLockfile | null; issues: CapabilityManifestIssue[] } {
  const issues: CapabilityManifestIssue[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { lock: null, issues: [{ path: "$", message: "The lockfile must be an object." }] };
  }
  const record = value as Record<string, unknown>;
  if (record.formatVersion !== CAPABILITY_MANIFEST_VERSION) {
    issues.push({
      path: "$.formatVersion",
      message: `Expected format version ${CAPABILITY_MANIFEST_VERSION}.`,
    });
  }
  scanValues(record, "$", issues, false);
  const packages: CapabilityLockPackage[] = [];
  const rawPackages = Array.isArray(record.packages) ? record.packages : [];
  rawPackages.slice(0, CAPABILITY_LIMITS.maxPackages).forEach((entry: unknown, index: number) => {
    const at = `$.packages[${index}]`;
    if (entry === null || typeof entry !== "object") return;
    const item = entry as Record<string, unknown>;
    if (!isPackageSource(item.source)) {
      issues.push({ path: `${at}.source`, message: "Not a valid package source." });
      return;
    }
    const id = capabilityPackageId(item.source);
    if (item.id !== id)
      issues.push({ path: `${at}.id`, message: "The id does not match the source." });
    if (typeof item.artifactDigest !== "string" || !DIGEST.test(item.artifactDigest)) {
      issues.push({ path: `${at}.artifactDigest`, message: "Expected a sha256 digest." });
      return;
    }
    const components = (Array.isArray(item.components) ? item.components : [])
      .filter(
        (component: unknown): component is { id: string; kind: ComponentKind; pathOrKey: string } =>
          component !== null &&
          typeof component === "object" &&
          typeof (component as Record<string, unknown>).id === "string" &&
          isComponentKind((component as Record<string, unknown>).kind) &&
          typeof (component as Record<string, unknown>).pathOrKey === "string",
      )
      .map((component) => ({
        id: component.id,
        kind: component.kind,
        pathOrKey: component.pathOrKey,
      }));
    packages.push({
      id,
      source: item.source,
      revision: typeof item.revision === "string" ? item.revision : item.artifactDigest,
      artifactDigest: item.artifactDigest,
      components,
    });
  });
  const setups: CapabilityLockfile["setups"] = {};
  if (record.setups && typeof record.setups === "object" && !Array.isArray(record.setups)) {
    for (const [name, entry] of Object.entries(record.setups as Record<string, unknown>)) {
      const ids =
        entry &&
        typeof entry === "object" &&
        Array.isArray((entry as Record<string, unknown>).packageIds)
          ? ((entry as Record<string, unknown>).packageIds as unknown[]).filter(
              (id): id is string => typeof id === "string",
            )
          : [];
      setups[name] = { packageIds: ids };
    }
  }
  if (intent) {
    const locked = new Set(packages.map((pkg) => pkg.id));
    for (const [name, setup] of Object.entries(intent.setups)) {
      for (const pkg of setup.packages) {
        const id = capabilityPackageId(pkg.source);
        if (!locked.has(id)) {
          issues.push({
            path: `$.setups.${name}`,
            message: `${id} is in the manifest but not in the lockfile.`,
          });
        }
      }
      if (!setups[name])
        issues.push({ path: `$.setups.${name}`, message: "Missing from the lockfile." });
    }
  }
  return {
    lock: {
      formatVersion: 1,
      generatedBy:
        typeof record.generatedBy === "string" ? record.generatedBy.slice(0, 200) : "unknown",
      packages,
      setups,
    },
    issues,
  };
}

/** Every provider a setup may name in a manifest. */
export const CAPABILITY_MANIFEST_PROVIDERS: readonly AgentPlatform[] = AGENT_PLATFORMS;

/** Selectors a manifest may carry are abstract: groups and providers, never machine ids. */
export function isPortableCapabilitySelector(selector: string): boolean {
  return (
    isCapabilitySelector(selector) &&
    !selector.startsWith("machine:") &&
    !selector.startsWith("session:") &&
    !selector.startsWith("environment:") &&
    !selector.startsWith("account:")
  );
}
