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
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  MY_SETUP_ID,
  capabilityPackageId,
  type CapabilitySetup,
} from "@orkestrator/protocol/capability-resources";
import {
  CAPABILITY_INTENT_FILE,
  CAPABILITY_LOCK_FILE,
  CAPABILITY_MANIFEST_VERSION,
  isPortableCapabilitySelector,
  validateCapabilityIntent,
  validateCapabilityLockfile,
  type CapabilityIntent,
  type CapabilityIntentSetup,
  type CapabilityLockfile,
  type CapabilityManifestIssue,
} from "@orkestrator/protocol/capability-resources-manifest";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

import { CapabilityError, writeFileAtomically } from "./security.js";
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
  notes: string[];
}

/** Builds the two portable files for `setupIds`. */
export function exportSetups(state: CapabilityState, setupIds: readonly string[]): ExportResult {
  const notes: string[] = [];
  const intent: CapabilityIntent = { version: 1, setups: {} };
  const lock: CapabilityLockfile = {
    formatVersion: 1,
    generatedBy: "Orkestrator",
    packages: [],
    setups: {},
  };
  const locked = new Set<string>();
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
    const packageIds: string[] = [];
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
      packages.push({
        source: pkg.source,
        revision: selection.version === "latest" ? pkg.revision : selection.version,
        ...(selection.components ? { components: selection.components } : {}),
        ...(selection.required ? { required: true } : {}),
      });
      packageIds.push(pkg.id);
      if (!locked.has(pkg.id)) {
        locked.add(pkg.id);
        lock.packages.push({
          id: pkg.id,
          source: pkg.source,
          revision: pkg.revision,
          artifactDigest: pkg.artifactDigest,
          components: pkg.componentIds
            .map((componentId) => state.components[componentId])
            .filter((component) => component !== undefined)
            .map((component) => ({
              id: component.id,
              kind: component.kind,
              pathOrKey: component.pathOrKey,
            })),
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
    lock.setups[slug] = { packageIds };
  }
  lock.packages.sort((a, b) => a.id.localeCompare(b.id));
  const header = `# Orkestrator capabilities: the setups this project uses.\n# Resolved revisions are pinned in ${CAPABILITY_LOCK_FILE}. Never put credentials here.\n`;
  const intentText = `${header}${Bun.YAML.stringify(intent, null, 2)}\n`;
  const lockText = `${JSON.stringify(lock, null, 2)}\n`;
  // The files must pass the same validation an import applies.
  const check = validateCapabilityIntent(intent);
  if (check.issues.length > 0) {
    throw new CapabilityError(
      "unsafe-content",
      `The export would not be portable: ${check.issues[0]!.message}`,
    );
  }
  return { intent, lock, intentText, lockText, notes };
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
  const lockCheck =
    lockValue === undefined
      ? { lock: null, issues: [] }
      : validateCapabilityLockfile(lockValue, intentCheck.intent);
  return {
    intent: intentCheck.intent,
    lock: lockCheck.lock,
    issues: [...issues, ...intentCheck.issues, ...lockCheck.issues],
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
    if (existing.artifactDigest === entry.artifactDigest) {
      return {
        packageId: entry.id,
        action: "unchanged" as const,
        revision: entry.revision,
        artifactDigest: entry.artifactDigest,
      };
    }
    if (existing.provenance === "external" || existing.provenance === "administrator") {
      return {
        packageId: entry.id,
        action: "conflict" as const,
        revision: entry.revision,
        artifactDigest: entry.artifactDigest,
        reason: "The library holds a different revision that Orkestrator does not own.",
      };
    }
    return {
      packageId: entry.id,
      action: "update" as const,
      revision: entry.revision,
      artifactDigest: entry.artifactDigest,
    };
  });
  return { setups, packages };
}

export const MANIFEST_FORMAT_VERSION = CAPABILITY_MANIFEST_VERSION;
