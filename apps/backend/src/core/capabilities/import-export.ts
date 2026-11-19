/**
 * Portable setups (docs/architecture/agent-capabilities-management.md,
 * "Portable manifests and lockfiles").
 *
 * Export writes the human-editable intent (YAML) and the resolved lockfile
 * (JSON). Machine selections, sessions, environments and accounts are private
 * and are left out; so is every local-only package, with a note. Import
 * validates both files (no secrets, no host paths), previews what would be
 * created or changed, and only then creates setups and packages; the
 * packages are fetched at the exact locked revision and refused if their
 * digest differs from the lockfile's.
 *
 * Lockfile format 2 locks a package once per revision and lets each setup
 * name the exact entry it uses, so setups pinned to different revisions of
 * one package export together and import back to the same pinned graph.
 * Format 1 is written whenever it suffices (one revision per package,
 * unsigned) so older installations can still read it.
 */
import {
  capabilityRevisionComponents,
  revisionDigest,
} from "@orkestrator/protocol/capability-resources-resolve";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  MY_SETUP_ID,
  capabilityPackageId,
  type CapabilityComponent,
  type CapabilityPackage,
  type CapabilityPackageSelection,
  type CapabilityProvenance,
  type CapabilitySetup,
} from "@orkestrator/protocol/capability-resources";
import {
  CAPABILITY_INTENT_FILE,
  CAPABILITY_LOCK_FILE,
  CAPABILITY_MANIFEST_VERSION,
  capabilityLockEntryKey,
  capabilityLockfileDocument,
  isPortableCapabilitySelector,
  validateCapabilityIntent,
  validateCapabilityLockfile,
  type CapabilityIntent,
  type CapabilityIntentSetup,
  type CapabilityLockPackage,
  type CapabilityLockSetupRef,
  type CapabilityLockfile,
  type CapabilityManifestIssue,
} from "@orkestrator/protocol/capability-resources-manifest";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { graphSharingFingerprint } from "@orkestrator/protocol/graphs/sharing";

import { signCapabilityLockfile } from "./manifest-signing.js";
import { CapabilityError, writeFileAtomically } from "./security.js";
import type { InspectedPackage } from "./source-inspection.js";
import type { CapabilityState } from "./types.js";

export function setupSlug(setup: Pick<CapabilitySetup, "id" | "name">): string {
  if (setup.id === MY_SETUP_ID) return MY_SETUP_ID;
  const slug = setup.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return (
    slug ||
    setup.id
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 64) ||
    "toolkit"
  );
}

export interface ExportResult {
  intent: CapabilityIntent;
  lock: CapabilityLockfile;
  intentText: string;
  lockText: string;
  /** The lockfile format written: 1 when it suffices, 2 for mixed revisions or a signature. */
  formatVersion: 1 | 2;
  /** The key that signed the lockfile. */
  signed?: { keyId: string; fingerprint: string };
  notes: string[];
}

/** Lock entries of one package: the library's current revision first, then older ones, newest first. */
function revisionRank(pkg: CapabilityPackage, digest: string): number {
  if (digest === pkg.artifactDigest) return 0;
  const index = pkg.previousRevisions?.findIndex((entry) => entry.artifactDigest === digest) ?? -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index + 1;
}

/**
 * Builds the two portable files for `setupIds`. With `signingKey`, the
 * lockfile is signed (format 2) with this installation's sharing key.
 */
