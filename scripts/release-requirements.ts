#!/usr/bin/env bun
/**
 * Generate, verify and sign a release's requirements manifest.
 *
 *   bun scripts/release-requirements.ts generate --out <file> [--commit <sha>]
 *   bun scripts/release-requirements.ts verify --file <file> [--signature <file.sig>] [--commit <sha>]
 *   bun scripts/release-requirements.ts sign --file <file> --out <file.sig>
 *   bun scripts/release-requirements.ts public-key
 *
 * Every section is read from the code that owns the fact (storage migrations,
 * macOS permission probes, toolchain pins, container contract), so the
 * manifest cannot drift from what the build does. Generation reads no clock
 * and no host state: two machines at the same commit write identical bytes,
 * which is what lets `release:publish` re-derive the published checksum.
 *
 * Signing uses ORKESTRATOR_RELEASE_SIGNING_KEY (an Ed25519 PKCS#8 PEM). See
 * docs/architecture/release-channels-and-updates.md.
 */
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MACOS_PERMISSION_CATALOGUE,
  MACOS_PERMISSION_IDS,
} from "../packages/protocol/src/macos-permissions";
import {
  assertReleaseChannelVersion,
  CONTAINER_IMAGE_REPOSITORY,
  compareReleaseVersions,
} from "../packages/protocol/src/release-channels";
import {
  parseReleaseRequirements,
  serializeReleaseRequirements,
  sha256Hex,
  UPDATE_PROTOCOL_VERSION,
  verifyReleaseRequirementsSignature,
  type ReleaseEgressHost,
  type ReleaseRequirements,
} from "../packages/protocol/src/release-requirements";
import { RELEASE_SIGNING_PUBLIC_KEYS } from "../packages/protocol/src/release-signing-keys";

const root = path.resolve(import.meta.dir, "..");

export type ReleaseRequirementsConfig = {
  compatibility: { minClientVersion: string; minBackendVersion: string };
  egressHosts: ReleaseEgressHost[];
};

export type ReleaseRequirementSources = {
  version: string;
  commit: string;
  config: ReleaseRequirementsConfig;
  /** `build.mac.extendInfo` from the root package.json. */
  extendInfo: Record<string, string>;
  storageMigrations: ReadonlyArray<{ version: number; name: string }>;
  toolVersions: Readonly<Record<string, string>>;
  artifacts: ReadonlyArray<{
    name: string;
    version: string;
    platform: string;
    architecture: string;
    archive: { allowedHosts: readonly string[] };
  }>;
  requiredImageCapabilities: Readonly<Record<string, number>>;
  imageCapabilities: Readonly<Record<string, number>>;
  containerDefaultDomains: readonly string[];
};

function mergeEgressHosts(
  groups: Array<[string, readonly string[]]>,
  declared: ReleaseEgressHost[],
) {
  const purposes = new Map<string, Set<string>>();
  const add = (host: string, purpose: string) => {
    const normalized = host.trim().toLowerCase();
    const set = purposes.get(normalized) ?? new Set<string>();
    set.add(purpose);
    purposes.set(normalized, set);
  };
  for (const [purpose, hosts] of groups) for (const host of hosts) add(host, purpose);
  for (const entry of declared) for (const purpose of entry.purposes) add(entry.host, purpose);
  return [...purposes.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([host, set]) => ({ host, purposes: [...set].sort() }));
}

function macOsPermissions(extendInfo: Record<string, string>) {
  const referenced = new Set<string>();
  const permissions = MACOS_PERMISSION_IDS.map((id) => {
    const descriptor = MACOS_PERMISSION_CATALOGUE[id];
    let usage: string | null = null;
    if (descriptor.infoPlistKey) {
      usage = extendInfo[descriptor.infoPlistKey] ?? null;
      if (!usage) {
        throw new Error(
          `${id} prompts with ${descriptor.infoPlistKey}, which build.mac.extendInfo does not define`,
        );
      }
      referenced.add(descriptor.infoPlistKey);
    }
    return {
      id,
      label: descriptor.label,
      settingsPane: descriptor.settingsPane,
      infoPlistKey: descriptor.infoPlistKey,
      usage,
      requirement: descriptor.required ? ("required" as const) : ("recommended" as const),
    };
  });
  // A usage string nothing probes would let a new OS permission ship without
  // ever reaching the consent gate.
  const orphaned = Object.keys(extendInfo).filter(
    (key) => key.endsWith("UsageDescription") && !referenced.has(key),
  );
  if (orphaned.length > 0) {
    throw new Error(
      `build.mac.extendInfo declares ${orphaned.join(", ")} but no MACOS_PERMISSION_CATALOGUE entry uses it`,
    );
  }
  return permissions;
}

