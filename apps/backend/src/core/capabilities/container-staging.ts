/**
 * Container delivery through portable inputs
 * (docs/architecture/agent-capabilities-management.md, "Runtime connection
 * points"; 8314 task 7).
 *
 * A container never receives a write from outside: its provider homes are
 * filled by the entrypoint from the staged, read-only portable inputs of its
 * revision (`portable-inputs.ts`). So the container's effective manifest is
 * staged there, at creation and rebuild:
 *
 * 1. `containerCapabilityPlan` resolves every staged provider for the
 *    container target (My setup, toolkits, the project's and the
 *    environment's setups) and places each file component in the staged
 *    directory the entrypoint copies into that provider's home. Its digest
 *    covers the providers, the stages and every (location, component,
 *    revision), so the same setup always gives the same digest.
 * 2. `stageContainerCapabilities` writes those packages into the partial
 *    revision with the same markers and location indexes as the executor,
 *    bounded, from verified artifacts only (inspection refuses credentials).
 *    A host item with the same name that Orkestrator did not write is kept
 *    and reported as a collision.
 * 3. The record lands in the revision's `manifest.json` and its digest on
 *    the container's `orkestrator-capabilities-digest` label. Status and
 *    launch preflight read both back (`readContainerCapabilityDelivery`); a
 *    digest that differs from the current plan's is stale, and the existing
 *    rebuild re-stages it.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CapabilityComponent,
  CapabilityTarget,
  EffectiveAgentResources,
} from "@orkestrator/protocol/capability-resources";
import { canonicalCapabilityJson } from "@orkestrator/protocol/capability-resources-resolve";

import type { CapabilityArtifactStore } from "./artifact-store.js";
import { componentFiles } from "./executor.js";
import {
  installName,
  markerContent,
  readLocationIndex,
  writeLocationIndex,
} from "./native-ownership.js";
import { sha256 } from "./planning.js";
import {
  CAPABILITY_MARKER_FILE,
  replaceDirectoryAtomically,
  treeDigest,
  writeFileAtomically,
} from "./security.js";
import { assertDistributableArtifact } from "./source-inspection.js";
import {
  containerCapabilityLocations,
  planScopedLocations,
  type ScopedLocation,
} from "./scoped-locations.js";
import { revisionComponent, type ContainerDeliveryEvidence } from "./scoped-delivery.js";
import type { CapabilityState } from "./types.js";

export const CONTAINER_CAPABILITY_RECORD_VERSION = 1;

/** Staged bytes for one container, at most. */
export const CONTAINER_CAPABILITY_LIMITS = { files: 5_000, bytes: 64 * 1024 * 1024 } as const;

/** The resolver's placeholder incarnation: any value selects the container support matrix. */
const STAGING_INCARNATION = "staging";

export interface ContainerCapabilityItem {
  key: string;
  locationId: string;
  relative: string;
  layout: "directory" | "file";
  componentId: string;
  packageId: string;
  packageDigest: string;
  kind: CapabilityComponent["kind"];
  componentName: string;
  pathOrKey: string;
  providers: AgentPlatform[];
}

export interface ContainerCapabilityPlan {
  digest: string;
  providers: AgentPlatform[];
  stages: string[];
  items: ContainerCapabilityItem[];
  undeliverable: Array<{ provider: AgentPlatform; componentId: string; reason: string }>;
}

export interface ContainerCapabilityRecordItem {
  componentId: string;
  packageId: string;
  packageDigest: string;
  locationId: string;
  providers: AgentPlatform[];
  status: "staged" | "collision" | "too-large" | "failed";
  /** Digest of the staged bytes. */
  digest?: string;
  reason?: string;
}

export interface ContainerCapabilityRecord {
  formatVersion: number;
  digest: string;
  providers: AgentPlatform[];
  stages: string[];
  stagedAt: string;
  items: ContainerCapabilityRecordItem[];
}

const FILE_KINDS = new Set(["skill", "command", "prompt", "subagent"]);

/**
 * What a container with `providers` staged (and `stages`, the input stage
 * names: providers plus `agents-skills` when the image copies the shared
 * skills root) should receive.
 */
