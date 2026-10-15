/**
 * Release requirements manifest: what a version needs from the machine it
 * runs on (OS permissions, egress hosts, provider binaries, storage
 * migrations, container capabilities, compatible peers), and the diff a user
 * approves before an update installs it.
 *
 * Generated per release by `scripts/release-requirements.ts`, shipped as a
 * release asset and inside the app and npm package. Browser-safe: hashing and
 * signature checks use WebCrypto. Design:
 * docs/architecture/release-channels-and-updates.md.
 */
import {
  assertReleaseChannelVersion,
  compareReleaseVersions,
  isReleaseChannel,
  parseSemver,
  type ReleaseChannel,
} from "./release-channels.js";

export const RELEASE_REQUIREMENTS_SCHEMA = "orkestrator-release-requirements";
export const RELEASE_REQUIREMENTS_SCHEMA_VERSION = 1;
export const RELEASE_REQUIREMENTS_ASSET = "release-requirements.json";
export const RELEASE_REQUIREMENTS_SIGNATURE_ASSET = "release-requirements.json.sig";
export const MAX_RELEASE_REQUIREMENTS_BYTES = 512 * 1024;
/** Version of the `update_*` commands and the `/status` handshake. */
export const UPDATE_PROTOCOL_VERSION = 1;

export type ReleaseMacOsPermission = {
  id: string;
  label: string;
  settingsPane: string;
  /** Info.plist usage-description key, when macOS shows one in its prompt. */
  infoPlistKey: string | null;
  usage: string | null;
  requirement: "required" | "recommended";
};

/**
 * A host the version contacts: `toolchain` and `updates` from the machine
 * itself, `container-default` through the container firewall's default
 * allowlist. Adding one relaxes egress, so it needs consent.
 */
export type ReleaseEgressHost = { host: string; purposes: string[] };

/** A pinned toolchain artifact; the installer validates the full object. */
export type ReleaseToolchainArtifact = {
  name: string;
  version: string;
  platform: string;
  architecture: string;
  [key: string]: unknown;
};

export type ReleaseRequirements = {
  schema: typeof RELEASE_REQUIREMENTS_SCHEMA;
  schemaVersion: typeof RELEASE_REQUIREMENTS_SCHEMA_VERSION;
  version: string;
  channel: ReleaseChannel;
  commit: string;
  compatibility: {
    updateProtocol: number;
    /** Oldest renderer or desktop client that may drive this backend. */
    minClientVersion: string;
    /** Oldest backend this version's client supports. */
    minBackendVersion: string;
  };
  storage: {
    /** Highest `PRAGMA user_version` this build writes. */
    schemaVersion: number;
    migrations: Array<{ version: number; name: string; reversible: boolean }>;
  };
  permissions: { macos: ReleaseMacOsPermission[] };
  network: { egressHosts: ReleaseEgressHost[] };
  toolchain: { versions: Record<string, string>; artifacts: ReleaseToolchainArtifact[] };
  container: {
    image: string;
    tag: string;
    requiredImageCapabilities: Record<string, number>;
    imageCapabilities: Record<string, number>;
  };
};

export class ReleaseRequirementsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseRequirementsError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new ReleaseRequirementsError(`${path} ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, "must be an object");
  return value;
}

function string(value: unknown, path: string, max = 2048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail(path, `must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function nullableString(value: unknown, path: string, max = 2048): string | null {
  return value === null ? null : string(value, path, max);
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "must be a non-negative integer");
  }
  return value;
}

function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, `must be an array of at most ${max}`);
  return value;
}

function semver(value: unknown, path: string): string {
  const text = string(value, path, 256);
  if (!parseSemver(text)) fail(path, "must be a semver version");
  return text;
}

const KEY = /^[a-z][a-z0-9-]{0,63}$/;
const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function key(value: unknown, path: string): string {
  const text = string(value, path, 64);
  if (!KEY.test(text)) fail(path, "must be a lowercase identifier");
  return text;
}

