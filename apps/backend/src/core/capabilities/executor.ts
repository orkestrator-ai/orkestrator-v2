/**
 * The per-machine capability executor
 * (docs/architecture/agent-capabilities-management.md, "Reconciliation").
 *
 * A command node sends a machine a plan: one entry per (location, component)
 * with a stable idempotency key, the artifact digest to install and the
 * action. The executor:
 *
 * 1. refuses a plan carrying an older single-writer epoch than it has seen;
 * 2. answers a key it already applied with the recorded result, after
 *    checking the bytes are still there (a replayed write is a read);
 * 3. never overwrites or removes an item it does not own (no marker or
 *    index entry), and never overwrites an owned item with local changes
 *    unless the plan says the user chose to replace them;
 * 4. writes atomically (sibling directory, then rename) under a per-location
 *    lock, and records the key before it answers.
 *
 * MCP servers go through this machine's own MCP management service (the same
 * revisions and locks the MCP servers settings use). Native plugins go
 * through the provider's own CLI. Anything else is reported unsupported.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  isComponentKind,
  isSafeCapabilityRelativePath,
  type CapabilityTargetStatus,
  type CapabilityVerificationLevel,
  type ComponentKind,
} from "@orkestrator/protocol/capability-resources";
import {
  capabilityLocation,
  describeCapabilitySupport,
  maxVerificationLevel,
} from "@orkestrator/protocol/capability-resources-support";

import type { CapabilityArtifactStore } from "./artifact-store.js";
import {
  installName,
  installedDigest,
  locationDirectory,
  markerContent,
  readLocationIndex,
  writeLocationIndex,
  type CapabilityHomes,
} from "./native-ownership.js";
import {
  boundedReason,
  CAPABILITY_MARKER_FILE,
  CapabilityError,
  removeManagedPath,
  replaceDirectoryAtomically,
  treeDigest,
  writeFileAtomically,
  type PackageFile,
} from "./security.js";
import { parseMcpDefinitions } from "./source-inspection.js";
import type { CapabilitiesStorage } from "../storage-capabilities.js";

export interface NodePlanTarget {
  key: string;
  action: "install" | "update" | "remove";
  kind: ComponentKind;
  packageId: string;
  componentId: string;
  componentName: string;
  pathOrKey: string;
  /** File kinds: the location to write. */
  locationId?: string;
  /** MCP and plugins: the provider whose configuration changes. */
  provider?: AgentPlatform;
  artifactDigest?: string;
  /** The user chose "replace with the configured revision" for local changes. */
  force?: boolean;
  /** Marketplace plugins: `name@marketplace`. */
  qualifiedId?: string;
}

export interface NodePlanResult {
  key: string;
  status: CapabilityTargetStatus;
  verification: CapabilityVerificationLevel | "unverified";
  digest?: string;
  reason?: string;
  replayed?: boolean;
}

/** Writes and removes MCP definitions in one provider's user configuration. */
export interface McpInstaller {
  install(input: {
    provider: AgentPlatform;
    name: string;
    definition: {
      transport: "stdio" | "http" | "sse";
      command?: string;
      args?: string[];
      url?: string;
    };
    requestId: string;
  }): Promise<{ status: CapabilityTargetStatus; reason?: string }>;
  remove(input: { provider: AgentPlatform; name: string; requestId: string }): Promise<{
    status: CapabilityTargetStatus;
    reason?: string;
  }>;
}

export type PluginCli = (provider: AgentPlatform, args: string[]) => Promise<string>;

export interface CapabilityExecutorDeps {
  storage: { capabilities: CapabilitiesStorage };
  artifacts: CapabilityArtifactStore;
  homes: () => CapabilityHomes;
  mcp?: McpInstaller;
  pluginCli?: PluginCli;
  now?: () => string;
}