export function exportSetups(
  state: CapabilityState,
  setupIds: readonly string[],
  options: { signingKey?: { publicKey: string; privateKey: string; keyId: string } } = {},
): ExportResult {
  const notes: string[] = [];
  const intent: CapabilityIntent = { version: 1, setups: {} };
  let lock: CapabilityLockfile = {
    formatVersion: 1,
    generatedBy: "Orkestrator",
    packages: [],
    setups: {},
  };
  const locked = new Set<string>();
  const catalogue = new Map(Object.entries(state.components));
  const slugs = new Map<string, string>();
  for (const id of setupIds) {
    const setup = state.setups[id];
    if (setup) slugs.set(id, setupSlug(setup));
  }
  for (const id of setupIds) {
    const setup = state.setups[id];
    if (!setup) throw new CapabilityError("not-found", `Setup ${id} does not exist.`);
    const slug = slugs.get(id)!;
    const packages: CapabilityIntentSetup["packages"] = [];
    const refs: CapabilityLockSetupRef[] = [];
    for (const selection of setup.packageSelections) {
      const pkg = state.packages[selection.packageId];
      if (!pkg) continue;
      if (pkg.source.kind === "local") {
        notes.push(
          `${pkg.displayName} is a local installation on one machine and was left out; adopt it first.`,
        );
        continue;
      }
      if (pkg.source.kind === "managed") {
        notes.push(
          `${pkg.displayName} was authored in Orkestrator; another fleet can import it only from this command node's cache. Publish it to a repository to share it widely.`,
        );
      }
      const digest = revisionDigest(pkg, selection.version);
      const components = digest && capabilityRevisionComponents(pkg, digest, catalogue);
      if (!digest || !components) {
        throw new CapabilityError(
          "conflict",
          "The selected package revision cannot be exported because its inventory is unavailable.",
        );
      }
      const revision =
        digest === pkg.artifactDigest
          ? pkg.revision
          : pkg.previousRevisions!.find((entry) => entry.artifactDigest === digest)!.revision;
      packages.push({
        source: pkg.source,
        revision,
        ...(selection.components ? { components: selection.components } : {}),
        ...(selection.required ? { required: true } : {}),
      });
      refs.push({ packageId: pkg.id, artifactDigest: digest });
      // One lock entry per package revision: two setups may pin two revisions.
      const key = capabilityLockEntryKey(pkg.id, digest);
      if (!locked.has(key)) {
        locked.add(key);
        lock.packages.push({
          id: pkg.id,
          source: pkg.source,
          revision,
          artifactDigest: digest,
          components: components.map(({ id, kind, pathOrKey }) => ({ id, kind, pathOrKey })),
        });
      }
    }
    const providers = setup.providerSelectors
      .filter((selector) => selector.startsWith("provider:"))
      .map((selector) => selector.slice("provider:".length) as AgentPlatform);
    const machines = setup.machineSelectors
      .filter((selector) => selector === "*" || selector.startsWith("group:"))
      .map((selector) => (selector === "*" ? "*" : selector.slice("group:".length)));
    if (setup.machineSelectors.some((selector) => selector.startsWith("machine:"))) {
      notes.push(`${setup.name}: machine-specific targets are private and were left out.`);
    }
    const exclusions = setup.exclusions.filter((entry) => {
      const bar = entry.indexOf("|");
      return bar < 0 || isPortableCapabilitySelector(entry.slice(0, bar));
    });
    intent.setups[slug] = {
      ...(setup.description ? { description: setup.description } : {}),
      packages,
      ...(providers.length > 0 ? { providers } : {}),
      ...(machines.length > 0 ? { machines } : {}),
      ...(exclusions.length > 0 ? { exclusions } : {}),
      ...(setup.parentSetupIds.length > 0
        ? {
            parents: setup.parentSetupIds
              .map((parent) => slugs.get(parent) ?? parent)
              .filter((parent) => /^[a-z0-9-]+$/.test(parent)),
          }
        : {}),
      updatePolicy: setup.updatePolicy,
    };
    lock.setups[slug] = { packageIds: refs.map((ref) => ref.packageId), packages: refs };
  }
  lock.packages.sort(
    (a, b) =>
      a.id.localeCompare(b.id) ||
      revisionRank(state.packages[a.id]!, a.artifactDigest) -
        revisionRank(state.packages[b.id]!, b.artifactDigest),
  );
  const header = `# Orkestrator capabilities: the setups this project uses.\n# Resolved revisions are pinned in ${CAPABILITY_LOCK_FILE}. Never put credentials here.\n`;
  const intentText = `${header}${Bun.YAML.stringify(intent, null, 2)}\n`;
  // The files must pass the same validation an import applies.
  const check = validateCapabilityIntent(intent);
  if (check.issues.length > 0 || !check.intent) {
    throw new CapabilityError(
      "unsafe-content",
      `The export would not be portable: ${check.issues[0]?.message ?? "invalid manifest"}`,
    );
  }
  if (options.signingKey) lock = signCapabilityLockfile(lock, check.intent, options.signingKey);
  const document = capabilityLockfileDocument(lock);
  const lockCheck = validateCapabilityLockfile(document, check.intent);
  if (lockCheck.issues.length > 0) {
    throw new CapabilityError(
      "unsafe-content",
      `The export would not be portable: ${lockCheck.issues[0]!.message}`,
    );
  }
  const lockText = `${JSON.stringify(document, null, 2)}\n`;
  return {
    intent,
    lock,
    intentText,
    lockText,
    formatVersion: document.formatVersion === 2 ? 2 : 1,
    ...(lock.signature
      ? {
          signed: {
            keyId: lock.signature.keyId,
            fingerprint: graphSharingFingerprint(lock.signature.keyId),
          },
        }
      : {}),
    notes,
  };
}

