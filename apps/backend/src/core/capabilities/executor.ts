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
 * revisions and locks the MCP servers settings use). Claude plugins are
 * installed from the approved artifact through Orkestrator's own Claude
 * marketplace (`provider-adapters/claude-plugins.ts`); other providers'
 * plugins are unsupported.
 */
import { beginCapabilityWrite, RUNNING_WORK_HOLD_REASON } from "./running-work.js";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
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
  type CapabilityLocation,
} from "@orkestrator/protocol/capability-resources-support";

import type { CapabilityArtifactStore } from "./artifact-store.js";
import {
  installedComponentFiles,
  installName,
  installedDigest,
  locationDirectory,
  readMarker,
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
  recoverDirectoryReplacement,
  assertCapabilityDirectory,
  treeDigest,
  writeFileAtomically,
  type PackageFile,
} from "./security.js";
import {
  assertDistributableArtifact,
  parseMcpDefinitions,
  type McpDefinitionShape,
} from "./source-inspection.js";
import type { CapabilitiesStorage } from "../storage/index.js";
import {
  CLAUDE_PLUGIN_MANIFEST,
  type ClaudePluginAdapter,
} from "./provider-adapters/claude-plugins.js";

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
  /**
   * A local variant's install: it may take over a copy owned by the package
   * it was derived from (`CapabilityPackage.derivedFrom`), and nothing else.
   */
  takeoverFrom?: string;
}

export interface NodePlanResult {
  key: string;
  status: CapabilityTargetStatus;
  verification: CapabilityVerificationLevel | "unverified";
  digest?: string;
  reason?: string;
  replayed?: boolean;
}

type McpOwnership = import("./types.js").CapabilityMcpOwnership;

/** Writes and removes MCP definitions in one provider's user configuration. */
export interface McpInstaller {
  configured?(provider: AgentPlatform, definition: McpDefinitionShape): Promise<boolean>;
  effective?(ownership: McpOwnership): Promise<boolean>;
  observe?(ownership: McpOwnership): Promise<"present" | "missing" | "drifted" | "unavailable">;
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
    previous?: McpOwnership;
    force?: boolean;
  }): Promise<{ status: CapabilityTargetStatus; reason?: string; ownership?: McpOwnership }>;
  remove(input: {
    provider: AgentPlatform;
    name: string;
    requestId: string;
    previous: McpOwnership;
  }): Promise<{
    status: CapabilityTargetStatus;
    reason?: string;
  }>;
}

class RunningWorkHold extends Error {}

export function queuedCapabilityWrite(target: NodePlanTarget): NodePlanResult {
  return {
    key: target.key,
    status: "queued-until-idle",
    verification: "requested",
    reason: RUNNING_WORK_HOLD_REASON,
  };
}

export interface CapabilityExecutorDeps {
  busyProviders?: () => Promise<readonly AgentPlatform[]>;
  writeHeld?: () => Promise<boolean>;
  storage: { capabilities: CapabilitiesStorage };
  artifacts: CapabilityArtifactStore;
  homes: () => CapabilityHomes;
  /**
   * A scoped writer's locations (`scoped-delivery.ts`): a worktree's project
   * directories or an account's private directory, resolved by this machine.
   * Absent: the machine-wide location table under `homes`.
   */
  locate?: (locationId: string) => { location: CapabilityLocation; directory: string } | undefined;
  mcp?: McpInstaller;
  /** Claude plugins through Orkestrator's own marketplace (`provider-adapters/claude-plugins.ts`). */
  claudePlugins?: ClaudePluginAdapter;
  now?: () => string;
  /** A graph's disposable worktree is owned by the activation lifecycle. */
  recordApplied?: boolean;
}

/**
 * Plan entries are untrusted input from a peer: validate every field.
 * `isLocation` names the locations the plan may write: the machine-wide
 * table by default, a worktree's project directories for a scoped plan.
 */
