/**
 * Environment overlays at runtime: where the pure rules in `overlay.ts` meet
 * the container, the durable record and the backend user's files.
 *
 * Every write into a container goes through the injected
 * {@link ContainerFileWriter}: a fixed program, a path from the backend's own
 * source specs, the payload on stdin, compare-and-swap on the bytes the change
 * was prepared against. Edits record their intent before writing the container
 * file and roll back on rejection. Boot materialisation already has durable
 * intent; its success fingerprint and boot stamp are committed after the write
 * succeeds, so a failed attempt stays retryable.
 */

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  mcpFailure,
  type McpConfigSource,
  type McpDefaultsRefreshPreview,
  type McpEnvironmentOverlayState,
  type McpOverlayAction,
  type McpOverlayResolutionResult,
} from "@orkestrator/protocol/mcp-management";

import type { LoadedSource } from "./catalog.js";
import { parseSource } from "./document.js";
import {
  entriesOf,
  expectedEntries,
  importCurrent,
  newOverlayRecord,
  observeOverlay,
  ownEntry,
  overlayDigester,
  publicOverlayState,
  rebaseOverlay,
  recordEdit,
  rewriteServerMap,
  type Digest,
  type OverlayObservation,
  type OverlayRecord,
} from "./overlay.js";
import { McpOverlayStore } from "./overlay-store.js";
import { ABSENT_REVISION, type McpSourceStore } from "./source-store.js";
import type {
  ContainerBootReader,
  ContainerFileWriteResult,
  ContainerFileWriter,
  NativeEntry,
  SourceSpec,
} from "./types.js";

/** Keeps the inherited staged copy in step after a defaults refresh. */
export interface StagedDefaultsWriter {
  /**
   * Rewrite the staged input the container's entrypoint copies `sourceId`
   * from, so its next boot inherits the refreshed servers. `rewrite` gets the
   * staged text (`""` when absent) and returns the new text.
   */
  update(
    environmentId: string,
    containerId: string,
    sourceId: string,
    rewrite: (text: string) => string,
  ): Promise<"updated" | "unavailable" | "not-needed">;
}

export interface OverlayDependencies {
  dataDir: string;
  store: McpSourceStore;
  now: () => number;
  writeContainerFile?: ContainerFileWriter;
  readBootId?: ContainerBootReader;
  stagedDefaults?: StagedDefaultsWriter;
}

/** What one container source needs for an overlay operation. */
export interface OverlaySourceContext {
  environmentId: string;
  containerId: string;
  provider: AgentPlatform;
  source: LoadedSource;
}

export const OVERLAY_DIVERGED_REASON =
  "This file was edited inside the container after Orkestrator last wrote it. Import those edits or reapply this environment's configuration before changing it here.";

export const OVERLAY_UNREADABLE_REASON =
  "This environment's saved MCP changes for this file could not be read. Nothing was changed; reset this environment's changes to start again.";

/** Overlay-backed sources: the container copies the entrypoint makes from the backend user. */
export function isOverlaySpec(spec: SourceSpec): boolean {
  return !!spec.container && spec.owner === "environment-overlay";
}

function writeFailure(result: ContainerFileWriteResult): Error {
  switch (result.state) {
    case "conflict":
      return mcpFailure("revision-conflict", {
        message: "The file changed inside the container while saving; reload and try again.",
      });
    case "refused":
      return mcpFailure("read-only-source", {
        message:
          "The container's copy of this file is a symlink or not a regular file, so Orkestrator will not write it.",
      });
    case "oversized":
      return mcpFailure("oversized-source");
    case "offline":
      return mcpFailure("target-offline", {
        message: "The container is not running; start it to change its configuration.",
      });
    default:
      return mcpFailure("internal", { message: "The container did not accept the write." });
  }
}

export class EnvironmentOverlays {
  readonly records: McpOverlayStore;

  constructor(private readonly deps: OverlayDependencies) {
    this.records = new McpOverlayStore(deps.dataDir);
  }

  /** Whether this backend can write into containers at all. */
  get writable(): boolean {
    return !!this.deps.writeContainerFile;
  }

  /** Lock identity for every write to one container source. */
  lockPath(environmentId: string, sourceId: string): string {
    return this.records.recordPath(environmentId, sourceId);
  }

  private async digest(): Promise<Digest> {
    return overlayDigester(await this.deps.store.secretKey());
  }

  private nowIso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  private async bootId(containerId: string): Promise<string | null> {
    if (!this.deps.readBootId) return null;
    return this.deps.readBootId(containerId).catch(() => null);
  }