/** Pure: builds and validates the manifest from already-collected sources. */
export function buildReleaseRequirements(sources: ReleaseRequirementSources): ReleaseRequirements {
  const channel = assertReleaseChannelVersion(sources.version);
  for (const [name, floor] of Object.entries(sources.config.compatibility)) {
    if (compareReleaseVersions(floor, sources.version) > 0) {
      throw new Error(
        `compatibility.${name} ${floor} is newer than the release ${sources.version}`,
      );
    }
  }
  const storageSchemaVersion = sources.storageMigrations.reduce(
    (max, migration) => Math.max(max, migration.version),
    0,
  );
  const manifest: ReleaseRequirements = {
    schema: "orkestrator-release-requirements",
    schemaVersion: 1,
    version: sources.version,
    channel,
    commit: sources.commit,
    compatibility: {
      updateProtocol: UPDATE_PROTOCOL_VERSION,
      minClientVersion: sources.config.compatibility.minClientVersion,
      minBackendVersion: sources.config.compatibility.minBackendVersion,
    },
    storage: {
      schemaVersion: storageSchemaVersion,
      // No migration has a down step: a rollback restores the pre-migration snapshot.
      migrations: [...sources.storageMigrations]
        .sort((left, right) => left.version - right.version)
        .map(({ version, name }) => ({ version, name, reversible: false })),
    },
    permissions: { macos: macOsPermissions(sources.extendInfo) },
    network: {
      egressHosts: mergeEgressHosts(
        [
          ["toolchain", sources.artifacts.flatMap((artifact) => artifact.archive.allowedHosts)],
          ["container-default", sources.containerDefaultDomains],
        ],
        sources.config.egressHosts,
      ),
    },
    toolchain: {
      versions: Object.fromEntries(Object.entries(sources.toolVersions).sort()),
      artifacts: sources.artifacts.map((artifact) => JSON.parse(JSON.stringify(artifact))),
    },
    container: {
      image: CONTAINER_IMAGE_REPOSITORY,
      tag: sources.version,
      requiredImageCapabilities: { ...sources.requiredImageCapabilities },
      imageCapabilities: { ...sources.imageCapabilities },
    },
  };
  // The consumer's parser is the contract; a generator that writes something
  // it would refuse fails here rather than in every installed app.
  return parseReleaseRequirements(JSON.parse(serializeReleaseRequirements(manifest)));
}

function gitCommit(repositoryRoot: string): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

export async function collectReleaseRequirementSources(
  repositoryRoot = root,
  options: { commit?: string } = {},
): Promise<ReleaseRequirementSources> {
  const read = (file: string) => readFileSync(path.join(repositoryRoot, file), "utf8");
  const packageJson = JSON.parse(read("package.json")) as {
    version: string;
    build?: { mac?: { extendInfo?: Record<string, string> } };
  };
  const config = JSON.parse(read("config/release-requirements.json")) as ReleaseRequirementsConfig;
  // Imported lazily so the CLI-only paths (sign, public-key) stay cheap.
  const [
    { STORAGE_MIGRATIONS },
    { BACKEND_REQUIRED_IMAGE_CAPABILITIES },
    shared,
    toolchain,
    image,
  ] = await Promise.all([
    import("../apps/backend/src/core/storage-stores"),
    import("../apps/backend/src/core/docker-image"),
    import("../apps/backend/src/core/storage-shared-core"),
    import("../packages/toolchain/src/manifest"),
    import("../docker/image-manifest"),
  ]);
  const commit =
    options.commit ?? process.env.ORKESTRATOR_SOURCE_REVISION?.trim() ?? gitCommit(repositoryRoot);
  return {
    version: packageJson.version,
    commit,
    config,
    extendInfo: packageJson.build?.mac?.extendInfo ?? {},
    storageMigrations: STORAGE_MIGRATIONS.map(({ version, name }) => ({ version, name })),
    toolVersions: toolchain.PINNED_TOOL_VERSIONS,
    artifacts: toolchain.PINNED_TOOLCHAIN_ARTIFACTS,
    requiredImageCapabilities: BACKEND_REQUIRED_IMAGE_CAPABILITIES as Record<string, number>,
    imageCapabilities: image.probeCapabilities((file) => {
      try {
        return read(file.source);
      } catch {
        return null;
      }
    }) as Record<string, number>,
    containerDefaultDomains: shared.DEFAULT_ALLOWED_DOMAINS,
  };
}