export async function writeProjectManifests(
  projectRoot: string,
  exported: ExportResult,
): Promise<void> {
  const stat = await fs.stat(projectRoot).catch(() => null);
  if (!stat?.isDirectory())
    throw new CapabilityError("not-found", "The project has no local checkout on this machine.");
  await writeFileAtomically(path.join(projectRoot, CAPABILITY_INTENT_FILE), exported.intentText);
  await writeFileAtomically(path.join(projectRoot, CAPABILITY_LOCK_FILE), exported.lockText);
}

export async function readProjectManifests(
  projectRoot: string,
): Promise<{ intent: string; lock: string }> {
  const read = async (name: string) => {
    const file = path.join(projectRoot, name);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile()) throw new CapabilityError("not-found", `${name} is not in the project.`);
    if (stat.size > 1024 * 1024) throw new CapabilityError("too-large", `${name} is too large.`);
    return fs.readFile(file, "utf8");
  };
  return { intent: await read(CAPABILITY_INTENT_FILE), lock: await read(CAPABILITY_LOCK_FILE) };
}

/** Parses the two texts. YAML is parsed by Bun; anything malformed is an issue, never a throw. */
export function parseManifests(
  intentText: string,
  lockText: string,
): {
  intent: CapabilityIntent | null;
  lock: CapabilityLockfile | null;
  issues: CapabilityManifestIssue[];
  /** The canonical text a lockfile signature covers, when signed. */
  signedPayload?: string;
} {
  const issues: CapabilityManifestIssue[] = [];
  if (intentText.length > 1024 * 1024 || lockText.length > 4 * 1024 * 1024) {
    return {
      intent: null,
      lock: null,
      issues: [{ path: "$", message: "The manifest is too large." }],
    };
  }
  let intentValue: unknown;
  try {
    intentValue = Bun.YAML.parse(intentText);
  } catch {
    issues.push({ path: CAPABILITY_INTENT_FILE, message: "Not valid YAML." });
  }
  let lockValue: unknown;
  try {
    lockValue = JSON.parse(lockText);
  } catch {
    issues.push({ path: CAPABILITY_LOCK_FILE, message: "Not valid JSON." });
  }
  const intentCheck =
    intentValue === undefined
      ? { intent: null, issues: [] }
      : validateCapabilityIntent(intentValue);
  const lockCheck: ReturnType<typeof validateCapabilityLockfile> =
    lockValue === undefined
      ? { lock: null, issues: [] }
      : validateCapabilityLockfile(lockValue, intentCheck.intent);
  return {
    intent: intentCheck.intent,
    lock: lockCheck.lock,
    issues: [...issues, ...intentCheck.issues, ...lockCheck.issues],
    ...(lockCheck.signedPayload ? { signedPayload: lockCheck.signedPayload } : {}),
  };
}

export interface ImportPlan {
  setups: Array<{ name: string; action: "create" | "update" | "unchanged"; packages: number }>;
  packages: Array<{
    packageId: string;
    action: "add" | "update" | "unchanged" | "conflict";
    revision: string;
    artifactDigest: string;
    reason?: string;
  }>;
}

/** The library already keeps this lock entry's revision: current, or an older one with its inventory. */
export function isRevisionKept(
  state: CapabilityState,
  entry: Pick<CapabilityLockPackage, "id" | "artifactDigest">,
): boolean {
  const existing = state.packages[entry.id];
  return Boolean(
    existing &&
    (existing.artifactDigest === entry.artifactDigest ||
      existing.previousRevisions?.some(
        (revision) => revision.artifactDigest === entry.artifactDigest && revision.components,
      )),
  );
}

/** What importing would do to the current state; writes nothing. */
export function planImport(
  state: CapabilityState,
  intent: CapabilityIntent,
  lock: CapabilityLockfile,
): ImportPlan {
  const byName = new Map(Object.values(state.setups).map((setup) => [setupSlug(setup), setup]));
  const setups: ImportPlan["setups"] = Object.entries(intent.setups).map(([name, setup]) => {
    const existing = byName.get(name);
    if (!existing) return { name, action: "create" as const, packages: setup.packages.length };
    const same =
      existing.packageSelections.length === setup.packages.length &&
      setup.packages.every((entry) =>
        existing.packageSelections.some(
          (selection) => selection.packageId === capabilityPackageId(entry.source),
        ),
      );
    return {
      name,
      action: same ? ("unchanged" as const) : ("update" as const),
      packages: setup.packages.length,
    };
  });
  const packages: ImportPlan["packages"] = lock.packages.map((entry) => {
    const existing = state.packages[entry.id];
    if (!existing)
      return {
        packageId: entry.id,
        action: "add" as const,
        revision: entry.revision,
        artifactDigest: entry.artifactDigest,
      };
    if (isRevisionKept(state, entry)) {
      return {
        packageId: entry.id,
        action: "unchanged" as const,
        revision: entry.revision,
        artifactDigest: entry.artifactDigest,
      };
    }
    return {
      packageId: entry.id,
      action: "conflict" as const,
      revision: entry.revision,
      artifactDigest: entry.artifactDigest,
      reason:
        "The library holds a different revision. Review it through the package update or rollback workflow before importing.",
    };
  });
  return { setups, packages };
}