/** Plan entries are untrusted input from a peer: validate every field. */
export function parseNodePlanTargets(value: unknown): NodePlanTarget[] {
  if (!Array.isArray(value))
    throw new CapabilityError("invalid-request", "Expected a list of plan targets.");
  if (value.length > 2_000)
    throw new CapabilityError("too-large", "The plan has too many targets.");
  return value.map((entry: unknown) => {
    const raw = entry as Record<string, unknown>;
    const text = (key: string, max = 512) => {
      const item = raw?.[key];
      if (typeof item !== "string" || item.length === 0 || item.length > max) {
        throw new CapabilityError("invalid-request", `Plan field ${key} is not valid.`);
      }
      return item;
    };
    const optional = (key: string) =>
      typeof raw?.[key] === "string" && (raw[key] as string).length <= 512
        ? (raw[key] as string)
        : undefined;
    const action = raw?.action;
    if (action !== "install" && action !== "update" && action !== "remove") {
      throw new CapabilityError("invalid-request", "Plan action is not valid.");
    }
    if (!isComponentKind(raw?.kind))
      throw new CapabilityError("invalid-request", "Plan kind is not valid.");
    const locationId = optional("locationId");
    if (locationId && !capabilityLocation(locationId)) {
      throw new CapabilityError("invalid-request", "Plan location is not valid.");
    }
    const pathOrKey = typeof raw.pathOrKey === "string" ? raw.pathOrKey : "";
    if (
      pathOrKey &&
      !isSafeCapabilityRelativePath(pathOrKey.split("#")[0]!) &&
      raw.kind !== "mcp-server" &&
      raw.kind !== "native-plugin"
    ) {
      throw new CapabilityError("invalid-request", "Plan path is not valid.");
    }
    const provider = optional("provider") as AgentPlatform | undefined;
    return {
      key: text("key"),
      action,
      kind: raw.kind,
      packageId: text("packageId"),
      componentId: text("componentId"),
      componentName: text("componentName", 200),
      pathOrKey,
      ...(locationId ? { locationId } : {}),
      ...(provider ? { provider } : {}),
      ...(optional("artifactDigest") ? { artifactDigest: optional("artifactDigest")! } : {}),
      ...(raw.force === true ? { force: true } : {}),
      ...(optional("qualifiedId") ? { qualifiedId: optional("qualifiedId")! } : {}),
    } satisfies NodePlanTarget;
  });
}

/** The files of one component, re-rooted at the component's own directory or file. */
export function componentFiles(
  files: readonly PackageFile[],
  target: Pick<NodePlanTarget, "kind" | "pathOrKey">,
): PackageFile[] {
  if (target.kind === "skill") {
    const prefix = target.pathOrKey ? `${target.pathOrKey}/` : "";
    return files
      .filter((file) => (prefix ? file.path.startsWith(prefix) : true))
      .map((file) => ({ ...file, path: prefix ? file.path.slice(prefix.length) : file.path }));
  }
  const file = files.find((entry) => entry.path === target.pathOrKey);
  return file ? [file] : [];
}