export function containerCapabilityPlan(
  state: CapabilityState,
  input: {
    nodeId: string;
    environmentId: string;
    projectId?: string;
    providers: readonly AgentPlatform[];
    stages: ReadonlySet<string>;
  },
  resolve: (state: CapabilityState, target: CapabilityTarget) => EffectiveAgentResources,
): ContainerCapabilityPlan {
  const providers = [...new Set(input.providers)].sort();
  const stages = [...input.stages].sort();
  const table = containerCapabilityLocations(input.stages);
  const wanted = new Map<
    string,
    {
      component: CapabilityComponent;
      packageId: string;
      digest: string;
      providers: Set<AgentPlatform>;
    }
  >();
  const undeliverable: ContainerCapabilityPlan["undeliverable"] = [];
  for (const provider of providers) {
    const resolved = resolve(state, {
      nodeId: input.nodeId,
      provider,
      environmentId: input.environmentId,
      environmentIncarnation: STAGING_INCARNATION,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });
    for (const entry of resolved.unsupported) {
      undeliverable.push({ provider, componentId: entry.componentId, reason: entry.reason });
    }
    for (const pkg of resolved.resolvedPackages) {
      for (const componentId of pkg.components) {
        const component = revisionComponent(state, pkg.id, componentId, pkg.artifactDigest);
        if (!component) continue;
        if (component.providerHints.length > 0 && !component.providerHints.includes(provider))
          continue;
        if (!FILE_KINDS.has(component.kind)) {
          undeliverable.push({
            provider,
            componentId,
            reason:
              component.kind === "mcp-server"
                ? "A container takes MCP servers through its staged provider configuration, not as a capability copy."
                : "Only skills, commands, prompts and subagents are staged into a container.",
          });
          continue;
        }
        const key = `${componentId}|${pkg.artifactDigest}`;
        const entry = wanted.get(key) ?? {
          component,
          packageId: pkg.id,
          digest: pkg.artifactDigest,
          providers: new Set<AgentPlatform>(),
        };
        entry.providers.add(provider);
        wanted.set(key, entry);
      }
    }
  }
  const byKey = new Map<string, ContainerCapabilityItem>();
  const conflicts = new Set<string>();
  for (const [, entry] of [...wanted.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const requested = providers.filter((provider) => entry.providers.has(provider));
    const plan = planScopedLocations(table, entry.component.kind, requested);
    for (const { location, providers: served } of plan.locations) {
      const key = `${location.id}|${entry.component.id}`;
      const previous = byKey.get(key);
      if (previous && previous.packageDigest !== entry.digest) conflicts.add(key);
      byKey.set(key, itemFor(location, entry, served));
    }
    for (const provider of plan.uncovered) {
      undeliverable.push({
        provider,
        componentId: entry.component.id,
        reason: `${provider} reads no staged directory in this container for a ${entry.component.kind}.`,
      });
    }
  }
  for (const key of conflicts) byKey.delete(key);
  const items = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  const digest = sha256(
    canonicalCapabilityJson({
      providers,
      stages,
      items: items.map((item) => [item.key, item.packageDigest, item.providers]),
    }),
  );
  return { digest, providers, stages, items, undeliverable };
}

function itemFor(
  location: ScopedLocation,
  entry: { component: CapabilityComponent; packageId: string; digest: string },
  providers: AgentPlatform[],
): ContainerCapabilityItem {
  return {
    key: `${location.id}|${entry.component.id}`,
    locationId: location.id,
    relative: location.relative,
    layout: location.layout,
    componentId: entry.component.id,
    packageId: entry.packageId,
    packageDigest: entry.digest,
    kind: entry.component.kind,
    componentName: entry.component.name,
    pathOrKey: entry.component.pathOrKey,
    providers,
  };
}

async function readMarker(file: string): Promise<{ packageId?: unknown } | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    return JSON.parse(await fs.readFile(file, "utf8")) as { packageId?: unknown };
  } catch {
    return null;
  }
}

/**
 * Writes `plan` into a partial inputs revision. Never follows a link, never
 * replaces an item the host staged that Orkestrator did not write.
 */