export function parseNodePlanTargets(
  value: unknown,
  isLocation: (locationId: string) => boolean = (id) => capabilityLocation(id) !== undefined,
): NodePlanTarget[] {
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
    if (locationId && !isLocation(locationId)) {
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
    const provider = raw.provider;
    if (provider !== undefined && !isAgentPlatform(provider)) {
      throw new CapabilityError("invalid-request", "Plan provider is not valid.");
    }
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
      ...(optional("takeoverFrom") ? { takeoverFrom: optional("takeoverFrom")! } : {}),
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

/** Checks a request's authority without accepting its epoch. */
export function assertAdmissibleExecutorEpoch(
  state: Pick<import("./types.js").CapabilityExecutorState, "epoch" | "controllerId">,
  controllerId: string,
  epoch: number,
): void {
  if (!Number.isInteger(epoch) || epoch < 1) {
    throw new CapabilityError("invalid-request", "The plan carries no valid epoch.");
  }
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
    const settled = next.catch(() => undefined);
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return next;
  }

  /**
   * Accepts `epoch` from `controllerId` when it is not older than the one
   * already seen. A handover raises the epoch; the previous controller's
   * calls are then refused, so two authorities never write here.
   */
  admitEpoch(controllerId: string, epoch: number): void {
    this.deps.storage.capabilities.mutateCapabilityExecutorState((state) => {
      assertAdmissibleExecutorEpoch(state, controllerId, epoch);
      state.epoch = epoch;
      state.controllerId = controllerId;
    });
  }

  async assertEpoch(controllerId: string, epoch: number): Promise<void> {
    const current = await this.deps.storage.capabilities.loadCapabilityExecutorState();
    if (current.controllerId !== controllerId || current.epoch !== epoch) {
      throw new CapabilityError(
        "stale-epoch",
        "This machine's command authority changed before the plan could write.",
      );
    }
  }

  async apply(
    targets: readonly NodePlanTarget[],
    fence?: () => Promise<void>,
  ): Promise<NodePlanResult[]> {
    const results: NodePlanResult[] = [];
    for (const target of targets) {
      const lockKey = target.locationId ?? `${target.kind}:${target.provider ?? ""}`;
      const readers = this.deps.locate
        ? (this.deps.locate(target.locationId ?? "")?.location.readBy ??
          (target.provider ? [target.provider] : []))
        : (capabilityLocation(target.locationId ?? "")?.readBy ??
          (target.provider ? [target.provider] : []));
      const checkWrite = async () => {
        await fence?.();
        if (await this.deps.writeHeld?.().catch(() => true)) throw new RunningWorkHold();
        if (!this.deps.busyProviders) return;
        const busy = await this.deps.busyProviders().catch(() => readers);
        if (readers.some((reader) => busy.includes(reader))) throw new RunningWorkHold();
      };
      results.push(
        await this.withLock(lockKey, async () => {
          const finish = beginCapabilityWrite(readers);
          if (!finish) return queuedCapabilityWrite(target);
          try {
            return await this.applyOne(target, checkWrite);
          } catch (error) {
            return error instanceof RunningWorkHold
              ? queuedCapabilityWrite(target)
              : {
                  key: target.key,
                  status: "failed",
                  verification: "requested",
                  reason: boundedReason(error),
                };
          } finally {
            finish();
          }
        }),
      );
    }
    return results;
  }

  private locate(locationId: string): {
    location: CapabilityLocation;
    directory: string;
    isolationRoot?: string;
  } {
    if (this.deps.locate) {
      const located = this.deps.locate(locationId);
      if (!located) throw new CapabilityError("invalid-request", "Unknown capability location.");
      return located;
    }
    const location = capabilityLocation(locationId);
    if (!location) throw new CapabilityError("invalid-request", "Unknown capability location.");
    const homes = this.deps.homes();
    return {
      location,
      directory: locationDirectory(location.id, homes),
      isolationRoot: homes.isolationRoot,
    };
  }

  private async applyOne(
    target: NodePlanTarget,
    fence?: () => Promise<void>,
  ): Promise<NodePlanResult> {
    await fence?.();
    const executor = await this.deps.storage.capabilities.loadCapabilityExecutorState();
    const previous = executor.applied[target.key];
    if (target.kind === "mcp-server") return this.applyMcp(target, previous, fence);
    if (target.kind === "native-plugin")
      return this.applyPlugin(target, previous !== undefined, fence);
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
    const { location, directory, isolationRoot } = this.locate(target.locationId);
    const name = installName(target.componentName, target.pathOrKey, location.layout);
    const entry = location.layout === "file" ? `${name}.md` : name;
    if (location.layout === "directory") recoverDirectoryReplacement(path.join(directory, entry));

    if (target.action === "remove")
      return this.removeFileComponent(target, location, directory, entry, isolationRoot, fence);

    if (!target.artifactDigest)
      throw new CapabilityError("invalid-request", "The plan names no artifact.");
    const artifact = await this.deps.artifacts.get(target.artifactDigest);
    assertDistributableArtifact(artifact);
    const files = componentFiles(artifact, target);
    if (files.length === 0)
      throw new CapabilityError("not-found", "The component is not in the artifact.");
    const writtenFiles = installedComponentFiles(files, location.layout, entry);
    const digest = treeDigest(writtenFiles);

    const ownership = await this.ownership(location.layout, directory, entry, isolationRoot);
    if (
      previous?.digest === digest &&
      ownership.kind === "managed" &&
      ownership.packageId === target.packageId &&
      ownership.componentId === target.componentId &&
      ownership.digest === digest
    ) {
      const current = await installedDigest(location, directory, entry, { isolationRoot });
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

    // Adoption: the user chose to manage an external item whose bytes are exactly the package's.
    const adopting =
      ownership.kind === "external" &&
      target.force === true &&
      (await installedDigest(location, directory, entry, { isolationRoot })) === digest;
    if (ownership.kind === "external" && !adopting) {
      return {
        key: target.key,
        status: "drifted",
        verification: "requested",
        reason: `An item named ${name} that Orkestrator does not manage is already in ${location.label}. Adopt it or rename the component; it was left untouched.`,
      };
    }
    if (ownership.kind === "managed") {
      const takingOver =
        target.takeoverFrom !== undefined && ownership.packageId === target.takeoverFrom;
      if (
        (ownership.packageId !== target.packageId && !takingOver) ||
        (ownership.packageId === target.packageId && ownership.componentId !== target.componentId)
      ) {
        return {
          key: target.key,
          status: "failed",
          verification: "requested",
          reason: `${name} in ${location.label} belongs to another package; the two components collide.`,
        };
      }
      const current = await installedDigest(location, directory, entry, {
        recordedDigest: ownership.digest,
        isolationRoot,
      });
      if (current !== null && current !== ownership.digest && current !== digest && !target.force) {
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
    await fence?.();
    if (location.layout === "directory") {
      await replaceDirectoryAtomically(
        path.join(directory, entry),
        writtenFiles,
        [{ path: CAPABILITY_MARKER_FILE, content: markerContent(marker) }],
        isolationRoot,
      );
    } else {
      const index = await readLocationIndex(directory, { isolationRoot });
      const indexed = Object.hasOwn(index.files, entry);
      if (!indexed) {
        // Publish ownership before new bytes can be seen by portable-input copying.
        index.files[entry] = marker;
        await writeLocationIndex(directory, index, isolationRoot);
      }
      try {
        await writeFileAtomically(
          path.join(directory, entry),
          writtenFiles[0]!.content,
          0o644,
          isolationRoot,
        );
      } catch (error) {
        if (!indexed) {
          delete index.files[entry];
          await writeLocationIndex(directory, index, isolationRoot).catch(() => undefined);
        }
        throw error;
      }
      if (indexed) {
        index.files[entry] = marker;
        await writeLocationIndex(directory, index, isolationRoot);
      }
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
    isolationRoot?: string,
  ): Promise<
    | { kind: "absent" }
    | { kind: "external" }
    | { kind: "managed"; packageId: string; componentId: string; digest: string }
  > {
    assertCapabilityDirectory(directory, isolationRoot);
    const exists = await fs
      .lstat(path.join(directory, entry))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (!exists) return { kind: "absent" };
    if (
      (layout === "directory" && !exists.isDirectory()) ||
      (layout === "file" && !exists.isFile())
    )
      return { kind: "external" };
    if (layout === "directory") {
      if (isolationRoot) {
        const item = path.join(directory, entry);
        assertCapabilityDirectory(item, isolationRoot);
        const marker = await readMarker(path.join(item, CAPABILITY_MARKER_FILE));
        return marker ? { kind: "managed", ...marker } : { kind: "external" };
      }
      try {
        const marker = JSON.parse(
          await fs.readFile(path.join(directory, entry, CAPABILITY_MARKER_FILE), "utf8"),
        ) as { packageId?: unknown; componentId?: unknown; digest?: unknown };
        if (
          typeof marker.packageId === "string" &&
          typeof marker.componentId === "string" &&
          typeof marker.digest === "string"
        ) {
          return {
            kind: "managed",
            packageId: marker.packageId,
            componentId: marker.componentId,
            digest: marker.digest,
          };
        }
      } catch {
        // no marker: external
      }
      return { kind: "external" };
    }
    const index = await readLocationIndex(directory, { isolationRoot });
    const managed = index.files[entry];
    return managed
      ? {
          kind: "managed",
          packageId: managed.packageId,
          componentId: managed.componentId,
          digest: managed.digest,
        }
      : { kind: "external" };
  }

  private async removeFileComponent(
    target: NodePlanTarget,
    location: CapabilityLocation,
    directory: string,
    entry: string,
    isolationRoot?: string,
    fence?: () => Promise<void>,
  ): Promise<NodePlanResult> {
    const { layout } = location;
    const ownership = await this.ownership(layout, directory, entry, isolationRoot);
    if (ownership.kind === "absent") {
      this.forget(target);
      return {
        key: target.key,
        status: "ready",
        verification: "requested",
        reason: "Already removed.",
      };
    }
    if (ownership.kind === "external") {
      return {
        key: target.key,
        status: "drifted",
        verification: "present",
        reason: "The item is not owned by this package, so it was not removed.",
      };
    }
    if (ownership.packageId !== target.packageId || ownership.componentId !== target.componentId) {
      // This component no longer owns the copy at this path.
      this.forget(target);
      return {
        key: target.key,
        status: "ready",
        verification: "requested",
        reason: "Another component now manages this item; it was left in place.",
      };
    }
    const current = await installedDigest(location, directory, entry, {
      recordedDigest: ownership.digest,
      isolationRoot,
    });
    if (current !== ownership.digest && !target.force) {
      return {
        key: target.key,
        status: "drifted",
        verification: "present",
        reason: "The item has local changes, so it was kept; choose keep or replace first.",
      };
    }
    await fence?.();
    await removeManagedPath(directory, entry, isolationRoot);
    if (layout === "file") {
      const index = await readLocationIndex(directory, { isolationRoot });
      delete index.files[entry];
      await writeLocationIndex(directory, index, isolationRoot);
    }
    this.forget(target);
    return { key: target.key, status: "ready", verification: "requested" };
  }

  private async applyMcp(
    target: NodePlanTarget,
    previous: import("./types.js").CapabilityExecutorState["applied"][string] | undefined,
    fence?: () => Promise<void>,
  ): Promise<NodePlanResult> {
    if (!this.deps.mcp || !target.provider) {
      return {
        key: target.key,
        status: "unsupported",
        verification: "requested",
        reason: "MCP management is not available on this machine.",
      };
    }
    if (target.action === "remove") {
      if (previous?.externalMcp) {
        await fence?.();
        this.forget(target);
        return { key: target.key, status: "ready", verification: "requested" };
      }
      if (!previous?.mcp) {
        return {
          key: target.key,
          status: "drifted",
          verification: "requested",
          reason: "This MCP server was not added by Orkestrator, so it was not removed.",
        };
      }
      await fence?.();
      const removed = await this.deps.mcp.remove({
        provider: target.provider,
        name: previous.mcp.name,
        requestId: `${target.key}:${previous.digest}`,
        previous: previous.mcp,
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
    assertDistributableArtifact(files);
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
      if (await this.deps.mcp.configured?.(target.provider, definition)) {
        await fence?.();
        this.deps.storage.capabilities.mutateCapabilityExecutorState((state) => {
          state.applied[target.key] = {
            digest: target.artifactDigest!,
            at: this.now(),
            action: target.action,
            packageId: target.packageId,
            componentId: target.componentId,
            externalMcp: { provider: target.provider!, definition },
          };
        });
        return {
          key: target.key,
          status: "installed-next-session",
          verification: "present",
          digest: target.artifactDigest,
          reason: "A matching local configuration supplies the required credentials.",
        };
      }
      return {
        key: target.key,
        status: "needs-auth",
        verification: "requested",
        reason: `Needs ${[...definition.envKeys, ...definition.headerKeys].join(", ")} on this machine. Add the server in MCP servers settings with your own values; Orkestrator never copies credentials between machines.`,
      };
    }
    if (
      previous?.mcp &&
      previous.digest === target.artifactDigest &&
      !target.force &&
      (await this.deps.mcp.observe?.(previous.mcp)) === "present"
    ) {
      return {
        key: target.key,
        status: "installed-next-session",
        verification: "enabled",
        digest: target.artifactDigest,
        replayed: true,
      };
    }
    await fence?.();
    const result = await this.deps.mcp.install({
      provider: target.provider,
      name: definition.name,
      definition: {
        transport: definition.transport,
        ...(definition.command ? { command: definition.command } : {}),
        ...(definition.args ? { args: definition.args } : {}),
        ...(definition.url ? { url: definition.url } : {}),
      },
      requestId: `${target.key}:${target.artifactDigest}`,
      ...(previous?.mcp ? { previous: previous.mcp } : {}),
      ...(target.force ? { force: true } : {}),
    });
    const installed = result.status === "installed-next-session" || result.status === "ready";
    if (installed) this.record(target, target.artifactDigest, result.ownership);
    return {
      key: target.key,
      status: result.status,
      verification: result.status === "ready" ? "enabled" : "present",
      ...(installed ? { digest: target.artifactDigest } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  /** Claude plugins from the approved artifact; every other provider's plugins are unsupported. */
  private async applyPlugin(
    target: NodePlanTarget,
    managedBefore: boolean,
    fence?: () => Promise<void>,
  ): Promise<NodePlanResult> {
    const adapter = this.deps.claudePlugins;
    if (target.provider !== "claude" || !adapter) {
      const support = describeCapabilitySupport(target.provider ?? "claude", { location: "host" });
      return {
        key: target.key,
        status: "unsupported",
        verification: "requested",
        reason: !adapter
          ? "Claude plugin delivery is not available on this machine."
          : (support.kinds["native-plugin"].install.reason ??
            "Native plugins are not supported for this provider."),
      };
    }
    if (target.action === "remove") {
      await fence?.();
      const removed = await adapter.remove({
        packageId: target.packageId,
        componentId: target.componentId,
        ...(target.force ? { force: true } : {}),
      });
      if (removed.status === "ready" || !managedBefore) this.forget(target);
      return { key: target.key, ...removed };
    }
    if (target.pathOrKey !== CLAUDE_PLUGIN_MANIFEST || !target.artifactDigest) {
      return {
        key: target.key,
        status: "unsupported",
        verification: "requested",
        reason:
          "Claude resolves marketplace plugins from a mutable source; add the plugin from its repository so Orkestrator can review and pin its bytes.",
      };
    }
    const files = await this.deps.artifacts.get(target.artifactDigest);
    assertDistributableArtifact(files);
    await fence?.();
    const result = await adapter.install({
      packageId: target.packageId,
      componentId: target.componentId,
      files,
      ...(target.force ? { force: true } : {}),
    });
    if (result.status === "installed-next-session" && result.digest) {
      this.record(target, result.digest);
    }
    const { adopted: _adopted, ...answer } = result;
    return { key: target.key, ...answer };
  }

  private installedStatus(target: NodePlanTarget): CapabilityTargetStatus {
    // A copy is never `ready` on its own: runtime evidence upgrades it.
    return target.kind === "mcp-server" ? "installed-next-session" : "installed-next-session";
  }

  private verification(target: NodePlanTarget): CapabilityVerificationLevel | "unverified" {
    const location = target.locationId
      ? (this.deps.locate?.(target.locationId)?.location ?? capabilityLocation(target.locationId))
      : undefined;
    const owner = location?.owner;
    const provider = owner && owner !== "shared" ? owner : undefined;
    if (!provider) return "present";
    const matrix = describeCapabilitySupport(provider, { location: "host" });
    return maxVerificationLevel(matrix, target.kind) === "present" ? "unverified" : "present";
  }

  private record(target: NodePlanTarget, digest: string, mcp?: McpOwnership): void {
    if (this.deps.recordApplied === false) return;
    this.deps.storage.capabilities.mutateCapabilityExecutorState((state) => {
      state.applied[target.key] = {
        digest,
        at: this.now(),
        action: target.action,
        ...(mcp ? { mcp, packageId: target.packageId, componentId: target.componentId } : {}),
      };
    });
  }

  private forget(target: NodePlanTarget): void {
    this.deps.storage.capabilities.mutateCapabilityExecutorState((state) => {
      delete state.applied[target.key];
    });
  }
}