export async function generateReleaseRequirements(
  repositoryRoot = root,
  options: { commit?: string } = {},
): Promise<{ manifest: ReleaseRequirements; text: string; sha256: string }> {
  const manifest = buildReleaseRequirements(
    await collectReleaseRequirementSources(repositoryRoot, options),
  );
  const text = serializeReleaseRequirements(manifest);
  return { manifest, text, sha256: await sha256Hex(text) };
}

export function signingKeyFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const pem = env.ORKESTRATOR_RELEASE_SIGNING_KEY?.trim();
  if (!pem) return null;
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("ORKESTRATOR_RELEASE_SIGNING_KEY must be an Ed25519 private key");
  }
  return key;
}

/** Base64 Ed25519 signature over the exact bytes, as `release-requirements.json.sig` holds. */
export function signReleaseRequirements(
  bytes: Uint8Array,
  key: ReturnType<typeof createPrivateKey>,
): string {
  return `${sign(null, bytes, key).toString("base64")}\n`;
}

/** The raw public key in the form `RELEASE_SIGNING_PUBLIC_KEYS` lists. */
export function rawPublicKeyBase64(key: ReturnType<typeof createPrivateKey>): string {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(-32)).toString("base64");
}

/**
 * Once this build embeds signing keys, a release without a valid signature is
 * refused: installs that ship those keys would refuse its manifest.
 */
export async function verifySignatureForRelease(
  bytes: Uint8Array,
  signature: string | null,
  trustedKeys: readonly string[] = RELEASE_SIGNING_PUBLIC_KEYS,
): Promise<void> {
  if (trustedKeys.length === 0) return;
  if (!signature) throw new Error("this build requires a signed requirements manifest");
  if (!(await verifyReleaseRequirementsSignature(bytes, signature, trustedKeys))) {
    throw new Error(
      "the requirements manifest signature does not verify against the embedded keys",
    );
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const commit = option(rest, "--commit");
  if (command === "generate") {
    const out = option(rest, "--out");
    if (!out) throw new Error("usage: generate --out <file> [--commit <sha>]");
    const { text, sha256, manifest } = await generateReleaseRequirements(root, { commit });
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, text);
    console.log(`release-requirements ${manifest.version} (${manifest.channel}) sha256 ${sha256}`);
  } else if (command === "verify") {
    const file = option(rest, "--file");
    const signature = option(rest, "--signature");
    if (!file)
      throw new Error("usage: verify --file <file> [--signature <file.sig>] [--commit <sha>]");
    const { text } = await generateReleaseRequirements(root, { commit });
    const bytes = readFileSync(file);
    if (bytes.toString("utf8") !== text) {
      throw new Error(`${file} does not match the manifest generated from this checkout`);
    }
    await verifySignatureForRelease(bytes, signature ? readFileSync(signature, "utf8") : null);
    console.log(`${file} matches`);
  } else if (command === "sign") {
    const file = option(rest, "--file");
    const out = option(rest, "--out");
    if (!file || !out) throw new Error("usage: sign --file <file> --out <file.sig>");
    const key = signingKeyFromEnvironment();
    if (!key) throw new Error("ORKESTRATOR_RELEASE_SIGNING_KEY is not set");
    writeFileSync(out, signReleaseRequirements(readFileSync(file), key));
  } else if (command === "public-key") {
    const key = signingKeyFromEnvironment();
    if (!key) throw new Error("ORKESTRATOR_RELEASE_SIGNING_KEY is not set");
    console.log(rawPublicKeyBase64(key));
  } else {
    throw new Error("usage: release-requirements.ts generate | verify | sign | public-key");
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `release-requirements: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