function capabilityMap(value: unknown, path: string): Record<string, number> {
  const source = record(value, path);
  const entries = Object.entries(source);
  if (entries.length > 64) fail(path, "has too many entries");
  return Object.fromEntries(
    entries.map(([name, version]) => [
      key(name, `${path} key`),
      integer(version, `${path}.${name}`),
    ]),
  );
}

function stringMap(value: unknown, path: string): Record<string, string> {
  const source = record(value, path);
  const entries = Object.entries(source);
  if (entries.length > 64) fail(path, "has too many entries");
  return Object.fromEntries(
    entries.map(([name, version]) => [
      key(name, `${path} key`),
      string(version, `${path}.${name}`, 128),
    ]),
  );
}

/** Validates an untrusted manifest. Throws {@link ReleaseRequirementsError}. */
export function parseReleaseRequirements(value: unknown): ReleaseRequirements {
  const root = record(value, "manifest");
  if (root.schema !== RELEASE_REQUIREMENTS_SCHEMA) fail("schema", "is not a requirements manifest");
  if (root.schemaVersion !== RELEASE_REQUIREMENTS_SCHEMA_VERSION) {
    fail("schemaVersion", `${String(root.schemaVersion)} is not supported`);
  }
  const version = semver(root.version, "version");
  if (!isReleaseChannel(root.channel)) fail("channel", "is not a release channel");
  let channel: ReleaseChannel;
  try {
    channel = assertReleaseChannelVersion(version);
  } catch {
    fail("version", "is not a release channel version");
  }
  if (channel !== root.channel) fail("channel", "does not match the version");
  const commit = string(root.commit, "commit", 40);
  if (!/^[0-9a-f]{40}$/.test(commit)) fail("commit", "must be a full commit id");

  const compatibility = record(root.compatibility, "compatibility");
  const storage = record(root.storage, "storage");
  const permissions = record(root.permissions, "permissions");
  const network = record(root.network, "network");
  const toolchain = record(root.toolchain, "toolchain");
  const container = record(root.container, "container");

  return {
    schema: RELEASE_REQUIREMENTS_SCHEMA,
    schemaVersion: RELEASE_REQUIREMENTS_SCHEMA_VERSION,
    version,
    channel,
    commit,
    compatibility: {
      updateProtocol: integer(compatibility.updateProtocol, "compatibility.updateProtocol"),
      minClientVersion: semver(compatibility.minClientVersion, "compatibility.minClientVersion"),
      minBackendVersion: semver(compatibility.minBackendVersion, "compatibility.minBackendVersion"),
    },
    storage: {
      schemaVersion: integer(storage.schemaVersion, "storage.schemaVersion"),
      migrations: list(storage.migrations, "storage.migrations", 1024).map((entry, index) => {
        const migration = record(entry, `storage.migrations[${index}]`);
        if (typeof migration.reversible !== "boolean") {
          fail(`storage.migrations[${index}].reversible`, "must be a boolean");
        }
        return {
          version: integer(migration.version, `storage.migrations[${index}].version`),
          name: string(migration.name, `storage.migrations[${index}].name`, 128),
          reversible: migration.reversible,
        };
      }),
    },
    permissions: {
      macos: list(permissions.macos, "permissions.macos", 64).map((entry, index) => {
        const path = `permissions.macos[${index}]`;
        const permission = record(entry, path);
        if (permission.requirement !== "required" && permission.requirement !== "recommended") {
          fail(`${path}.requirement`, "must be required or recommended");
        }
        return {
          id: key(permission.id, `${path}.id`),
          label: string(permission.label, `${path}.label`, 128),
          settingsPane: key(permission.settingsPane, `${path}.settingsPane`),
          infoPlistKey: nullableString(permission.infoPlistKey, `${path}.infoPlistKey`, 128),
          usage: nullableString(permission.usage, `${path}.usage`),
          requirement: permission.requirement,
        };
      }),
    },
    network: {
      egressHosts: list(network.egressHosts, "network.egressHosts", 512).map((entry, index) => {
        const path = `network.egressHosts[${index}]`;
        const host = record(entry, path);
        const name = string(host.host, `${path}.host`, 253);
        if (!HOST.test(name)) fail(`${path}.host`, "must be a lowercase DNS name");
        return {
          host: name,
          purposes: list(host.purposes, `${path}.purposes`, 16).map((purpose, purposeIndex) =>
            key(purpose, `${path}.purposes[${purposeIndex}]`),
          ),
        };
      }),
    },
    toolchain: {
      versions: stringMap(toolchain.versions, "toolchain.versions"),
      artifacts: list(toolchain.artifacts, "toolchain.artifacts", 512).map((entry, index) => {
        const path = `toolchain.artifacts[${index}]`;
        const artifact = record(entry, path);
        return {
          ...artifact,
          name: key(artifact.name, `${path}.name`),
          version: string(artifact.version, `${path}.version`, 128),
          platform: key(artifact.platform, `${path}.platform`),
          architecture: key(artifact.architecture, `${path}.architecture`),
        };
      }),
    },
    container: {
      image: string(container.image, "container.image", 256),
      tag: string(container.tag, "container.tag", 128),
      requiredImageCapabilities: capabilityMap(
        container.requiredImageCapabilities,
        "container.requiredImageCapabilities",
      ),
      imageCapabilities: capabilityMap(container.imageCapabilities, "container.imageCapabilities"),
    },
  };
}

