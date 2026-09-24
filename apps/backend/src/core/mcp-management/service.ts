/**
 * Backend-owned MCP configuration management.
 *
 * One service per backend. It owns the passive catalog, the conflict-checked
 * write path and the durable operation records; runtime application is
 * scheduled here and advanced off any request path. Nothing in this service
 * depends on a mounted renderer: every state it reports can be re-read from
 * `snapshot()` / `getOperation()` after a reload or a missed event.
 */

import * as fs from "node:fs/promises";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  MCP_MANAGEMENT_CHANGED_EVENT,
  MCP_MANAGEMENT_LIMITS,
  MCP_MANAGEMENT_PROTOCOL_VERSION,
  aggregateApplyState,
  mcpFailure,
  parseMcpMutation,
  utf8ByteLength,
  type McpDefinitionSummary,
  type McpEditableDefinition,
  type McpFieldError,
  type McpImpactPreview,
  type McpManagementChangedEvent,
  type McpManagementRolloutSettings,
  type McpManagementSnapshot,
  type McpManagementTarget,
  type McpMutation,
  type McpMutationResult,
  type McpOperationSnapshot,
  type McpTargetCapabilities,
  type McpTargetList,
  type McpValidationResult,
} from "@orkestrator/protocol/mcp-management";

import {
  advanceCodexRuntimes,
  planRuntimes,
  type PlannedRuntime,
  type RuntimeProbe,
} from "./apply.js";
import { EvidenceScheduler, evidenceRole, type CurrentSourceState } from "./evidence.js";
import { renameReferenceWarnings } from "./references.js";
import { McpRolloutGate } from "./rollout.js";
import {
  editableDefinition,
  entryEditBlock,
  entryRenameBlock,
  loadCatalog,
  parseEntryId,
  publicSource,
  revealedBy,
  sameIdentityEntries,
  summarizeEntries,
  entryIdFor,
  type LoadedCatalog,
  type LoadedEntry,
  type LoadedSource,
} from "./catalog.js";
import { PROVIDER_CODECS, piSanitizedName } from "./codecs.js";
import { editSource, parseSource, type DocumentEdit, type ParsedSource } from "./document.js";
import {
  applyPatch,
  assertNoFieldErrors,
  capabilityErrors,
  cleanEntry,
  definitionFromInput,
  projectSecretErrors,
} from "./mutation.js";
import { McpOperationStore, type StoredOperation } from "./operations-store.js";
import {
  containerSources,
  providerCapabilities,
  providerLabel,
  providerSources,
  resolveProviderHomes,
  type ProviderHomes,
} from "./providers.js";
import { ABSENT_REVISION, McpSourceStore, contentDigest } from "./source-store.js";
import {
  CONTAINER_READ_ONLY_REASON,
  backendTargetId,
  environmentTargetId,
  listTargets,
  resolveTarget,
  type ResolvedTarget,
  type TargetStorage,
} from "./targets.js";
import { tomlDeepEqual } from "./toml-edit.js";
import type { ContainerFileReader, SourceSpec } from "./types.js";

export interface McpServiceStorage extends TargetStorage {
  getPreviewBackendIdentity(): Promise<{ instanceId: string }>;
}

export interface McpManagementServiceOptions {
  dataDir: string;
  storage: McpServiceStorage;
  emit: (event: string, payload: unknown) => void;
  probe: RuntimeProbe;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  lockDir?: string;
  tickMs?: number;
  /** Reads container files for container targets' read-only catalogs. */
  readContainerFile?: ContainerFileReader;
  /** Reads the stored rollout settings (`global.mcpManagement`). Absent: everything enabled. */
  loadRollout?: () => Promise<unknown>;
  /** How long a write waits for another Orkestrator writer before `busy`. */
  lockWaitMs?: number;
}

interface Prepared {
  spec: SourceSpec;
  source: LoadedSource;
  edit: DocumentEdit | null;
  fieldErrors: McpFieldError[];
  preview: McpImpactPreview;
  entryName: string;
  resultName: string | null;
  intendedEntry?: Record<string, unknown>;
}

/** Events name at most this many targets; beyond it they say "all" (`[]`). */
const EVENT_TARGETS_MAX = 256;

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

export class McpManagementService {
  private readonly store: McpSourceStore;
  private readonly operations: McpOperationStore;
  private readonly now: () => number;
  private readonly homes: ProviderHomes;
  private readonly gate: McpRolloutGate;
  private catalogRevision = 0;
  private eventRevision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking: Promise<void> | null = null;
  private initialized: Promise<void> | null = null;
  private disposed = false;
  private readonly evidence: EvidenceScheduler;

  constructor(private readonly options: McpManagementServiceOptions) {
    const dir = path.join(options.dataDir, "mcp-management");
    this.store = new McpSourceStore({
      keyFile: path.join(dir, "revision.key"),
      lockDir: options.lockDir,
      lockWaitMs: options.lockWaitMs,
    });
    this.gate = new McpRolloutGate(options.loadRollout);
    this.now = options.now ?? Date.now;
    this.operations = new McpOperationStore(
      path.join(dir, "operations.json"),
      () => this.store.secretKey(),
      this.now,
    );
    this.homes = resolveProviderHomes(options.env ?? process.env, options.home);
    this.evidence = new EvidenceScheduler({
      probe: options.probe,
      now: this.now,
      blocked: (provider) => !!this.gate.applyBlock(provider),
      currentSource: (stored) => this.currentSource(stored),
      commit: (stored) => this.finishApplyUpdate(stored),
    });
  }

