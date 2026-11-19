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
 *   digests and component ids, and the manifest format version. Format 2
 *   lists a package once per revision and lets each setup name the exact
 *   entry it uses, and may carry an Ed25519 signature over the lockfile and
 *   the intent's digest; format 1 (one revision per package, unsigned) is
 *   still read and is written whenever it suffices.
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
import { canonicalCapabilityJson } from "./capability-resources-resolve.js";

export const CAPABILITY_INTENT_FILE = "orkestrator.capabilities.yaml";
export const CAPABILITY_LOCK_FILE = "orkestrator.capabilities.lock.json";
/** The intent (`orkestrator.capabilities.yaml`) format version. */
export const CAPABILITY_MANIFEST_VERSION = 1;
/** Lockfile formats this version reads; it writes 1 when that suffices, else 2. */
export const CAPABILITY_LOCK_FORMAT_VERSIONS = [1, 2] as const;
export type CapabilityLockFormatVersion = (typeof CAPABILITY_LOCK_FORMAT_VERSIONS)[number];

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

/** One setup's reference to the exact lock entry (package and revision) it uses. */
export interface CapabilityLockSetupRef {
  packageId: string;
  artifactDigest: string;
}

/**
 * An Ed25519 signature over {@link capabilityLockSigningPayload}, made with
 * the exporting installation's sharing key. Holds public data only.
 */
export interface CapabilityManifestSignature {
  algorithm: "ed25519";
  /** First 16 bytes of SHA-256 of the public key, hex. */
  keyId: string;
  /** Raw Ed25519 public key, base64url. */
  publicKey: string;
  /** SHA-256 of the validated intent's canonical JSON, so the YAML is covered too. */
  intentDigest: string;
  /** Base64url signature. */
  value: string;
}

/**
 * The lockfile, in its format 2 shape. Format 1 (one revision per package,
 * setups list package ids) is read into it; format 2 lists each package once
 * per revision and setups name the exact entry, so two setups can pin two
 * revisions of one package.
 */
export interface CapabilityLockfile {
  formatVersion: CapabilityLockFormatVersion;
  generatedBy: string;
  packages: CapabilityLockPackage[];
  setups: Record<string, { packageIds: string[]; packages: CapabilityLockSetupRef[] }>;
  signature?: CapabilityManifestSignature;
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

const SIGNATURE_KEY = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_VALUE = /^[A-Za-z0-9_-]{86}$/;
const KEY_ID = /^[0-9a-f]{32}$/;

function parseSignature(
  value: unknown,
  issues: CapabilityManifestIssue[],
): CapabilityManifestSignature | undefined {
  if (value === undefined) return undefined;
  const record = value as Record<string, unknown>;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    record.algorithm !== "ed25519" ||
    typeof record.keyId !== "string" ||
    !KEY_ID.test(record.keyId) ||
    typeof record.publicKey !== "string" ||
    !SIGNATURE_KEY.test(record.publicKey) ||
    typeof record.intentDigest !== "string" ||
    !DIGEST.test(record.intentDigest) ||
    typeof record.value !== "string" ||
    !SIGNATURE_VALUE.test(record.value)
  ) {
    issues.push({ path: "$.signature", message: "The signature is malformed." });
    return undefined;
  }
  return {
    algorithm: "ed25519",
    keyId: record.keyId,
    publicKey: record.publicKey,
    intentDigest: record.intentDigest,
    value: record.value,
  };
}

/**
 * The text a lockfile signature covers: the lockfile as written, without the
 * signature's `value`, as canonical JSON. The signature block's key and the
 * intent digest are inside it, so neither can be swapped.
 */
export function capabilityLockSigningPayload(document: Record<string, unknown>): string {
  const signature = document.signature;
  const { value: _value, ...signed } =
    signature !== null && typeof signature === "object" && !Array.isArray(signature)
      ? (signature as Record<string, unknown>)
      : {};
  return canonicalCapabilityJson({ ...document, signature: signed });
}

/** The lock entry key: one package at one exact revision. */
export function capabilityLockEntryKey(packageId: string, artifactDigest: string): string {
  return `${packageId}\u0000${artifactDigest}`;
}

/**
 * Validates a parsed lockfile (format 1 or 2) and checks it against the intent
 * it should resolve. Format 1 is read into the format 2 shape: every setup
 * reference names the single locked revision of its package.
 */