  private async write(context: OverlaySourceContext, nextText: string): Promise<string> {
    const writer = this.deps.writeContainerFile;
    if (!writer) throw mcpFailure("read-only-source");
    const file = context.source.file;
    const expectedDigest =
      !file || file.state === "absent" ? ABSENT_REVISION : (file.contentDigest ?? "");
    if (!expectedDigest) throw mcpFailure("revision-conflict");
    const bytes = new TextEncoder().encode(nextText);
    const result = await writer(context.containerId, context.source.spec.path, {
      expectedDigest,
      bytes,
      mode: isOverlaySpec(context.source.spec) ? "private" : "preserve",
    });
    if (result.state !== "ok") throw writeFailure(result);
    return this.deps.store.revisionOf(bytes);
  }

  private entries(source: LoadedSource): Record<string, NativeEntry> {
    if (source.state === "absent") return {};
    if (!source.parsed) throw mcpFailure("malformed-source", { message: source.error });
    return entriesOf(source.parsed);
  }

  private async load(environmentId: string, sourceId: string): Promise<OverlayRecord | null> {
    const read = await this.records.read(environmentId, sourceId);
    if (read.state === "corrupt")
      throw mcpFailure("internal", { message: OVERLAY_UNREADABLE_REASON });
    return read.state === "ok" ? read.record : null;
  }

  /**
   * The public overlay state of one loaded container source, and the reason
   * edits are blocked, if they are. Read-only: a pending boot is reported,
   * not written.
   */
  async observe(context: OverlaySourceContext): Promise<{
    overlay?: McpEnvironmentOverlayState;
    writeBlock?: string;
  }> {
    const read = await this.records.read(context.environmentId, context.source.spec.sourceId);
    if (read.state === "corrupt")
      return {
        writeBlock: OVERLAY_UNREADABLE_REASON,
        overlay: {
          revision: 0,
          state: "corrupt",
          added: [],
          replaced: [],
          removed: [],
          conflicts: [],
          divergedNames: [],
        },
      };
    if (read.state === "absent") return {};
    let observation: OverlayObservation | null = null;
    if (context.source.state === "ok" || context.source.state === "absent") {
      try {
        observation = observeOverlay(
          read.record,
          this.entries(context.source),
          await this.bootId(context.containerId),
          await this.digest(),
        );
      } catch {
        observation = null;
      }
    }
    return {
      overlay: publicOverlayState(read.record, observation),
      writeBlock: observation?.kind === "diverged" ? OVERLAY_DIVERGED_REASON : undefined,
    };
  }

  /**
   * Before a save: a container restarted outside the start path holds the
   * inherited copy again, so rebase and write the overlay first. Returns
   * whether anything was written (the caller then re-reads the file).
   */
  async settle(context: OverlaySourceContext): Promise<boolean> {
    if (!isOverlaySpec(context.source.spec)) return false;
    const record = await this.load(context.environmentId, context.source.spec.sourceId);
    if (!record) return false;
    const digest = await this.digest();
    const bootId = await this.bootId(context.containerId);
    const current = this.entries(context.source);
    const observation = observeOverlay(record, current, bootId, digest);
    if (observation.kind !== "pending") return false;
    await this.materialiseOne(context, record, bootId, digest);
    return true;
  }

  /**
   * Save one prepared edit into the container: record the intent (overlay
   * sources only), then write the file. Refuses a diverged file.
   */
  async commitEdit(
    context: OverlaySourceContext,
    nextText: string,
    names: readonly string[],
  ): Promise<string> {
    const { source } = context;
    if (!isOverlaySpec(source.spec)) return this.write(context, nextText);
    const digest = await this.digest();
    const bootId = await this.bootId(context.containerId);
    const current = this.entries(source);
    const previous = await this.load(context.environmentId, source.spec.sourceId);
    const record =
      previous ??
      newOverlayRecord(
        {
          environmentId: context.environmentId,
          provider: context.provider,
          sourceId: source.spec.sourceId,
          baseline: current,
          bootId,
          now: this.nowIso(),
        },
        digest,
      );
    if (previous) {
      const observation = observeOverlay(previous, current, bootId, digest);
      if (observation.kind === "diverged") throw mcpFailure("environment-diverged");
      if (observation.kind === "pending") throw mcpFailure("revision-conflict");
    }
    const after = entriesOf(parseSource(source.spec, nextText));
    const now = this.nowIso();
    const next: OverlayRecord = {
      ...recordEdit(record, names, after, digest),
      revision: record.revision + 1,
      materialisedFingerprint: digest(after),
      materialisedBootId: bootId,
      materialisedAt: now,
      updatedAt: now,
    };
    await this.records.write(next);
    try {
      return await this.write(context, nextText);
    } catch (error) {
      // Nothing reached the container: put the previous intent back.
      if (previous) await this.records.write(previous).catch(() => undefined);
      else await this.records.remove(context.environmentId, source.spec.sourceId);
      throw error;
    }
  }