export async function stageContainerCapabilities(
  plan: ContainerCapabilityPlan,
  artifacts: CapabilityArtifactStore,
  revisionDirectory: string,
  now: () => string = () => new Date().toISOString(),
): Promise<ContainerCapabilityRecord> {
  const items: ContainerCapabilityRecordItem[] = [];
  let files = 0;
  let bytes = 0;
  for (const item of plan.items) {
    const base = {
      componentId: item.componentId,
      packageId: item.packageId,
      packageDigest: item.packageDigest,
      locationId: item.locationId,
      providers: item.providers,
    };
    try {
      const artifact = await artifacts.get(item.packageDigest);
      assertDistributableArtifact(artifact);
      const selected = componentFiles(artifact, item);
      if (selected.length === 0) {
        items.push({ ...base, status: "failed", reason: "The component is not in its artifact." });
        continue;
      }
      const size = selected.reduce((total, file) => total + file.content.length, 0);
      if (
        files + selected.length > CONTAINER_CAPABILITY_LIMITS.files ||
        bytes + size > CONTAINER_CAPABILITY_LIMITS.bytes
      ) {
        items.push({
          ...base,
          status: "too-large",
          reason: "The container's capability budget is used up; this component was not staged.",
        });
        continue;
      }
      const directory = path.join(revisionDirectory, ...item.relative.split("/"));
      const name = installName(item.componentName, item.pathOrKey, item.layout);
      const entry = item.layout === "file" ? `${name}.md` : name;
      const written = item.layout === "file" ? [{ ...selected[0]!, path: entry }] : selected;
      const digest = treeDigest(written);
      const existing = await fs.lstat(path.join(directory, entry)).catch(() => null);
      const index = item.layout === "file" ? await readLocationIndex(directory) : null;
      if (existing) {
        const owner =
          item.layout === "directory"
            ? (await readMarker(path.join(directory, entry, CAPABILITY_MARKER_FILE)))?.packageId
            : index?.files[entry]?.packageId;
        if (existing.isSymbolicLink() || owner !== item.packageId) {
          items.push({
            ...base,
            status: "collision",
            reason: `The host's own ${entry} is staged at that name; it was kept.`,
          });
          continue;
        }
      }
      const marker = {
        packageId: item.packageId,
        componentId: item.componentId,
        digest,
        writtenAt: now(),
      };
      if (item.layout === "directory") {
        await replaceDirectoryAtomically(path.join(directory, entry), written, [
          { path: CAPABILITY_MARKER_FILE, content: markerContent(marker) },
        ]);
      } else {
        await fs.mkdir(directory, { recursive: true });
        await writeFileAtomically(path.join(directory, entry), written[0]!.content);
        index!.files[entry] = marker;
        await writeLocationIndex(directory, index!);
      }
      files += selected.length;
      bytes += size;
      items.push({ ...base, status: "staged", digest });
    } catch (error) {
      items.push({
        ...base,
        status: "failed",
        reason: error instanceof Error ? error.message.slice(0, 300) : "Staging failed.",
      });
    }
  }
  return {
    formatVersion: CONTAINER_CAPABILITY_RECORD_VERSION,
    digest: plan.digest,
    providers: plan.providers,
    stages: plan.stages,
    stagedAt: now(),
    items,
  };
}

/** A record read back from a manifest: untrusted shape, checked field by field. */
export function parseContainerCapabilityRecord(value: unknown): ContainerCapabilityRecord | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.formatVersion !== CONTAINER_CAPABILITY_RECORD_VERSION ||
    typeof record.digest !== "string" ||
    !Array.isArray(record.providers) ||
    !Array.isArray(record.items)
  ) {
    return null;
  }
  const strings = (list: unknown) =>
    Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
  const items = record.items.slice(0, 2_000).flatMap((raw): ContainerCapabilityRecordItem[] => {
    const item = raw as Record<string, unknown>;
    const status = item?.status;
    if (
      typeof item?.componentId !== "string" ||
      typeof item.packageId !== "string" ||
      typeof item.packageDigest !== "string" ||
      typeof item.locationId !== "string" ||
      (status !== "staged" &&
        status !== "collision" &&
        status !== "too-large" &&
        status !== "failed")
    ) {
      return [];
    }
    return [
      {
        componentId: item.componentId,
        packageId: item.packageId,
        packageDigest: item.packageDigest,
        locationId: item.locationId,
        providers: strings(item.providers) as AgentPlatform[],
        status,
        ...(typeof item.digest === "string" ? { digest: item.digest } : {}),
        ...(typeof item.reason === "string" ? { reason: item.reason.slice(0, 300) } : {}),
      },
    ];
  });
  return {
    formatVersion: CONTAINER_CAPABILITY_RECORD_VERSION,
    digest: record.digest,
    providers: strings(record.providers) as AgentPlatform[],
    stages: strings(record.stages),
    stagedAt: typeof record.stagedAt === "string" ? record.stagedAt : "",
    items,
  };
}

export interface ContainerDeliveryReader {
  /** The container's label value, or null. */
  label(containerId: string, label: string): Promise<string | null>;
  /** The inputs revision's `manifest.json` extensions. */
  manifestExtensions(revision: string): Promise<Record<string, unknown> | undefined>;
}

/**
 * The capability record of the container an environment runs now, from its
 * inputs revision label, its capabilities label and the revision manifest.
 */
export async function readContainerCapabilityDelivery(
  reader: ContainerDeliveryReader,
  containerId: string,
  labels: { inputsRevision: string; capabilitiesDigest: string },
): Promise<ContainerDeliveryEvidence | null> {
  const revision = await reader.label(containerId, labels.inputsRevision);
  if (!revision) return null;
  const [labelDigest, extensions] = await Promise.all([
    reader.label(containerId, labels.capabilitiesDigest),
    reader.manifestExtensions(revision),
  ]);
  return {
    containerId,
    inputsRevision: revision,
    labelDigest,
    record: parseContainerCapabilityRecord(extensions?.capabilities),
  };
}