/** Parses manifest bytes, refusing anything larger than the bound first. */
export function parseReleaseRequirementsBytes(bytes: Uint8Array): ReleaseRequirements {
  if (bytes.byteLength > MAX_RELEASE_REQUIREMENTS_BYTES) {
    throw new ReleaseRequirementsError("The requirements manifest is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ReleaseRequirementsError("The requirements manifest is not valid JSON");
  }
  return parseReleaseRequirements(value);
}

/**
 * Deterministic serialization: object keys sorted at every level, two-space
 * indentation, trailing newline. Every build machine produces the same bytes,
 * so the published checksum can be recomputed from the tagged tree.
 */
export function serializeReleaseRequirements(manifest: ReleaseRequirements): string {
  return `${JSON.stringify(
    manifest,
    (_key, value: unknown) =>
      isRecord(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((name) => [name, value[name]]),
          )
        : value,
    2,
  )}\n`;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(value: string): Uint8Array | null {
  const text = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  try {
    return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Verifies an Ed25519 detached signature (base64) over the exact manifest
 * bytes against any of the trusted raw public keys (base64, 32 bytes).
 */
export async function verifyReleaseRequirementsSignature(
  bytes: Uint8Array,
  signatureBase64: string,
  publicKeysBase64: readonly string[],
): Promise<boolean> {
  const signature = decodeBase64(signatureBase64);
  if (!signature || signature.byteLength !== 64) return false;
  for (const encoded of publicKeysBase64) {
    const raw = decodeBase64(encoded);
    if (!raw || raw.byteLength !== 32) continue;
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        raw as BufferSource,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      if (
        await crypto.subtle.verify("Ed25519", key, signature as BufferSource, bytes as BufferSource)
      ) {
        return true;
      }
    } catch {
      // A key this runtime cannot import never verifies anything.
    }
  }
  return false;
}

export type ReleaseRequirementCategory =
  | "macos-permission"
  | "network-egress"
  | "provider-binary"
  | "storage-migration"
  | "container-capability"
  | "compatibility";

export type ReleaseRequirementItem = {
  /** Stable `category:key`, the unit of consent. */
  id: string;
  category: ReleaseRequirementCategory;
  /** `required` lists a need when there is no baseline to compare with. */
  change: "added" | "changed" | "removed" | "required";
  title: string;
  detail: string;
  /** The user must approve it before the update installs. */
  consent: boolean;
  /** Someone has to act at the updated machine itself (an OS prompt, a rebuild). */
  actionOnHost: boolean;
  /** The update cannot proceed until this is resolved elsewhere. */
  blocking: boolean;
};

export type ReleaseRequirementsDiff = {
  fromVersion: string | null;
  toVersion: string;
  /** `none` when the running version predates manifests (2.20.x and earlier). */
  baseline: "manifest" | "none";
  items: ReleaseRequirementItem[];
};

export type ReleaseRequirementsDiffContext = {
  /** The running version, used when there is no baseline manifest. */
  currentVersion?: string | null;
  /** Host OS; macOS permission items only apply to `darwin`. Unknown includes them. */
  platform?: string | null;
  /** The requesting client's version; unknown skips the compatibility check. */
  clientVersion?: string | null;
  /** The database's actual `user_version`, more precise than the baseline. */
  storageSchemaVersion?: number | null;
  /**
   * The local default image: `null` means Docker or the image is absent (no
   * container work to protect), `undefined` means not inspected.
   */
  localImage?: { capabilities: Record<string, number>; source: "published" | "local" } | null;
};

type ItemInput = Omit<ReleaseRequirementItem, "id" | "blocking"> & {
  key: string;
  blocking?: boolean;
};

function item(input: ItemInput): ReleaseRequirementItem {
  const { key: itemKey, ...rest } = input;
  return { id: `${input.category}:${itemKey}`, blocking: false, ...rest };
}

function diffMacOsPermissions(
  current: ReleaseRequirements | null,
  target: ReleaseRequirements,
): ReleaseRequirementItem[] {
  const items: ReleaseRequirementItem[] = [];
  const before = new Map((current?.permissions.macos ?? []).map((entry) => [entry.id, entry]));
  for (const permission of target.permissions.macos) {
    const previous = before.get(permission.id);
    const prompt = permission.usage ? ` macOS will show: “${permission.usage}”` : "";
    if (!current) {
      items.push(
        item({
          category: "macos-permission",
          key: permission.id,
          change: "required",
          title: `${permission.label} access (${permission.requirement})`,
          detail: `Granted in System Settings › Privacy & Security on that Mac.${prompt}`,
          consent: permission.requirement === "required",
          actionOnHost: permission.requirement === "required",
        }),
      );
    } else if (!previous) {
      items.push(
        item({
          category: "macos-permission",
          key: permission.id,
          change: "added",
          title: `New: ${permission.label} access (${permission.requirement})`,
          detail: `Someone at that Mac must approve the macOS prompt after updating.${prompt}`,
          consent: true,
          actionOnHost: true,
        }),
      );
    } else if (previous.requirement === "recommended" && permission.requirement === "required") {
      items.push(
        item({
          category: "macos-permission",
          key: permission.id,
          change: "changed",
          title: `${permission.label} access becomes required`,
          detail: `The app will not start work until it is granted on that Mac.${prompt}`,
          consent: true,
          actionOnHost: true,
        }),
      );
    } else if (previous.usage !== permission.usage) {
      items.push(
        item({
          category: "macos-permission",
          key: permission.id,
          change: "changed",
          title: `${permission.label} access: new explanation`,
          detail: permission.usage ?? "The usage description was removed.",
          consent: false,
          actionOnHost: false,
        }),
      );
    }
    before.delete(permission.id);
  }
  for (const removed of before.values()) {
    items.push(
      item({
        category: "macos-permission",
        key: removed.id,
        change: "removed",
        title: `${removed.label} access is no longer requested`,
        detail: "Any existing grant can be revoked in System Settings.",
        consent: false,
        actionOnHost: false,
      }),
    );
  }
  return items;
}

function diffEgress(
  current: ReleaseRequirements | null,
  target: ReleaseRequirements,
): ReleaseRequirementItem[] {
  const items: ReleaseRequirementItem[] = [];
  const before = new Set((current?.network.egressHosts ?? []).map((entry) => entry.host));
  for (const host of target.network.egressHosts) {
    if (before.delete(host.host)) continue;
    items.push(
      item({
        category: "network-egress",
        key: host.host,
        change: current ? "added" : "required",
        title: `${current ? "New network host" : "Network host"}: ${host.host}`,
        detail: `Used for ${host.purposes.join(", ") || "app traffic"}. Allow it if outbound traffic is filtered.`,
        consent: true,
        actionOnHost: false,
      }),
    );
  }
  for (const host of before) {
    items.push(
      item({
        category: "network-egress",
        key: host,
        change: "removed",
        title: `No longer contacts ${host}`,
        detail: "It can be removed from outbound allowlists.",
        consent: false,
        actionOnHost: false,
      }),
    );
  }
  return items;
}

function diffProviders(
  current: ReleaseRequirements | null,
  target: ReleaseRequirements,
): ReleaseRequirementItem[] {
  const items: ReleaseRequirementItem[] = [];
  const before = new Map(Object.entries(current?.toolchain.versions ?? {}));
  for (const [name, version] of Object.entries(target.toolchain.versions).sort()) {
    const previous = before.get(name);
    before.delete(name);
    if (previous === version) continue;
    if (previous === undefined) {
      items.push(
        item({
          category: "provider-binary",
          key: name,
          change: current ? "added" : "required",
          title: `${current ? "New provider binary" : "Provider binary"}: ${name} ${version}`,
          detail:
            "Downloaded from its pinned source and verified against a pinned SHA-256 before restarting.",
          consent: current !== null,
          actionOnHost: false,
        }),
      );
    } else {
      items.push(
        item({
          category: "provider-binary",
          key: name,
          change: "changed",
          title: `${name} ${previous} → ${version}`,
          detail: "Downloaded and verified against its pinned SHA-256 before restarting.",
          consent: false,
          actionOnHost: false,
        }),
      );
    }
  }
  for (const [name, version] of before) {
    items.push(
      item({
        category: "provider-binary",
        key: name,
        change: "removed",
        title: `${name} ${version} is no longer shipped`,
        detail: "Its installed copy is kept until the toolchain cleanup removes it.",
        consent: false,
        actionOnHost: false,
      }),
    );
  }
  return items;
}

function diffStorage(
  current: ReleaseRequirements | null,
  target: ReleaseRequirements,
  context: ReleaseRequirementsDiffContext,
): ReleaseRequirementItem[] {
  const known = context.storageSchemaVersion ?? current?.storage.schemaVersion ?? null;
  const to = target.storage.schemaVersion;
  if (known !== null && known > to) {
    return [
      item({
        category: "storage-migration",
        key: `floor-${to}`,
        change: "changed",
        title: `${target.version} cannot open this machine's data`,
        detail: `The data is at schema version ${known}; ${target.version} reads up to ${to}. Installing it would leave the app unable to start.`,
        consent: false,
        actionOnHost: false,
        blocking: true,
      }),
    ];
  }
  if (known !== null && known === to) return [];
  const added = target.storage.migrations
    .filter((migration) => known === null || migration.version > known)
    .map((migration) => migration.name);
  return [
    item({
      category: "storage-migration",
      key: `schema-${to}`,
      change: known === null ? "required" : "changed",
      title:
        known === null
          ? `Stored data is upgraded to schema version ${to} if older`
          : `Stored data is upgraded from schema version ${known} to ${to}`,
      detail:
        `${added.length > 0 ? `Migrations: ${added.join(", ")}. ` : ""}` +
        "This is one-way: a snapshot is taken first, and rolling back restores it, " +
        "discarding changes made after the update.",
      consent: true,
      actionOnHost: false,
    }),
  ];
}

function diffContainer(
  current: ReleaseRequirements | null,
  target: ReleaseRequirements,
  context: ReleaseRequirementsDiffContext,
): ReleaseRequirementItem[] {
  if (context.localImage === null) return [];
  const items: ReleaseRequirementItem[] = [];
  for (const [capability, version] of Object.entries(target.container.requiredImageCapabilities)) {
    const have =
      context.localImage !== undefined
        ? (context.localImage.capabilities[capability] ?? 0)
        : (current?.container.requiredImageCapabilities[capability] ?? 0);
    if (have >= version) continue;
    const published = context.localImage?.source === "published";
    items.push(
      item({
        category: "container-capability",
        key: capability,
        change: current || context.localImage ? "added" : "required",
        title: `Container image needs ${capability} v${version}`,
        detail: published
          ? `The published image ${target.container.image}:${target.container.tag} is pulled and verified before restarting.`
          : "The local container image does not provide it; rebuild it (mise run docker:build) or pull the published image.",
        consent: true,
        actionOnHost: context.localImage !== undefined && !published,
      }),
    );
  }
  return items;
}

function diffCompatibility(
  target: ReleaseRequirements,
  context: ReleaseRequirementsDiffContext,
): ReleaseRequirementItem[] {
  const client = context.clientVersion ? parseSemver(context.clientVersion) : null;
  if (!client) return [];
  if (compareReleaseVersions(context.clientVersion!, target.compatibility.minClientVersion) >= 0) {
    return [];
  }
  return [
    item({
      category: "compatibility",
      key: "client",
      change: "changed",
      title: `Update this app first (needs ${target.compatibility.minClientVersion} or later)`,
      detail: `${target.version} cannot be driven by a ${context.clientVersion} client. Update this app, then update the remote.`,
      consent: false,
      actionOnHost: false,
      blocking: true,
    }),
  ];
}

/**
 * What changes between the running version's requirements (`null` when it
 * predates manifests) and the target's, in a stable order: blockers first,
 * then consent items, then informational ones.
 */
export function diffReleaseRequirements(
  current: ReleaseRequirements | null,
  target: ReleaseRequirements,
  context: ReleaseRequirementsDiffContext = {},
): ReleaseRequirementsDiff {
  const includeMacOs = context.platform == null || context.platform === "darwin";
  const items = [
    ...diffCompatibility(target, context),
    ...diffStorage(current, target, context),
    ...(includeMacOs ? diffMacOsPermissions(current, target) : []),
    ...diffEgress(current, target),
    ...diffProviders(current, target),
    ...diffContainer(current, target, context),
  ];
  const rank = (entry: ReleaseRequirementItem) => (entry.blocking ? 0 : entry.consent ? 1 : 2);
  items.sort((left, right) => rank(left) - rank(right));
  return {
    fromVersion: current?.version ?? context.currentVersion ?? null,
    toVersion: target.version,
    baseline: current ? "manifest" : "none",
    items,
  };
}

export function requiredConsentIds(diff: ReleaseRequirementsDiff): string[] {
  return diff.items.filter((entry) => entry.consent && !entry.blocking).map((entry) => entry.id);
}

export type ConsentCheck =
  | { ok: true }
  | { ok: false; reason: "blocked"; blockers: string[] }
  | { ok: false; reason: "missing-consent"; missing: string[] };

/** Every blocker refuses; every consent item must be in the approved set. */
export function checkConsent(
  diff: ReleaseRequirementsDiff,
  approvedConsentIds: readonly string[],
): ConsentCheck {
  const blockers = diff.items.filter((entry) => entry.blocking).map((entry) => entry.id);
  if (blockers.length > 0) return { ok: false, reason: "blocked", blockers };
  const approved = new Set(approvedConsentIds);
  const missing = requiredConsentIds(diff).filter((id) => !approved.has(id));
  return missing.length > 0 ? { ok: false, reason: "missing-consent", missing } : { ok: true };
}

/** Items someone must act on at the updated machine, shown after the update. */
export function actionsOnHost(diff: ReleaseRequirementsDiff): ReleaseRequirementItem[] {
  return diff.items.filter((entry) => entry.actionOnHost);
}