  /**
   * Rebase one record on the file the container holds now and write the
   * expected server map back. Conflicting names keep their inherited value.
   */
  private async materialiseOne(
    context: OverlaySourceContext,
    record: OverlayRecord,
    bootId: string | null,
    digest: Digest,
  ): Promise<OverlayRecord> {
    const { source } = context;
    const text = source.state === "absent" ? "" : (source.file?.text ?? "");
    const current = this.entries(source);
    // A missing staged input leaves the previous output intact on restart.
    // Matching our last verified output is no evidence of a new baseline.
    const rebased =
      digest(current) === record.materialisedFingerprint
        ? record
        : rebaseOverlay(record, current, digest);
    const expected = expectedEntries(rebased);
    const now = this.nowIso();
    const next: OverlayRecord = {
      ...rebased,
      revision: record.revision + 1,
      materialisedFingerprint: digest(expected),
      materialisedBootId: bootId,
      materialisedAt: now,
      updatedAt: now,
    };
    // Leave the old boot stamp retryable until the container accepts the write.
    if (digest(expected) !== digest(current)) {
      await this.write(context, rewriteServerMap(source.spec, text, expected));
    }
    await this.records.write(next);
    return next;
  }

  /**
   * After a container boot: reapply every recorded overlay of the
   * environment over the fresh inherited copies. Per source and best effort;
   * a failure is logged by code and reported later as `pending` or a
   * conflict, never as a failed start.
   */
  async materialiseEnvironment(
    environmentId: string,
    containerId: string,
    loadSource: (provider: AgentPlatform, sourceId: string) => Promise<LoadedSource | null>,
  ): Promise<number> {
    if (!this.writable || !(await this.records.hasAny(environmentId))) return 0;
    const digest = await this.digest();
    const bootId = await this.bootId(containerId);
    let written = 0;
    for (const sourceId of await this.records.sourceIds(environmentId)) {
      try {
        written += await this.deps.store.withLock(
          this.lockPath(environmentId, sourceId),
          async () => {
            const record = await this.load(environmentId, sourceId);
            if (!record) return 0;
            const source = await loadSource(record.provider, sourceId);
            if (!source || !isOverlaySpec(source.spec)) return 0;
            if (source.state !== "ok" && source.state !== "absent") return 0;
            // Already written for this boot: anything different now is an
            // in-container edit, which only the user may import or overwrite.
            if (bootId !== null && record.materialisedBootId === bootId) return 0;
            const context = { environmentId, containerId, provider: record.provider, source };
            await this.materialiseOne(context, record, bootId, digest);
            return 1;
          },
        );
      } catch (error) {
        const code = (error as { detail?: { code?: string } }).detail?.code ?? "unexpected";
        console.warn(`[mcp-management] overlay materialise failed: code=${code}`);
      }
    }
    return written;
  }