export class CapabilityExecutor {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: CapabilityExecutorDeps) {}

  private now(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  /** Serializes work per location so two plans never interleave in one directory. */
  private withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.locks.set(
      key,
      next
        .catch(() => undefined)
        .finally(() => {
          if (this.locks.get(key) === next) this.locks.delete(key);
        }),
    );
    return next;
  }

  /**
   * Accepts `epoch` from `controllerId` when it is not older than the one
   * already seen. A handover raises the epoch; the previous controller's
   * calls are then refused, so two authorities never write here.
   */
  admitEpoch(controllerId: string, epoch: number): void {
    if (!Number.isInteger(epoch) || epoch < 1) {
      throw new CapabilityError("invalid-request", "The plan carries no valid epoch.");
    }
    this.deps.storage.capabilities.mutateCapabilityExecutorState((state) => {
      if (epoch < state.epoch) {
        throw new CapabilityError(
          "stale-epoch",
          "This machine follows a newer command node; the plan was refused.",
        );
      }
      if (epoch === state.epoch && state.controllerId && state.controllerId !== controllerId) {
        throw new CapabilityError(
          "stale-epoch",
          "Another command node holds this epoch; the plan was refused.",
        );
      }
      state.epoch = epoch;
      state.controllerId = controllerId;
    });
  }

  async apply(targets: readonly NodePlanTarget[]): Promise<NodePlanResult[]> {
    const results: NodePlanResult[] = [];
    for (const target of targets) {
      const lockKey = target.locationId ?? `${target.kind}:${target.provider ?? ""}`;
      results.push(
        await this.withLock(lockKey, () =>
          this.applyOne(target).catch((error: unknown) => ({
            key: target.key,
            status: "failed" as const,
            verification: "requested" as const,
            reason: boundedReason(error),
          })),
        ),
      );
    }
    return results;
  }

  private async applyOne(target: NodePlanTarget): Promise<NodePlanResult> {
    const executor = await this.deps.storage.capabilities.loadCapabilityExecutorState();
    const previous = executor.applied[target.key];
    if (target.kind === "mcp-server") return this.applyMcp(target, previous !== undefined);
    if (target.kind === "native-plugin") return this.applyPlugin(target);
    if (target.kind === "hook") {
      return {
        key: target.key,
        status: "unsupported",
        verification: "requested",
        reason:
          "Standalone hooks are not installed; a hook is delivered only inside a native plugin through the provider's plugin lifecycle.",
      };
    }
    if (!target.locationId) {
      return {
        key: target.key,
        status: "unsupported",
        verification: "requested",
        reason: "No location for this component.",
      };
    }
    const location = capabilityLocation(target.locationId)!;
    const directory = locationDirectory(location.id, this.deps.homes());
    const name = installName(target.componentName, target.pathOrKey, location.layout);
    const entry = location.layout === "file" ? `${name}.md` : name;

    if (target.action === "remove")
      return this.removeFileComponent(target, location.layout, directory, entry);

    if (!target.artifactDigest)
      throw new CapabilityError("invalid-request", "The plan names no artifact.");
    const files = componentFiles(await this.deps.artifacts.get(target.artifactDigest), target);
    if (files.length === 0)
      throw new CapabilityError("not-found", "The component is not in the artifact.");
    const writtenFiles = location.layout === "file" ? [{ ...files[0]!, path: entry }] : files;
    const digest = treeDigest(writtenFiles);

    // A replayed key whose bytes are still in place is answered from the record.
    if (previous && previous.digest === digest) {
      const current = await installedDigest(location, directory, entry);
      if (current === digest) {
        return {
          key: target.key,
          status: this.installedStatus(target),
          verification: this.verification(target),
          digest,
          replayed: true,
        };
      }
    }

    const ownership = await this.ownership(location.layout, directory, entry);
    // Adoption: the user chose to manage an external item whose bytes are exactly the package's.
    const adopting =
      ownership.kind === "external" &&
      target.force === true &&
      (await installedDigest(location, directory, entry)) === digest;
    if (ownership.kind === "external" && !adopting) {
      return {
        key: target.key,
        status: "drifted",
        verification: "requested",
        reason: `An item named ${name} that Orkestrator does not manage is already in ${location.label}. Adopt it or rename the component; it was left untouched.`,
      };
    }
    if (ownership.kind === "managed") {
      if (ownership.packageId !== target.packageId) {
        return {
          key: target.key,
          status: "failed",
          verification: "requested",
          reason: `${name} in ${location.label} belongs to another package; the two components collide.`,
        };
      }
      const current = await installedDigest(location, directory, entry);
      if (current !== ownership.digest && current !== digest && !target.force) {
        return {
          key: target.key,
          status: "drifted",
          verification: "present",
          ...(current ? { digest: current } : {}),
          reason: `${name} in ${location.label} has local changes; they were kept until you decide.`,
        };
      }
    }

    const marker = {
      packageId: target.packageId,
      componentId: target.componentId,
      digest,
      writtenAt: this.now(),
    };
    if (location.layout === "directory") {
      await replaceDirectoryAtomically(path.join(directory, entry), writtenFiles, [
        { path: CAPABILITY_MARKER_FILE, content: markerContent(marker) },
      ]);
    } else {
      await fs.mkdir(directory, { recursive: true });
      await writeFileAtomically(path.join(directory, entry), writtenFiles[0]!.content);
      const index = await readLocationIndex(directory);
      index.files[entry] = marker;
      await writeLocationIndex(directory, index);
    }
    this.record(target, digest);
    return {
      key: target.key,
      status: this.installedStatus(target),
      verification: this.verification(target),
      digest,
    };
  }

  private async ownership(
    layout: "directory" | "file",
    directory: string,
    entry: string,
  ): Promise<
    | { kind: "absent" }
    | { kind: "external" }
    | { kind: "managed"; packageId: string; digest: string }
  > {
    const exists = await fs.lstat(path.join(directory, entry)).catch(() => null);
    if (!exists) return { kind: "absent" };
    if (layout === "directory") {
      try {
        const marker = JSON.parse(
          await fs.readFile(path.join(directory, entry, CAPABILITY_MARKER_FILE), "utf8"),
        ) as { packageId?: unknown; digest?: unknown };
        if (typeof marker.packageId === "string" && typeof marker.digest === "string") {
          return { kind: "managed", packageId: marker.packageId, digest: marker.digest };
        }
      } catch {
        // no marker: external
      }
      return { kind: "external" };
    }
    const index = await readLocationIndex(directory);
    const managed = index.files[entry];
    return managed
      ? { kind: "managed", packageId: managed.packageId, digest: managed.digest }
      : { kind: "external" };
  }

  private async removeFileComponent(
    target: NodePlanTarget,
    layout: "directory" | "file",
    directory: string,
    entry: string,
  ): Promise<NodePlanResult> {
    const ownership = await this.ownership(layout, directory, entry);
    if (ownership.kind === "absent") {
      this.forget(target);
      return {
        key: target.key,
        status: "ready",
        verification: "requested",
        reason: "Already removed.",
      };
    }
    if (ownership.kind === "external" || ownership.packageId !== target.packageId) {
      return {
        key: target.key,
        status: "drifted",
        verification: "present",
        reason: "The item is not owned by this package, so it was not removed.",
      };
    }
    const location = capabilityLocation(target.locationId!)!;
    const current = await installedDigest(location, directory, entry);
    if (current !== ownership.digest && !target.force) {
      return {
        key: target.key,
        status: "drifted",
        verification: "present",
        reason: "The item has local changes, so it was kept; choose keep or replace first.",
      };
    }
    await removeManagedPath(directory, entry);
    if (layout === "file") {
      const index = await readLocationIndex(directory);
      delete index.files[entry];
      await writeLocationIndex(directory, index);
    }
    this.forget(target);
    return { key: target.key, status: "ready", verification: "requested" };
  }

  private async applyMcp(target: NodePlanTarget, managedBefore: boolean): Promise<NodePlanResult> {
    if (!this.deps.mcp || !target.provider) {
      return {
        key: target.key,
        status: "unsupported",
        verification: "requested",
        reason: "MCP management is not available on this machine.",
      };
    }
    if (target.action === "remove") {
      if (!managedBefore) {
        return {
          key: target.key,
          status: "drifted",
          verification: "requested",
          reason: "This MCP server was not added by Orkestrator, so it was not removed.",
        };
      }
      const removed = await this.deps.mcp.remove({
        provider: target.provider,
        name: target.pathOrKey,
        requestId: target.key,
      });
      if (removed.status === "ready") this.forget(target);
      return {
        key: target.key,
        status: removed.status,
        verification: "requested",
        ...(removed.reason ? { reason: removed.reason } : {}),
      };
    }
    if (!target.artifactDigest)
      throw new CapabilityError("invalid-request", "The plan names no artifact.");
    const files = await this.deps.artifacts.get(target.artifactDigest);
    const warnings: string[] = [];
    const definitions = [".mcp.json", "mcp.json"]
      .map((name) => files.find((file) => file.path === name))
      .filter((file): file is PackageFile => Boolean(file))
      .flatMap((file) => {
        try {
          return parseMcpDefinitions(JSON.parse(file.content.toString("utf8")), warnings);
        } catch {
          return [];
        }
      });
    const definition = definitions.find((entry) => entry.name === target.pathOrKey);
    if (!definition)
      throw new CapabilityError("not-found", "The MCP server is not in the artifact.");
    if (definition.envKeys.length > 0 || definition.headerKeys.length > 0) {
      return {
        key: target.key,
        status: "needs-auth",
        verification: "requested",
        reason: `Needs ${[...definition.envKeys, ...definition.headerKeys].join(", ")} on this machine. Add the server in MCP servers settings with your own values; Orkestrator never copies credentials between machines.`,
      };
    }
    const result = await this.deps.mcp.install({
      provider: target.provider,
      name: definition.name,
      definition: {
        transport: definition.transport,
        ...(definition.command ? { command: definition.command } : {}),
        ...(definition.args ? { args: definition.args } : {}),
        ...(definition.url ? { url: definition.url } : {}),
      },
      requestId: target.key,
    });
    if (result.status === "installed-next-session" || result.status === "ready") {
      this.record(target, target.artifactDigest);
    }
    return {
      key: target.key,
      status: result.status,
      verification: result.status === "ready" ? "enabled" : "present",
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  private async applyPlugin(target: NodePlanTarget): Promise<NodePlanResult> {
    const provider = target.provider;
    if (provider !== "claude" || !target.qualifiedId) {
      const support = describeCapabilitySupport(provider ?? "claude", { location: "host" });
      return {
        key: target.key,
        status: "unsupported",
        verification: "requested",
        reason:
          provider === "claude"
            ? "Claude plugins are installed from a marketplace; this package's skills and commands are delivered individually instead."
            : (support.kinds["native-plugin"].install.reason ??
              "Native plugins are not supported for this provider."),
      };
    }
    if (!this.deps.pluginCli) {
      return {
        key: target.key,
        status: "unsupported",
        verification: "requested",
        reason: "The Claude CLI is not available on this machine.",
      };
    }
    if (!/^[@A-Za-z0-9][@A-Za-z0-9._/-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target.qualifiedId)) {
      throw new CapabilityError("invalid-request", "Not a plugin id.");
    }
    try {
      if (target.action === "remove") {
        await this.deps.pluginCli("claude", ["plugin", "uninstall", target.qualifiedId]);
        this.forget(target);
        return { key: target.key, status: "ready", verification: "requested" };
      }
      await this.deps.pluginCli("claude", ["plugin", "install", target.qualifiedId]);
      this.record(target, target.artifactDigest ?? target.qualifiedId);
      return { key: target.key, status: "installed-next-session", verification: "enabled" };
    } catch (error) {
      return {
        key: target.key,
        status: "failed",
        verification: "requested",
        reason: `Claude could not ${target.action === "remove" ? "uninstall" : "install"} ${target.qualifiedId}. ${boundedReason(error)}`,
      };
    }
  }

  private installedStatus(target: NodePlanTarget): CapabilityTargetStatus {
    // A copy is never `ready` on its own: runtime evidence upgrades it.
    return target.kind === "mcp-server" ? "installed-next-session" : "installed-next-session";
  }

  private verification(target: NodePlanTarget): CapabilityVerificationLevel | "unverified" {
    const location = target.locationId ? capabilityLocation(target.locationId) : undefined;
    const owner = location?.owner;
    const provider = owner && owner !== "shared" ? owner : undefined;
    if (!provider) return "present";
    const matrix = describeCapabilitySupport(provider, { location: "host" });
    return maxVerificationLevel(matrix, target.kind) === "present" ? "unverified" : "present";
  }

  private record(target: NodePlanTarget, digest: string): void {
    this.deps.storage.capabilities.mutateCapabilityExecutorState((state) => {
      state.applied[target.key] = { digest, at: this.now(), action: target.action };
    });
  }

  private forget(target: NodePlanTarget): void {
    this.deps.storage.capabilities.mutateCapabilityExecutorState((state) => {
      delete state.applied[target.key];
    });
  }
}