export function validateCapabilityLockfile(
  value: unknown,
  intent?: CapabilityIntent | null,
): {
  lock: CapabilityLockfile | null;
  issues: CapabilityManifestIssue[];
  /** The canonical text the signature covers, when the lockfile is signed. */
  signedPayload?: string;
} {
  const issues: CapabilityManifestIssue[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { lock: null, issues: [{ path: "$", message: "The lockfile must be an object." }] };
  }
  const record = value as Record<string, unknown>;
  const formatVersion: CapabilityLockFormatVersion = record.formatVersion === 2 ? 2 : 1;
  if (!(CAPABILITY_LOCK_FORMAT_VERSIONS as readonly unknown[]).includes(record.formatVersion)) {
    issues.push({
      path: "$.formatVersion",
      message: `Expected format version ${CAPABILITY_LOCK_FORMAT_VERSIONS.join(" or ")}.`,
    });
  }
  // The signature block is public data with a strict shape, checked below.
  const { signature: rawSignature, ...unsigned } = record;
  scanValues(unsigned, "$", issues, false);
  const signature = parseSignature(rawSignature, issues);
  if (signature && formatVersion !== 2) {
    issues.push({ path: "$.signature", message: "Signed lockfiles use format version 2." });
  }
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
  const byKey = new Map<string, CapabilityLockPackage>();
  const byId = new Map<string, CapabilityLockPackage[]>();
  for (const pkg of packages) {
    const key = capabilityLockEntryKey(pkg.id, pkg.artifactDigest);
    if (byKey.has(key)) {
      issues.push({ path: "$.packages", message: "The lockfile repeats a package revision." });
      continue;
    }
    byKey.set(key, pkg);
    byId.set(pkg.id, [...(byId.get(pkg.id) ?? []), pkg]);
  }
  if (formatVersion === 1 && [...byId.values()].some((entries) => entries.length > 1)) {
    issues.push({
      path: "$.packages",
      message:
        "The lockfile repeats a package identity; format version 1 holds one revision per package.",
    });
  }
  const setups: CapabilityLockfile["setups"] = {};
  if (record.setups && typeof record.setups === "object" && !Array.isArray(record.setups)) {
    for (const [name, entry] of Object.entries(record.setups as Record<string, unknown>).slice(
      0,
      CAPABILITY_LIMITS.maxSetups,
    )) {
      const raw = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const refs: CapabilityLockSetupRef[] = [];
      if (formatVersion === 2) {
        for (const ref of Array.isArray(raw.packages) ? raw.packages : []) {
          const item = ref as Record<string, unknown> | null;
          if (
            !item ||
            typeof item !== "object" ||
            typeof item.id !== "string" ||
            typeof item.artifactDigest !== "string"
          ) {
            issues.push({ path: `$.setups.${name}`, message: "Expected {id, artifactDigest}." });
            continue;
          }
          if (!byKey.has(capabilityLockEntryKey(item.id, item.artifactDigest))) {
            issues.push({
              path: `$.setups.${name}`,
              message: `${item.id} at ${item.artifactDigest.slice(0, 19)} is not in the lockfile.`,
            });
            continue;
          }
          refs.push({ packageId: item.id, artifactDigest: item.artifactDigest });
        }
      } else {
        for (const id of Array.isArray(raw.packageIds) ? raw.packageIds : []) {
          if (typeof id !== "string") continue;
          const locked = byId.get(id)?.[0];
          if (locked) refs.push({ packageId: id, artifactDigest: locked.artifactDigest });
        }
      }
      if (new Set(refs.map((ref) => ref.packageId)).size !== refs.length) {
        issues.push({
          path: `$.setups.${name}`,
          message: "A setup selects one revision of each package.",
        });
      }
      setups[name] = { packageIds: refs.map((ref) => ref.packageId), packages: refs };
    }
  }
  if (intent) {
    for (const [name, setup] of Object.entries(intent.setups)) {
      const locked = setups[name];
      if (!locked) {
        issues.push({ path: `$.setups.${name}`, message: "Missing from the lockfile." });
      }
      for (const pkg of setup.packages) {
        const id = capabilityPackageId(pkg.source);
        const ref = locked?.packages.find((entry) => entry.packageId === id);
        const entry = ref
          ? byKey.get(capabilityLockEntryKey(ref.packageId, ref.artifactDigest))
          : formatVersion === 1
            ? byId.get(id)?.[0]
            : undefined;
        if (!entry) {
          issues.push({
            path: `$.setups.${name}`,
            message: `${id} is in the manifest but not in the lockfile.`,
          });
        } else if (
          pkg.revision &&
          pkg.revision !== entry.revision &&
          pkg.revision !== entry.artifactDigest
        ) {
          issues.push({
            path: `$.setups.${name}`,
            message: "The selected revision differs from the lockfile.",
          });
        }
      }
    }
  }
  return {
    lock: {
      formatVersion,
      generatedBy:
        typeof record.generatedBy === "string" ? record.generatedBy.slice(0, 200) : "unknown",
      packages,
      setups,
      ...(signature ? { signature } : {}),
    },
    issues,
    ...(signature ? { signedPayload: capabilityLockSigningPayload(record) } : {}),
  };
}

/**
 * The lockfile as written. Format 1 is kept whenever it can express the
 * lockfile (one revision per package, unsigned) so installations that read
 * only format 1 can still import it; otherwise format 2.
 */
export function capabilityLockfileDocument(lock: CapabilityLockfile): Record<string, unknown> {
  const ids = lock.packages.map((entry) => entry.id);
  const needsV2 = lock.signature !== undefined || new Set(ids).size !== ids.length;
  const packages = lock.packages.map(({ id, source, revision, artifactDigest, components }) => ({
    id,
    source,
    revision,
    artifactDigest,
    components,
  }));
  if (!needsV2) {
    return {
      formatVersion: 1,
      generatedBy: lock.generatedBy,
      packages,
      setups: Object.fromEntries(
        Object.entries(lock.setups).map(([name, setup]) => [
          name,
          { packageIds: setup.packages.map((ref) => ref.packageId) },
        ]),
      ),
    };
  }
  return {
    formatVersion: 2,
    generatedBy: lock.generatedBy,
    packages,
    setups: Object.fromEntries(
      Object.entries(lock.setups).map(([name, setup]) => [
        name,
        {
          packages: setup.packages.map((ref) => ({
            id: ref.packageId,
            artifactDigest: ref.artifactDigest,
          })),
        },
      ]),
    ),
    ...(lock.signature ? { signature: lock.signature } : {}),
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