  /** Import, reapply, resolve a conflict or reset one container source. */
  async resolve(
    context: OverlaySourceContext,
    action: McpOverlayAction,
    inheritedDefaults?: () => Promise<LoadedSource>,
  ): Promise<McpOverlayResolutionResult> {
    const { source } = context;
    if (!isOverlaySpec(source.spec))
      throw mcpFailure("unsupported-operation", {
        message: "Only this environment's own configuration has changes to resolve.",
      });
    const digest = await this.digest();
    const bootId = await this.bootId(context.containerId);
    const current = this.entries(source);
    const text = source.state === "absent" ? "" : (source.file?.text ?? "");
    const read = await this.records.read(context.environmentId, source.spec.sourceId);
    if (read.state === "corrupt") {
      if (action.kind !== "reset" || !inheritedDefaults)
        throw mcpFailure("internal", { message: OVERLAY_UNREADABLE_REASON });
      // An unreadable record cannot supply a trusted baseline. Reset explicitly
      // discards it only after restoring verified defaults from the backend user.
      const host = await inheritedDefaults();
      if (host.state !== "ok" && host.state !== "absent") throw mcpFailure("malformed-source");
      const target = this.entries(host);
      const revision =
        digest(target) === digest(current)
          ? (source.file?.revision ?? null)
          : await this.write(context, rewriteServerMap(source.spec, text, target));
      await this.records.remove(context.environmentId, source.spec.sourceId);
      return { sourceRevision: revision, overlay: null };
    }
    const previous = read.state === "ok" ? read.record : null;
    if (!previous) {
      if (action.kind === "reset")
        return { sourceRevision: source.file?.revision ?? null, overlay: null };
      throw mcpFailure("unsupported-operation", {
        message: "This environment has no changes recorded for this file.",
      });
    }
    const observation = observeOverlay(previous, current, bootId, digest);
    const record =
      observation.kind === "pending" ? rebaseOverlay(previous, current, digest) : previous;
    const now = this.nowIso();
    const stamp = (next: OverlayRecord, materialised: Record<string, NativeEntry>) => ({
      ...next,
      revision: record.revision + 1,
      materialisedFingerprint: digest(materialised),
      materialisedBootId: bootId,
      materialisedAt: now,
      updatedAt: now,
    });
    let next: OverlayRecord;
    let target: Record<string, NativeEntry> | null = null;
    switch (action.kind) {
      case "import":
        if (observation.kind === "pending")
          throw mcpFailure("unsupported-operation", {
            message:
              "The container restarted and holds the inherited copy; reapply this environment's changes instead.",
          });
        next = stamp(importCurrent(record, current, digest), current);
        break;
      case "reapply": {
        // A restart outside the start path is a fresh inherited copy to rebase on;
        // an in-container edit is overwritten by the recorded intent.
        target = expectedEntries(record);
        next = stamp(record, target);
        break;
      }
      case "keep-environment":
      case "take-inherited": {
        if (observation.kind === "diverged") throw mcpFailure("environment-diverged");
        if (ownEntry(record.conflicts, action.name) === undefined)
          throw mcpFailure("unknown-entry", { message: "That name has no conflict to resolve." });
        const resolved: OverlayRecord = {
          ...record,
          changes: { ...record.changes },
          conflicts: { ...record.conflicts },
        };
        delete resolved.conflicts[action.name];
        if (action.kind === "take-inherited") {
          delete resolved.changes[action.name];
        } else {
          const change = resolved.changes[action.name]!;
          const inherited = ownEntry(record.baseline, action.name);
          const base = inherited === undefined ? null : digest(inherited);
          if (change.kind === "set") resolved.changes[action.name] = { ...change, base };
          else if (base === null) delete resolved.changes[action.name];
          else resolved.changes[action.name] = { kind: "remove", base };
        }
        target = expectedEntries(resolved);
        next = stamp(resolved, target);
        break;
      }
      case "reset":
        target = structuredClone(record.baseline);
        next = stamp({ ...record, changes: {}, conflicts: {} }, target);
        break;
    }
    if (target && digest(target) !== digest(current)) {
      // Record first: a write that fails is retried by reapply, never lost.
      await this.records.write(next);
      try {
        const revision = await this.write(context, rewriteServerMap(source.spec, text, target));
        if (action.kind === "reset")
          await this.records.remove(context.environmentId, source.spec.sourceId);
        return {
          sourceRevision: revision,
          overlay: action.kind === "reset" ? null : publicOverlayState(next, { kind: "in-sync" }),
        };
      } catch (error) {
        await this.records.write(previous).catch(() => undefined);
        throw error;
      }
    }
    if (action.kind === "reset") {
      await this.records.remove(context.environmentId, source.spec.sourceId);
      return { sourceRevision: source.file?.revision ?? null, overlay: null };
    }
    await this.records.write(next);
    return {
      sourceRevision: source.file?.revision ?? null,
      overlay: publicOverlayState(next, { kind: "in-sync" }),
    };
  }

  /**
   * What re-importing the backend user's current servers into this container
   * source would do. `host` is the backend user's file for the same source.
   */
  async previewRefresh(
    context: OverlaySourceContext,
    host: LoadedSource,
    targetId: string,
  ): Promise<McpDefaultsRefreshPreview> {
    const plan = await this.planRefresh(context, host);
    return {
      targetId,
      sourceId: context.source.spec.sourceId,
      sourceLabel: context.source.spec.label,
      previewToken: plan.token,
      added: plan.added,
      changed: plan.changed,
      removed: plan.removed,
      conflicts: plan.conflicts,
      diverged: plan.diverged,
      unchanged:
        !plan.added.length &&
        !plan.changed.length &&
        !plan.removed.length &&
        !plan.diverged.length &&
        !plan.pending,
      warnings: plan.warnings,
    };
  }