  init(): Promise<void> {
    this.initialized ??= (async () => {
      await this.operations.load();
      await this.gate.refresh();
      await this.recover();
      await this.retireGatedWork();
      this.scheduleTick();
    })();
    return this.initialized;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  private async specsFor(target: ResolvedTarget): Promise<SourceSpec[]> {
    if (target.info.location === "container") {
      if (!target.info.containerId) {
        return (
          await providerSources(
            target.provider,
            this.sourceContext({ ...target.info, location: "backend-host" }),
          )
        ).filter((spec) => spec.format === "runtime");
      }
      return containerSources(
        target.provider,
        target.info.containerId,
        target.readOnlyReason ?? CONTAINER_READ_ONLY_REASON,
        this.options.readContainerFile,
      );
    }
    return providerSources(target.provider, this.sourceContext(target.info));
  }

  private sourceContext(info: ResolvedTarget["info"]) {
    return {
      context: info,
      homes: this.homes,
      exists: async (filePath: string) =>
        fs.stat(filePath).then(
          () => true,
          () => false,
        ),
    };
  }

  private async publicTarget(
    target: ResolvedTarget,
    specs?: SourceSpec[],
  ): Promise<McpManagementTarget> {
    const identity = await this.options.storage.getPreviewBackendIdentity();
    const sources = specs ?? (await this.specsFor(target));
    const defaultSource =
      target.info.kind === "backend" && !target.readOnlyReason
        ? sources
            .filter((spec) => spec.scope === "backend-user" && spec.writable)
            .sort((a, b) => b.precedence - a.precedence)[0]
        : undefined;
    return {
      targetId: target.targetId,
      backendId: identity.instanceId,
      provider: target.provider,
      providerLabel: providerLabel(target.provider),
      context: target.context,
      defaultSourceId: defaultSource?.sourceId ?? null,
      capabilities: this.capabilitiesFor(target),
      readOnlyReason: target.readOnlyReason,
    };
  }

  /** Provider capabilities with the rollout gate applied. */
  private capabilitiesFor(target: ResolvedTarget): McpTargetCapabilities {
    return this.gate.overlay(
      target.provider,
      providerCapabilities(target.provider, target.readOnlyReason),
    );
  }

  /** Why every row of `target` is read-only: the target itself, or the gate. */
  private rowReadOnly(target: ResolvedTarget): string | undefined {
    return target.readOnlyReason ?? this.gate.writeBlock(target.provider);
  }

  async listTargets(args: { environmentId?: unknown }): Promise<McpTargetList> {
    await this.init();
    const environmentId =
      typeof args.environmentId === "string" && args.environmentId ? args.environmentId : undefined;
    const targets = await listTargets(this.options.storage, environmentId);
    const identity = await this.options.storage.getPreviewBackendIdentity();
    return {
      protocolVersion: MCP_MANAGEMENT_PROTOCOL_VERSION,
      backendId: identity.instanceId,
      targets: await Promise.all(targets.map((target) => this.publicTarget(target))),
    };
  }

  async snapshot(args: { targetId?: unknown }): Promise<McpManagementSnapshot> {
    await this.init();
    await this.operations.refresh();
    const target = await resolveTarget(args.targetId, this.options.storage);
    const specs = await this.specsFor(target);
    const catalog = await loadCatalog(this.store, specs, this.options.readContainerFile);
    const capabilities = this.capabilitiesFor(target);
    const { definitions, effective } = summarizeEntries(
      catalog,
      capabilities,
      this.rowReadOnly(target),
    );
    const sorted = sortDefinitions(definitions, catalog);
    const rows = sorted.slice(0, MCP_MANAGEMENT_LIMITS.catalogRowsMax);
    const sourceErrors = catalog.sources.some(
      (source) =>
        source.state === "invalid" ||
        source.state === "permission-denied" ||
        source.state === "oversized",
    );
    const snapshot: McpManagementSnapshot = {
      protocolVersion: MCP_MANAGEMENT_PROTOCOL_VERSION,
      target: await this.publicTarget(target, specs),
      sources: catalog.sources.map(publicSource),
      definitions: [],
      effective,
      operations: this.operations.forTarget(target.targetId),
      catalogRevision: this.catalogRevision,
      freshness: "fresh",
      truncated: 0,
      generatedAt: nowIso(this.now),
    };
    const limited = fitSnapshotBudget(snapshot, rows);
    snapshot.definitions = limited;
    snapshot.truncated = sorted.length - limited.length;
    snapshot.freshness = snapshot.truncated > 0 || sourceErrors ? "incomplete" : "fresh";
    return snapshot;
  }

  async getDefinition(args: {
    targetId?: unknown;
    entryId?: unknown;
  }): Promise<McpEditableDefinition> {
    await this.init();
    const target = await resolveTarget(args.targetId, this.options.storage);
    const catalog = await loadCatalog(
      this.store,
      await this.specsFor(target),
      this.options.readContainerFile,
    );
    const entry = findEntry(catalog, args.entryId);
    return editableDefinition(entry, this.capabilitiesFor(target), this.rowReadOnly(target));
  }

  async getOperation(args: { operationId?: unknown }): Promise<McpOperationSnapshot> {
    await this.init();
    await this.operations.refresh();
    const stored =
      typeof args.operationId === "string" ? this.operations.get(args.operationId) : undefined;
    if (!stored) throw mcpFailure("unknown-operation");
    return stored.snapshot;
  }

  // -------------------------------------------------------------------------
  // Validation, preview and mutation
  // -------------------------------------------------------------------------

  async validate(args: { mutation?: unknown }): Promise<McpValidationResult> {
    await this.init();
    const { mutation, fieldErrors } = parseMcpMutation(args.mutation);
    const target = await resolveTarget(mutation.targetId, this.options.storage);
    this.gate.assertWritable(target.provider);
    const specs = await this.specsFor(target);
    const catalog = await loadCatalog(this.store, specs, this.options.readContainerFile);
    if (fieldErrors.length) return { valid: false, fieldErrors, preview: null };
    const prepared = await this.prepare(mutation, target, specs, catalog);
    // Report a stale draft now, before the user reviews a preview of it.
    if ((prepared.source.file?.revision ?? null) !== expectedRevision(mutation)) {
      throw mcpFailure("revision-conflict");
    }
    if (!prepared.fieldErrors.length) nextSourceText(prepared);
    return {
      valid: !prepared.fieldErrors.length,
      fieldErrors: prepared.fieldErrors,
      preview: prepared.preview,
    };
  }

  async mutate(args: { mutation?: unknown }): Promise<McpMutationResult> {
    await this.init();
    const { mutation, fieldErrors } = parseMcpMutation(args.mutation);
    assertNoFieldErrors(fieldErrors);
    const fingerprint = await this.operations.digest({
      targetId: mutation.targetId,
      applyIntent: mutation.applyIntent,
      operation: mutation.operation,
    });
    await this.operations.refresh();
    const existing = this.operations.byRequest(mutation.targetId, mutation.requestId);
    if (existing) {
      if (existing.recovery.fingerprint !== fingerprint) throw mcpFailure("request-conflict");
      // A retry that arrives while the original is still writing waits for it
      // under the file lock below and replays its outcome.
      if (existing.snapshot.phase !== "pending" && existing.snapshot.phase !== "reconciling")
        return this.result(existing, true);
    }
    const target = await resolveTarget(mutation.targetId, this.options.storage);
    this.gate.assertWritable(target.provider);
    if (target.readOnlyReason)
      throw mcpFailure("read-only-source", { message: target.readOnlyReason });
    const specs = await this.specsFor(target);
    const spec = specFor(mutation, specs);
    if (!spec.writable) throw mcpFailure("read-only-source", { message: spec.readOnlyReason });
    const locked = await this.store.withLock(spec.path, async () => {
      await this.operations.refresh();
      const replay = this.operations.byRequest(mutation.targetId, mutation.requestId);
      if (replay) {
        if (replay.recovery.fingerprint !== fingerprint) throw mcpFailure("request-conflict");
        return { stored: replay, replayed: true };
      }
      // Everything is re-read under the lock; nothing cached authorizes a write.
      const catalog = await loadCatalog(this.store, specs, this.options.readContainerFile);
      const prepared = await this.prepare(mutation, target, specs, catalog);
      assertNoFieldErrors(prepared.fieldErrors);
      const source = prepared.source;
      const expected = expectedRevision(mutation);
      if ((source.file?.revision ?? null) !== expected) throw mcpFailure("revision-conflict");
      // Limits are checked before the record exists: a refused change is not an operation.
      const next = nextSourceText(prepared);
      const created = nowIso(this.now);
      const operation: StoredOperation = {
        snapshot: {
          operationId: this.operations.newOperationId(),
          requestId: mutation.requestId,
          targetId: mutation.targetId,
          provider: target.provider,
          kind: mutation.operation.kind,
          entryName: prepared.entryName,
          sourceId: spec.sourceId,
          phase: "pending",
          applyIntent: mutation.applyIntent,
          apply: { state: "not-requested", runtimes: [], omitted: 0 },
          affectedEnvironments: prepared.preview.affectedEnvironments,
          createdAt: created,
          updatedAt: created,
        },
        recovery: {
          fingerprint,
          expectedRevision: expected,
          name: prepared.entryName,
          newName: prepared.resultName ?? undefined,
          entryDigest: prepared.intendedEntry
            ? await this.operations.entryDigest(prepared.intendedEntry)
            : undefined,
        },
      };
      await this.operations.put(operation);
      try {
        const text = source.file?.text ?? "";
        const unchanged =
          next === text &&
          source.file?.state === "ok" &&
          !(spec.scope === "backend-user" && !!(source.file.mode && source.file.mode & 0o077));
        // Taken before the write: a runtime that read the file earlier cannot
        // have loaded this save, whatever it reports.
        const writeStartedAt = nowIso(this.now);
        const written = unchanged
          ? source.file!
          : await this.store.commit(source.file!, expected ?? ABSENT_REVISION, next, {
              allowedRoot: spec.allowedRoot,
              createMode: spec.createMode,
              privateExisting: spec.scope === "backend-user",
              maxBytes: spec.maxBytes,
            });
        // The exact bytes now in the file, in the format bridges report.
        const savedDigest = unchanged
          ? source.file!.contentDigest
          : contentDigest(Buffer.from(next, "utf8"));
        const role = evidenceRole(target.provider, spec.sourceId);
        if (savedDigest && role) {
          operation.recovery.savedDigest = savedDigest;
          operation.recovery.writeStartedAt = writeStartedAt;
          operation.recovery.evidenceRole = role;
        }
        operation.snapshot.phase = "saved";
        operation.snapshot.savedRevision = written.revision ?? undefined;
        operation.snapshot.resultEntryId = prepared.resultName
          ? entryIdFor(spec.sourceId, prepared.resultName)
          : undefined;
      } catch (error) {
        const detail = mcpFailureDetail(error);
        operation.snapshot.phase = detail.code === "revision-conflict" ? "conflict" : "failed";
        operation.snapshot.errorCode = detail.code;
        operation.snapshot.message = detail.message;
        operation.snapshot.updatedAt = nowIso(this.now);
        await this.operations.put(operation);
        throw error;
      }
      operation.snapshot.updatedAt = nowIso(this.now);
      await this.operations.put(operation);
      return { stored: operation, replayed: false };
    });
    if (locked.replayed) return this.result(locked.stored, true);
    const stored = locked.stored;
    this.catalogRevision += 1;
    const applyBlock = this.gate.applyBlock(target.provider);
    if (mutation.applyIntent === "save-and-apply" && applyBlock) {
      // Saved; the gate only withholds the runtime step, and says so.
      stored.snapshot.message = `Saved. ${applyBlock}`;
      stored.snapshot.updatedAt = nowIso(this.now);
      await this.operations.put(stored);
    } else if (mutation.applyIntent === "save-and-apply") {
      // The file is already saved; a scheduling failure is an apply outcome,
      // retryable from the operation, never a failed save.
      await this.startApply(stored, target).catch(async (error: unknown) => {
        stored.snapshot.apply = {
          state: "failed",
          runtimes: [],
          omitted: 0,
          terminalGuidance: providerCapabilities(target.provider).terminal.guidance,
        };
        stored.snapshot.message = `Saved, but applying could not start: ${mcpFailureDetail(error).message}`;
        stored.snapshot.updatedAt = nowIso(this.now);
        await this.operations.put(stored);
      });
    }
    this.publish(await this.affectedTargetIds(target, spec), [stored.snapshot.operationId]);
    return this.result(stored, false);
  }

  private result(stored: StoredOperation, replayed: boolean): McpMutationResult {
    const snapshot = stored.snapshot;
    if (snapshot.phase !== "saved") {
      throw mcpFailure(snapshot.errorCode ?? "internal", { message: snapshot.message });
    }
    return {
      operation: snapshot,
      replayed,
      savedRevision: snapshot.savedRevision ?? "",
      entryId: snapshot.resultEntryId ?? null,
    };
  }

  private async prepare(
    mutation: McpMutation,
    target: ResolvedTarget,
    specs: SourceSpec[],
    catalog: LoadedCatalog,
  ): Promise<Prepared> {
    const capabilities = providerCapabilities(target.provider, target.readOnlyReason);
    const codec = PROVIDER_CODECS[target.provider];
    const operation = mutation.operation;
    const spec = specFor(mutation, specs);
    const source = catalog.sources.find((candidate) => candidate.spec.sourceId === spec.sourceId)!;
    assertSourceWritable(source);
    const fieldErrors: McpFieldError[] = [];
    let edit: DocumentEdit | null = null;
    let entryName: string;
    let resultName: string | null;
    let intendedEntry: Record<string, unknown> | undefined;
    let changedFields: string[] = [];
    let entry: LoadedEntry | undefined;
    const warnings: string[] = [];
    if (spec.scope === "backend-user" && source.file?.mode && source.file.mode & 0o077) {
      warnings.push(
        "Saving will restrict this user configuration file to owner-only permissions so stored credentials stay private.",
      );
    }
    switch (operation.kind) {
      case "add": {
        requireFlag(capabilities.operations.add, "unsupported-operation");
        const definition = definitionFromInput(
          operation.definition,
          capabilities.operations.setEnabled.supported,
        );
        fieldErrors.push(
          ...codec.validate(definition, operation.definition.name, true),
          ...capabilityErrors(definition, capabilities),
          ...projectSecretErrors(spec, null, definition),
        );
        entryName = operation.definition.name;
        resultName = entryName;
        assertNameFree(source, target.provider, entryName, undefined);
        assertRoomForDefinition(source);
        intendedEntry = cleanEntry(codec.encode(definition, null));
        edit = { kind: "add", name: entryName, entry: intendedEntry };
        changedFields = ["new server"];
        break;
      }
      case "update":
      case "set-enabled": {
        entry = findEntry(catalog, operation.entryId, spec.sourceId);
        const block = entryEditBlock(entry, capabilities, target.readOnlyReason);
        if (block)
          throw mcpFailure(entry.injected ? "protected-entry" : "read-only-source", {
            message: block,
          });
        let definition = entry.definition!;
        if (operation.kind === "set-enabled") {
          requireFlag(capabilities.operations.setEnabled, "unsupported-operation");
          definition = { ...definition, enabled: operation.enabled };
          changedFields = [operation.enabled ? "enabled" : "disabled"];
        } else {
          requireFlag(capabilities.operations.update, "unsupported-operation");
          if (
            target.provider === "codex" &&
            operation.patch.transport &&
            operation.patch.transport.to !== definition.transport
          ) {
            const nativeKeys =
              operation.patch.transport.to === "stdio"
                ? ["env_http_headers", "bearer_token"]
                : ["env_vars"];
            const missing = nativeKeys.filter(
              (key) =>
                entry!.raw?.[key] !== undefined &&
                !operation.patch.transport!.discard.includes(key),
            );
            if (missing.length)
              fieldErrors.push({
                field: "transport",
                message: `Switching transport discards ${missing.join(", ")}; confirm the switch.`,
              });
          }
          const patched = applyPatch(definition, operation.patch, capabilities);
          fieldErrors.push(...patched.errors);
          definition = patched.definition;
          changedFields = patched.changed;
        }
        fieldErrors.push(
          ...codec.validate(definition, entry.name, false),
          ...capabilityErrors(definition, capabilities),
          ...projectSecretErrors(spec, entry.definition, definition),
        );
        entryName = entry.name;
        resultName = entry.name;
        intendedEntry = cleanEntry(codec.encode(definition, entry.raw));
        edit = tomlDeepEqual(intendedEntry, entry.raw)
          ? null
          : { kind: "update", name: entry.name, previous: entry.raw!, entry: intendedEntry };
        break;
      }
      case "rename": {
        requireFlag(capabilities.operations.rename, "unsupported-operation");
        entry = findEntry(catalog, operation.entryId, spec.sourceId);
        // A same-source name collision (Pi's normalized names) blocks rename
        // but not removal: removing one of the pair is how a user repairs it.
        const renameBlock = entry.injected
          ? entry.source.spec.readOnlyReason
          : (removalBlock(entry) ?? entryRenameBlock(entry));
        if (renameBlock)
          throw mcpFailure(entry.injected ? "protected-entry" : "read-only-source", {
            message: renameBlock,
          });
        if (operation.newName !== entry.name) {
          const rule = new RegExp(codec.nameRule.pattern);
          if (!rule.test(operation.newName))
            fieldErrors.push({ field: "name", message: codec.nameRule.description });
          assertNameFree(source, target.provider, operation.newName, entry.name);
        }
        entryName = entry.name;
        resultName = operation.newName;
        edit =
          operation.newName === entry.name
            ? null
            : { kind: "rename", name: entry.name, newName: operation.newName };
        changedFields = ["name"];
        if (edit) warnings.push(...renameReferenceWarnings(catalog, source, entry.name));
        break;
      }
      case "remove": {
        requireFlag(capabilities.operations.remove, "unsupported-operation");
        entry = findEntry(catalog, operation.entryId, spec.sourceId);
        const block = entry.injected ? entry.source.spec.readOnlyReason : removalBlock(entry);
        if (block)
          throw mcpFailure(entry.injected ? "protected-entry" : "read-only-source", {
            message: block,
          });
        entryName = entry.name;
        resultName = null;
        edit = { kind: "remove", name: entry.name };
        changedFields = ["removed"];
        warnings.push("Removing a server does not revoke any sign-in it used.");
        break;
      }
    }
    const preview = await this.preview(
      mutation,
      target,
      spec,
      catalog,
      entry,
      resultName,
      changedFields,
      capabilities,
      warnings,
    );
    return { spec, source, edit, fieldErrors, preview, entryName, resultName, intendedEntry };
  }

  private async preview(
    mutation: McpMutation,
    target: ResolvedTarget,
    spec: SourceSpec,
    catalog: LoadedCatalog,
    entry: LoadedEntry | undefined,
    resultName: string | null,
    changedFields: string[],
    capabilities: McpTargetCapabilities,
    warnings: string[],
  ): Promise<McpImpactPreview> {
    const operation = mutation.operation;
    let reveals: LoadedEntry | undefined;
    let shadows: LoadedEntry | undefined;
    const disablesPi =
      operation.kind === "set-enabled" && !operation.enabled && target.provider === "pi";
    if (entry && (operation.kind === "remove" || operation.kind === "rename" || disablesPi)) {
      reveals = revealedBy(catalog.entries, entry);
    }
    if (resultName && (operation.kind === "add" || operation.kind === "rename")) {
      const others = sameIdentityEntries(catalog.entries, target.provider, resultName).filter(
        (candidate) => candidate !== entry && !candidate.source.spec.excludedReason,
      );
      const higher = others.filter(
        (candidate) => candidate.source.spec.precedence > spec.precedence,
      );
      const lower = others.filter(
        (candidate) => candidate.source.spec.precedence < spec.precedence,
      );
      lower.sort((a, b) => b.source.spec.precedence - a.source.spec.precedence);
      if (higher.length) {
        const winner = higher.sort(
          (a, b) => b.source.spec.precedence - a.source.spec.precedence,
        )[0]!;
        warnings.push(
          `${winner.source.spec.label} also defines "${resultName}" and takes priority, so this entry will not be used.`,
        );
      } else if (lower[0]) {
        shadows = lower[0];
      }
    }
    const definitionTransport =
      operation.kind === "add"
        ? operation.definition.transport
        : operation.kind === "update"
          ? (operation.patch.transport?.to ?? entry?.definition?.transport)
          : entry?.definition?.transport;
    if (definitionTransport === "stdio" && operation.kind !== "remove") {
      // Shown for both intents: a save-only preview can still end in an apply,
      // and any session that next loads the file starts the command anyway.
      const location = target.context.locationLabel.toLowerCase();
      warnings.push(
        mutation.applyIntent === "save-and-apply"
          ? `Applying starts this server's command on ${location} the next time a session loads it.`
          : `If you apply, or when a session next loads this configuration, this server's command starts on ${location}.`,
      );
    }
    if (spec.trust && spec.trust !== "allowed" && spec.trustReason) warnings.push(spec.trustReason);
    if (spec.sharedWith.length)
      warnings.push(
        `${spec.sharedWith.map(providerLabel).join(", ")} also ${spec.sharedWith.length === 1 ? "reads" : "read"} this file.`,
      );
    if (spec.scope === "backend-user")
      warnings.push(
        target.provider === "cursor"
          ? "Container environments do not receive Cursor's MCP configuration."
          : "Existing container environments keep the copy they were created with.",
      );
    if (capabilities.terminal.readsNativeConfig) warnings.push(capabilities.terminal.guidance);
    return {
      sourceId: spec.sourceId,
      sourceLabel: spec.label,
      displayPath: spec.displayPath,
      scope: spec.scope,
      changedFields,
      revealsEntryId: reveals?.entryId,
      revealsSourceLabel: reveals?.source.spec.label,
      shadowsEntryId: shadows?.entryId,
      shadowsSourceLabel: shadows?.source.spec.label,
      affectedEnvironments: await this.affectedEnvironments(target, spec),
      sharedWith: spec.sharedWith,
      apply: capabilities.apply,
      warnings,
    };
  }

  private async affectedEnvironments(
    target: ResolvedTarget,
    spec: SourceSpec,
  ): Promise<McpImpactPreview["affectedEnvironments"]> {
    const environments = await this.options.probe.environments();
    const sessions = (await this.options.probe.sessions()).filter(
      (session) => session.agent === target.provider,
    );
    const scoped = spec.scope === "backend-user" ? null : target.info.environmentId;
    const result: McpImpactPreview["affectedEnvironments"] = [];
    for (const environment of environments) {
      if (environment.environmentType !== "local") continue;
      if (scoped !== null && environment.id !== scoped) continue;
      const own = sessions.filter((session) => session.environmentId === environment.id);
      if (scoped === null && !own.length) continue;
      const active = own.filter(
        (session) =>
          this.options.probe.activity(
            environment.id,
            target.provider,
            session.logicalSessionKey,
          ) !== "idle",
      ).length;
      result.push({
        environmentId: environment.id,
        name: environment.name,
        activeSessions: active,
      });
      if (result.length >= 50) break;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Runtime application
  // -------------------------------------------------------------------------

  async apply(args: { operationId?: unknown }): Promise<McpOperationSnapshot> {
    await this.init();
    const stored =
      typeof args.operationId === "string" ? this.operations.get(args.operationId) : undefined;
    if (!stored) throw mcpFailure("unknown-operation");
    if (stored.snapshot.phase !== "saved") {
      throw mcpFailure("unsupported-operation", { message: "Only a saved change can be applied." });
    }
    this.gate.assertApplicable(stored.snapshot.provider);
    const target = await resolveTarget(stored.snapshot.targetId, this.options.storage);
    stored.snapshot.applyIntent = "save-and-apply";
    await this.startApply(stored, target);
    this.publish([stored.snapshot.targetId], [stored.snapshot.operationId]);
    return stored.snapshot;
  }

  // -------------------------------------------------------------------------
  // Rollout gate
  // -------------------------------------------------------------------------

  rolloutSettings(): McpManagementRolloutSettings {
    return this.gate.current();
  }

  /**
   * Re-read the stored gate, then retire queued work it no longer allows.
   * Never touches a saved file; in-flight reloads finish and report normally.
   */
  async refreshRollout(): Promise<McpManagementRolloutSettings> {
    await this.init();
    const settings = await this.gate.refresh();
    await this.retireGatedWork();
    // Capabilities changed for every target.
    this.publish([], []);
    this.scheduleTick();
    return settings;
  }

  private async retireGatedWork(): Promise<void> {
    for (const stored of Array.from(this.operations.list())) {
      const block = this.gate.applyBlock(stored.snapshot.provider);
      if (!block) continue;
      const now = nowIso(this.now);
      let touched = false;
      for (const runtime of stored.snapshot.apply.runtimes) {
        if (runtime.state !== "queued") continue;
        runtime.state = "cancelled";
        runtime.reason = `Cancelled: ${block} The saved configuration is unchanged.`;
        runtime.updatedAt = now;
        touched = true;
      }
      if (touched) await this.finishApplyUpdate(stored);
    }
  }

  async cancelApply(args: { operationId?: unknown }): Promise<McpOperationSnapshot> {
    await this.init();
    await this.operations.refresh();
    const stored =
      typeof args.operationId === "string" ? this.operations.get(args.operationId) : undefined;
    if (!stored) throw mcpFailure("unknown-operation");
    const now = nowIso(this.now);
    for (const runtime of stored.snapshot.apply.runtimes) {
      if (runtime.state === "queued") {
        runtime.state = "cancelled";
        runtime.reason = "Cancelled; the saved configuration is unchanged.";
        runtime.updatedAt = now;
      }
    }
    await this.finishApplyUpdate(stored);
    return stored.snapshot;
  }

  private async startApply(stored: StoredOperation, target: ResolvedTarget): Promise<void> {
    const specs = await this.specsFor(target);
    const spec = specs.find((candidate) => candidate.sourceId === stored.snapshot.sourceId);
    if (!spec) throw mcpFailure("unknown-source");
    const queuedTargets = new Set(
      this.operations
        .list()
        .filter((entry) =>
          entry.snapshot.apply.runtimes.some((runtime) => runtime.state === "queued"),
        )
        .map((entry) => entry.snapshot.targetId),
    );
    if (
      !queuedTargets.has(target.targetId) &&
      queuedTargets.size >= MCP_MANAGEMENT_LIMITS.queuedApplyTargets
    ) {
      throw mcpFailure("busy");
    }
    const now = nowIso(this.now);
    const environmentIds =
      spec.scope === "backend-user" ? null : new Set([target.info.environmentId!]);
    const planned = await planRuntimes(
      this.options.probe,
      target.provider,
      spec.scope,
      environmentIds,
      spec.excludedReason,
      now,
      stored.snapshot.savedRevision,
    );
    const coveredRuntimeIds = new Set(
      planned.runtimes
        .filter((runtime) => runtime.state === "queued")
        .map((runtime) => runtime.runtimeId),
    );
    // A newer apply supersedes only the runtime work it actually covers.
    for (const other of this.operations.list()) {
      if (other === stored) continue;
      let touched = false;
      for (const runtime of other.snapshot.apply.runtimes) {
        if (runtime.state === "queued" && coveredRuntimeIds.has(runtime.runtimeId)) {
          runtime.state = "cancelled";
          runtime.reason = "Superseded by a newer change; that apply covers this one.";
          runtime.updatedAt = now;
          touched = true;
        }
      }
      if (touched) await this.finishApplyUpdate(other, false);
    }
    stored.snapshot.apply = {
      state: aggregateApplyState(planned.runtimes.map((runtime) => runtime.state)),
      runtimes: planned.runtimes.map(publicRuntime),
      omitted: planned.omitted,
      terminalGuidance: providerCapabilities(target.provider).terminal.guidance,
    };
    stored.recovery.runtimes = planned.runtimes.map((runtime) => ({
      runtimeId: runtime.runtimeId,
      environmentId: runtime.environmentId ?? "",
      agent: runtime.agent,
      logicalSessionKey: runtime.logicalSessionKey,
      ...(runtime.awaitsEvidence ? { awaitsEvidence: true } : {}),
      ...(runtime.bridgePid !== undefined ? { bridgePid: runtime.bridgePid } : {}),
    }));
    stored.recovery.applyQueuedAt = now;
    stored.snapshot.updatedAt = now;
    await this.operations.put(stored);
    this.scheduleTick(0);
  }

  private async finishApplyUpdate(stored: StoredOperation, publish = true): Promise<void> {
    stored.snapshot.apply.state = aggregateApplyState(
      stored.snapshot.apply.runtimes.map((runtime) => runtime.state),
    );
    stored.snapshot.updatedAt = nowIso(this.now);
    await this.operations.put(stored);
    if (publish) this.publish([stored.snapshot.targetId], [stored.snapshot.operationId]);
  }

  private hasQueuedWork(): boolean {
    return this.operations
      .list()
      .some((entry) =>
        entry.snapshot.apply.runtimes.some(
          (runtime) => runtime.state === "queued" || runtime.state === "applying",
        ),
      );
  }

  /**
   * Queued reloads, or runtimes still inside their bounded evidence window.
   * When neither remains the timer stops rearming and the scheduler is idle.
   */
  private hasScheduledWork(): boolean {
    return this.hasQueuedWork() || this.evidence.hasWork(this.operations.list());
  }

  private scheduleTick(delay = this.options.tickMs ?? 2_000): void {
    if (this.disposed || this.timer || !this.hasScheduledWork()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick()
        .catch((error: unknown) => {
          console.warn(
            "[mcp-management] apply tick failed:",
            error instanceof Error ? error.message : "unknown error",
          );
        })
        .finally(() => this.scheduleTick());
    }, delay);
    this.timer.unref?.();
  }

  /**
   * Advance queued runtimes. Runs on a timer, never on a request or event path.
   * Serial by construction (`ticking`): at most one provider reload is in
   * flight per backend, which is the whole apply-concurrency budget.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      // A caller may have supplied newer runtime evidence while the prior pass
      // was already reading. Give that evidence its own pass.
      await this.ticking;
      return this.tick();
    }
    const running = this.advanceTick();
    this.ticking = running;
    try {
      await running;
    } finally {
      if (this.ticking === running) this.ticking = null;
    }
  }

  private async advanceTick(): Promise<void> {
    for (const stored of Array.from(this.operations.list())) {
      const runtimes = stored.snapshot.apply.runtimes;
      if (!runtimes.some((runtime) => runtime.state === "queued" || runtime.state === "applying"))
        continue;
      // The scheduler is paused for a gated provider; its queue was retired.
      if (this.gate.applyBlock(stored.snapshot.provider)) continue;
      const planned: PlannedRuntime[] = runtimes.map((runtime) => {
        const recovery = stored.recovery.runtimes?.find(
          (candidate) => candidate.runtimeId === runtime.runtimeId,
        );
        return {
          ...runtime,
          agent: (recovery?.agent ?? stored.snapshot.provider) as AgentPlatform,
          logicalSessionKey: recovery?.logicalSessionKey,
        };
      });
      const startingStates = runtimes.map((runtime) => runtime.state);
      const queuedAt = Date.parse(stored.recovery.applyQueuedAt ?? stored.snapshot.updatedAt);
      const outcome = await advanceCodexRuntimes(this.options.probe, planned, queuedAt, this.now());
      if (!outcome.changed) continue;
      // A request may cancel or replace the plan while reloadCodex awaits.
      if (stored.snapshot.apply.runtimes !== runtimes) continue;
      stored.snapshot.apply.runtimes = outcome.runtimes.map((runtime, index) => {
        const current = runtimes[index]!;
        return current.state === startingStates[index] ? publicRuntime(runtime) : current;
      });
      await this.finishApplyUpdate(stored);
    }
    // Proof of adoption for runtimes that apply on their own boundary.
    await this.evidence.check(this.operations.list());
  }

  /**
   * The saved source file as it is now: the digest of its bytes and whether
   * the operation's change is still in it. Host files only — evidence is only
   * awaited from local runtimes — and read-only.
   */
  private async currentSource(stored: StoredOperation): Promise<CurrentSourceState | undefined> {
    const target = await resolveTarget(stored.snapshot.targetId, this.options.storage);
    if (target.info.location === "container") return undefined;
    const spec = (await this.specsFor(target)).find(
      (candidate) => candidate.sourceId === stored.snapshot.sourceId,
    );
    if (!spec || spec.format === "runtime") return undefined;
    const source = (await loadCatalog(this.store, [spec])).sources[0];
    const digest = source?.file?.contentDigest;
    if (!source?.parsed || !digest) return undefined;
    return { digest, landed: await this.changeLanded(stored, source.parsed.entries) };
  }

  /** Whether `entries` carry exactly the outcome the operation intended. */
  private async changeLanded(
    stored: StoredOperation,
    entries: ReadonlyMap<string, unknown>,
  ): Promise<boolean> {
    const { name, newName, entryDigest } = stored.recovery;
    switch (stored.snapshot.kind) {
      case "remove":
        return !entries.has(name);
      case "rename":
        return !!newName && entries.has(newName) && !entries.has(name);
      default: {
        const raw = entries.get(name);
        // Older pending records used insertion-order digests; keep their recovery path.
        return (
          !!raw &&
          !!entryDigest &&
          ((await this.operations.entryDigest(raw)) === entryDigest ||
            (await this.operations.digest(raw)) === entryDigest)
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /** Decide what an operation interrupted mid-save actually did. Never re-applies it. */
  private async recover(): Promise<void> {
    for (const stored of Array.from(this.operations.list())) {
      let dirty = false;
      if (stored.snapshot.phase === "pending" || stored.snapshot.phase === "reconciling") {
        await this.reconcileInterrupted(stored);
        dirty = true;
      }
      for (const runtime of stored.snapshot.apply.runtimes) {
        // An in-flight reload is idempotent; retry it from the queue.
        if (runtime.state === "applying") {
          runtime.state = "queued";
          runtime.reason = "Retrying after the backend restarted.";
          dirty = true;
        }
      }
      if (dirty) {
        stored.snapshot.apply.state = aggregateApplyState(
          stored.snapshot.apply.runtimes.map((runtime) => runtime.state),
        );
        stored.snapshot.updatedAt = nowIso(this.now);
        await this.operations.put(stored);
      }
    }
  }

  private async reconcileInterrupted(stored: StoredOperation): Promise<void> {
    const snapshot = stored.snapshot;
    const fail = (message: string, phase: McpOperationSnapshot["phase"] = "failed") => {
      snapshot.phase = phase;
      snapshot.errorCode = "internal";
      snapshot.message = message;
    };
    let target: ResolvedTarget;
    try {
      target = await resolveTarget(snapshot.targetId, this.options.storage);
    } catch {
      fail("Interrupted, and the target no longer exists.");
      return;
    }
    const spec = (await this.specsFor(target)).find(
      (candidate) => candidate.sourceId === snapshot.sourceId,
    );
    if (!spec) {
      fail("Interrupted, and the source no longer exists.");
      return;
    }
    const catalog = await loadCatalog(this.store, [spec]);
    const source = catalog.sources[0]!;
    const revision = source.file?.revision ?? null;
    if (revision === (stored.recovery.expectedRevision ?? ABSENT_REVISION)) {
      fail("Interrupted before saving; the file was not changed.");
      return;
    }
    const { newName } = stored.recovery;
    const landed = await this.changeLanded(stored, source.parsed?.entries ?? new Map());
    if (landed) {
      snapshot.phase = "saved";
      snapshot.savedRevision = revision ?? undefined;
      snapshot.message = "Recovered after an interruption; the change was saved.";
      if (newName) snapshot.resultEntryId = entryIdFor(spec.sourceId, newName);
    } else {
      fail(
        "Interrupted, and the file has changed since; review the configuration before retrying.",
        "conflict",
      );
    }
  }

  /**
   * Targets whose catalog a write to `spec` can change: the provider and every
   * provider sharing the file, seen from the backend and — for a backend-user
   * file — from every environment. `[]` ("all targets") past the event bound.
   */
  private async affectedTargetIds(target: ResolvedTarget, spec: SourceSpec): Promise<string[]> {
    const providers = Array.from(new Set([target.provider, ...spec.sharedWith]));
    const ids = new Set<string>([target.targetId]);
    try {
      if (spec.scope === "backend-user") {
        const { instanceId } = await this.options.storage.getPreviewBackendIdentity();
        for (const provider of providers) ids.add(backendTargetId(provider, instanceId));
        for (const known of await this.options.probe.environments()) {
          const environment = await this.options.storage.getEnvironment(known.id);
          if (!environment) continue;
          for (const provider of providers) ids.add(environmentTargetId(provider, environment));
          if (ids.size > EVENT_TARGETS_MAX) return [];
        }
      } else if (target.environment) {
        for (const provider of providers)
          ids.add(environmentTargetId(provider, target.environment));
      }
    } catch {
      return [];
    }
    return Array.from(ids);
  }

  private publish(targetIds: string[], operationIds: string[]): void {
    this.eventRevision += 1;
    const event: McpManagementChangedEvent = {
      revision: this.eventRevision,
      targetIds,
      operationIds,
    };
    try {
      this.options.emit(MCP_MANAGEMENT_CHANGED_EVENT, event);
    } catch {
      // Events are hints; snapshots remain authoritative.
    }
  }
}

function publicRuntime(
  runtime: PlannedRuntime | McpOperationSnapshot["apply"]["runtimes"][number],
) {
  return {
    runtimeId: runtime.runtimeId,
    environmentId: runtime.environmentId,
    label: runtime.label,
    state: runtime.state,
    reason: runtime.reason,
    updatedAt: runtime.updatedAt,
    ...(runtime.savedRevision ? { savedRevision: runtime.savedRevision } : {}),
    ...(runtime.generation ? { generation: runtime.generation } : {}),
  };
}

/** The source text after the edit, refused when the server map would outgrow its budget. */
function nextSourceText(prepared: Prepared): string {
  const { spec, source } = prepared;
  const text = source.file?.text ?? "";
  if (!prepared.edit) return text;
  const parsed = source.parsed ?? parseSource(spec, "");
  const next = editSource(spec, text, parsed, prepared.edit);
  if (prepared.edit.kind !== "remove") {
    const after = subtreeBytes(parseSource(spec, next));
    // A file already over budget stays editable as long as the edit does not grow it.
    if (after > MCP_MANAGEMENT_LIMITS.subtreeMaxBytes && after > subtreeBytes(parsed)) {
      throw mcpFailure("oversized-source", {
        message: `The server list in this file would exceed ${MCP_MANAGEMENT_LIMITS.subtreeMaxBytes / 1024 / 1024} MiB; the file was left unchanged.`,
      });
    }
  }
  return next;
}

function subtreeBytes(parsed: ParsedSource): number {
  return utf8ByteLength(JSON.stringify(Object.fromEntries(parsed.entries)));
}

function assertRoomForDefinition(source: LoadedSource): void {
  const names = new Set([
    ...(source.parsed?.entries.keys() ?? []),
    ...(source.parsed?.entryIssues.keys() ?? []),
  ]);
  if (names.size >= MCP_MANAGEMENT_LIMITS.definitionsPerSource) {
    throw mcpFailure("oversized-source", {
      message: `This source already holds ${MCP_MANAGEMENT_LIMITS.definitionsPerSource} servers, the most Orkestrator manages in one file. Remove one first.`,
    });
  }
}

function expectedRevision(mutation: McpMutation): string | null {
  const operation = mutation.operation;
  return operation.kind === "add"
    ? (operation.expectedRevision ?? ABSENT_REVISION)
    : operation.expectedRevision;
}

function specFor(mutation: McpMutation, specs: readonly SourceSpec[]): SourceSpec {
  const operation = mutation.operation;
  const sourceId =
    operation.kind === "add" ? operation.sourceId : parseEntryId(operation.entryId)?.sourceId;
  const spec = specs.find((candidate) => candidate.sourceId === sourceId);
  if (!spec) throw mcpFailure(operation.kind === "add" ? "unknown-source" : "unknown-entry");
  return spec;
}

function findEntry(catalog: LoadedCatalog, entryId: unknown, sourceId?: string): LoadedEntry {
  const entry =
    typeof entryId === "string"
      ? catalog.entries.find((candidate) => candidate.entryId === entryId)
      : undefined;
  if (!entry || (sourceId && entry.source.spec.sourceId !== sourceId))
    throw mcpFailure("unknown-entry");
  return entry;
}

function assertSourceWritable(source: LoadedSource): void {
  const spec = source.spec;
  if (!spec.writable) throw mcpFailure("read-only-source", { message: spec.readOnlyReason });
  if (source.file?.writeBlock)
    throw mcpFailure("read-only-source", { message: source.file.writeBlock });
  switch (source.state) {
    case "invalid":
      throw mcpFailure("malformed-source", { message: source.error });
    case "oversized":
      throw mcpFailure("oversized-source", { message: source.error });
    case "permission-denied":
      throw mcpFailure("read-only-source", { message: source.error ?? "Permission denied." });
    default:
  }
}

function removalBlock(entry: LoadedEntry): string | undefined {
  if (!entry.source.spec.writable)
    return entry.source.spec.readOnlyReason ?? "This source is read-only.";
  return entry.source.file?.writeBlock ?? entry.issue;
}

function assertNameFree(
  source: LoadedSource,
  provider: AgentPlatform,
  name: string,
  ignoring: string | undefined,
): void {
  const entries = source.parsed?.entries ?? new Map();
  const issues = source.parsed?.entryIssues ?? new Map();
  if ((entries.has(name) || issues.has(name)) && name !== ignoring)
    throw mcpFailure("duplicate-name");
  if (provider === "pi") {
    const target = piSanitizedName(name);
    for (const existing of entries.keys()) {
      if (existing !== ignoring && piSanitizedName(existing) === target) {
        throw mcpFailure("duplicate-name", {
          message: `Pi treats this name the same as "${existing}".`,
        });
      }
    }
  }
}

function requireFlag(
  flag: { supported: boolean; reason?: string },
  code: "unsupported-operation",
): void {
  if (!flag.supported) throw mcpFailure(code, { message: flag.reason });
}

function mcpFailureDetail(error: unknown): {
  code: NonNullable<McpOperationSnapshot["errorCode"]>;
  message: string;
} {
  const message = error instanceof Error ? error.message : "";
  const match = /McpManagementError:([a-z-]+): (.*)$/s.exec(message);
  if (match)
    return {
      code: match[1] as NonNullable<McpOperationSnapshot["errorCode"]>,
      message: match[2]!.slice(0, 512),
    };
  return { code: "internal", message: "The change could not be saved." };
}

const STATUS_ORDER: Record<McpDefinitionSummary["status"], number> = {
  effective: 0,
  disabled: 1,
  invalid: 2,
  unsupported: 3,
  shadowed: 4,
  "policy-excluded": 5,
  protected: 6,
};

function sortDefinitions(
  definitions: McpDefinitionSummary[],
  catalog: LoadedCatalog,
): McpDefinitionSummary[] {
  const precedence = new Map(
    catalog.sources.map((source) => [source.spec.sourceId, source.spec.precedence]),
  );
  return [...definitions].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      (precedence.get(right.sourceId) ?? 0) - (precedence.get(left.sourceId) ?? 0) ||
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status],
  );
}

/**
 * Keep the response under `catalogMaxBytes`: trim the oldest listed operations
 * if they alone overflow, then keep as many rows as fit. The caller reports the
 * dropped rows as `truncated` with freshness `incomplete`.
 */
export function fitSnapshotBudget(
  snapshot: McpManagementSnapshot,
  rows: McpDefinitionSummary[],
): McpDefinitionSummary[] {
  const budget = MCP_MANAGEMENT_LIMITS.catalogMaxBytes;
  // Room for the counters that are filled in after this measurement.
  const reserve = 64;
  let base = utf8ByteLength(JSON.stringify({ ...snapshot, definitions: [] })) + reserve;
  while (base > budget && snapshot.operations.length) {
    snapshot.operations = snapshot.operations.slice(0, -1);
    base = utf8ByteLength(JSON.stringify({ ...snapshot, definitions: [] })) + reserve;
  }
  const kept: McpDefinitionSummary[] = [];
  let used = base;
  for (const row of rows) {
    const bytes = utf8ByteLength(JSON.stringify(row)) + 1;
    if (used + bytes > budget) break;
    kept.push(row);
    used += bytes;
  }
  return kept;
}