/**
 * Adds the packages an import fetched to `state`. A package locked at more
 * than one revision is created at its first lock entry (the exporter's
 * current revision) with the others kept as earlier revisions, each with its
 * component inventory, so every setup's pinned revision resolves.
 */
export function addImportedPackages(
  state: CapabilityState,
  fetched: readonly InspectedPackage[],
  provenance: CapabilityProvenance,
  now: string,
): void {
  const byPackage = new Map<string, InspectedPackage[]>();
  for (const inspected of fetched) {
    byPackage.set(inspected.packageId, [...(byPackage.get(inspected.packageId) ?? []), inspected]);
  }
  for (const [packageId, revisions] of byPackage) {
    const [current, ...older] = revisions as [InspectedPackage, ...InspectedPackage[]];
    const existing = state.packages[packageId];
    if (!existing) {
      for (const component of current.components) state.components[component.id] = component;
      state.packages[packageId] = {
        id: packageId,
        source: current.source,
        displayName: current.displayName,
        ...(current.description ? { description: current.description } : {}),
        revision: current.revision,
        artifactDigest: current.artifactDigest,
        componentIds: current.components.map((component) => component.id),
        provenance,
        risk: current.risk,
        ...(current.publisher ? { publisher: current.publisher } : {}),
        previousRevisions: [],
        createdAt: now,
        updatedAt: now,
      };
    } else {
      older.unshift(current);
    }
    const pkg = state.packages[packageId]!;
    for (const inspected of older) {
      if (inspected.artifactDigest === pkg.artifactDigest) continue;
      const components: CapabilityComponent[] = inspected.components;
      pkg.previousRevisions = [
        ...(pkg.previousRevisions ?? []).filter(
          (entry) => entry.artifactDigest !== inspected.artifactDigest,
        ),
        {
          revision: inspected.revision,
          artifactDigest: inspected.artifactDigest,
          replacedAt: now,
          components,
        },
      ];
    }
    for (const inspected of revisions) {
      state.artifacts[inspected.artifactDigest] ??= {
        digest: inspected.artifactDigest,
        bytes: inspected.files.reduce((total, file) => total + file.bytes, 0),
        files: inspected.files.map((file) => ({
          path: file.path,
          bytes: file.bytes,
          executable: file.executable,
          sha256: file.sha256,
        })),
        refs: [`package:${inspected.packageId}@${inspected.revision}`],
        createdAt: now,
      };
    }
  }
}

/**
 * The package selections an imported setup gets: each pinned to the exact
 * lock entry the lockfile names for that setup. A selection the intent left
 * unpinned follows the package's latest revision when the setup uses the
 * package's first (current) lock entry.
 */
export function importedSelections(
  setup: CapabilityIntentSetup,
  lockSetup: CapabilityLockfile["setups"][string] | undefined,
  lock: CapabilityLockfile,
): CapabilityPackageSelection[] {
  return setup.packages.map((entry) => {
    const packageId = capabilityPackageId(entry.source);
    // An import previewed before format 2 has no per-setup references.
    const ref = lockSetup?.packages?.find((candidate) => candidate.packageId === packageId);
    const revisions = lock.packages.filter((candidate) => candidate.id === packageId);
    const pinned: CapabilityLockPackage | undefined = ref
      ? revisions.find((candidate) => candidate.artifactDigest === ref.artifactDigest)
      : undefined;
    let version = entry.revision ?? "latest";
    if (pinned && (entry.revision || pinned !== revisions[0])) {
      // A revision name two lock entries share is ambiguous; the digest is not.
      const shared = revisions.filter((candidate) => candidate.revision === pinned.revision);
      version = shared.length > 1 ? pinned.artifactDigest : pinned.revision;
    }
    return {
      packageId,
      version,
      ...(entry.components ? { components: entry.components } : {}),
      ...(entry.required ? { required: true } : {}),
    };
  });
}

export const MANIFEST_FORMAT_VERSION = CAPABILITY_MANIFEST_VERSION;