  private async planRefresh(context: OverlaySourceContext, host: LoadedSource) {
    const { source } = context;
    if (!isOverlaySpec(source.spec))
      throw mcpFailure("unsupported-operation", {
        message: "Only files the container inherits from the backend user can be refreshed.",
      });
    if (host.state !== "ok" && host.state !== "absent")
      throw mcpFailure("malformed-source", {
        message: "The backend user's configuration could not be read, so nothing was refreshed.",
      });
    const digest = await this.digest();
    const bootId = await this.bootId(context.containerId);
    const current = this.entries(source);
    const hostEntries = host.state === "absent" ? {} : entriesOf(host.parsed);
    const record =
      (await this.load(context.environmentId, source.spec.sourceId)) ??
      newOverlayRecord(
        {
          environmentId: context.environmentId,
          provider: context.provider,
          sourceId: source.spec.sourceId,
          baseline: current,
          bootId,
          now: this.nowIso(),
        },
        digest,
      );
    const observation = observeOverlay(record, current, bootId, digest);
    // A pending boot already holds a fresh inherited copy; compare with that.
    const oldBaseline = observation.kind === "pending" ? current : record.baseline;
    const names = new Set([...Object.keys(oldBaseline), ...Object.keys(hostEntries)]);
    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];
    for (const name of names) {
      const before = ownEntry(oldBaseline, name);
      const after = ownEntry(hostEntries, name);
      if (before === undefined && after !== undefined) added.push(name);
      else if (before !== undefined && after === undefined) removed.push(name);
      else if (digest(before) !== digest(after)) changed.push(name);
    }
    const rebased = rebaseOverlay(record, hostEntries, digest);
    const conflicts = Object.entries(rebased.conflicts)
      .map(([name, reason]) => ({ name, reason }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const diverged = observation.kind === "diverged" ? observation.names : [];
    const warnings: string[] = [];
    if (diverged.length)
      warnings.push(
        "Refreshing overwrites the edits made inside the container to the servers listed as edited in the container.",
      );
    if (conflicts.length)
      warnings.push(
        "Conflicting servers keep the refreshed inherited value until you keep this environment's version or take the inherited one.",
      );
    warnings.push(
      "Only the server list is refreshed; other settings in the container's copy are unchanged, and running sessions pick the change up as they would any save.",
    );
    const token = digest({
      kind: "defaults-refresh",
      environmentId: context.environmentId,
      sourceId: source.spec.sourceId,
      container: source.file?.revision ?? null,
      host: host.file?.revision ?? null,
      overlay: record.revision,
    });
    return {
      token,
      added: added.sort(),
      changed: changed.sort(),
      removed: removed.sort(),
      conflicts,
      diverged,
      pending: observation.kind === "pending",
      warnings,
      record,
      rebased,
      bootId,
      digest,
      current,
      hostEntries,
    };
  }

  /** Apply a previewed refresh; a changed file on either side refuses it. */
  async refresh(
    context: OverlaySourceContext,
    host: LoadedSource,
    previewToken: string,
  ): Promise<
    McpOverlayResolutionResult & { stagedCopy: "updated" | "unavailable" | "not-needed" }
  > {
    const plan = await this.planRefresh(context, host);
    if (plan.token !== previewToken) throw mcpFailure("revision-conflict");
    const { source } = context;
    const text = source.state === "absent" ? "" : (source.file?.text ?? "");
    const expected = expectedEntries(plan.rebased);
    const now = this.nowIso();
    const next: OverlayRecord = {
      ...plan.rebased,
      revision: plan.record.revision + 1,
      materialisedFingerprint: plan.digest(expected),
      materialisedBootId: plan.bootId,
      materialisedAt: now,
      updatedAt: now,
    };
    const previous = await this.load(context.environmentId, source.spec.sourceId);
    await this.records.write(next);
    let sourceRevision = source.file?.revision ?? null;
    try {
      if (plan.digest(expected) !== plan.digest(plan.current)) {
        sourceRevision = await this.write(context, rewriteServerMap(source.spec, text, expected));
      }
    } catch (error) {
      if (previous) await this.records.write(previous).catch(() => undefined);
      else await this.records.remove(context.environmentId, source.spec.sourceId);
      throw error;
    }
    // The next boot copies the staged input again; keep it on the refreshed servers.
    const stagedCopy = this.deps.stagedDefaults
      ? await this.deps.stagedDefaults
          .update(context.environmentId, context.containerId, source.spec.sourceId, (staged) =>
            rewriteServerMap(source.spec, staged, plan.hostEntries),
          )
          .catch(() => "unavailable" as const)
      : "unavailable";
    return {
      sourceRevision,
      overlay: publicOverlayState(next, { kind: "in-sync" }),
      stagedCopy,
    };
  }
}

/** Public overlay field for a source row, when the source has one. */
export function withOverlay(
  source: McpConfigSource,
  overlay: McpEnvironmentOverlayState | undefined,
): McpConfigSource {
  return overlay ? { ...source, overlay } : source;
}
