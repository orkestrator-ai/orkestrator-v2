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
  type McpDefinitionSummary,
  type McpEditableDefinition,
  type McpFieldError,
  type McpImpactPreview,
  type McpManagementChangedEvent,
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
import {
  editableDefinition,
  entryEditBlock,
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
import { editSource, parseSource, type DocumentEdit } from "./document.js";
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
import { ABSENT_REVISION, McpSourceStore } from "./source-store.js";
import {
  CONTAINER_READ_ONLY_REASON,
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

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

export class McpManagementService {
  private readonly store: McpSourceStore;
  private readonly operations: McpOperationStore;
  private readonly now: () => number;
  private readonly homes: ProviderHomes;
  private catalogRevision = 0;
  private eventRevision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private initialized: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: McpManagementServiceOptions) {
    const dir = path.join(options.dataDir, "mcp-management");
    this.store = new McpSourceStore({
      keyFile: path.join(dir, "revision.key"),
      lockDir: options.lockDir,
    });
    this.now = options.now ?? Date.now;
    this.operations = new McpOperationStore(
      path.join(dir, "operations.json"),
      () => this.store.secretKey(),
      this.now,
    );
    this.homes = resolveProviderHomes(options.env ?? process.env, options.home);
  }

  init(): Promise<void> {
    this.initialized ??= (async () => {
      await this.operations.load();
      await this.recover();
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
      grokCompatDisabled: async (name: "claude" | "cursor", worktree?: string) => {
        for (const file of [
          path.join(this.homes.home, ".grok", "config.toml"),
          ...(worktree ? [path.join(worktree, ".grok", "config.toml")] : []),
        ]) {
          try {
            const text = await fs.readFile(file, "utf8");
            if (text.length > MCP_MANAGEMENT_LIMITS.sourceFileMaxBytes) continue;
            const parsed = Bun.TOML.parse(text) as { compat?: Record<string, { mcps?: unknown }> };
            if (parsed.compat?.[name]?.mcps === false) return true;
          } catch {
            // Missing or unreadable: the default (compat on) applies.
          }
        }
        return false;
      },
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
      capabilities: providerCapabilities(target.provider, target.readOnlyReason),
      readOnlyReason: target.readOnlyReason,
    };
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
    const target = await resolveTarget(args.targetId, this.options.storage);
    const specs = await this.specsFor(target);
    const catalog = await loadCatalog(this.store, specs, this.options.readContainerFile);
    const capabilities = providerCapabilities(target.provider, target.readOnlyReason);
    const { definitions, effective } = summarizeEntries(
      catalog,
      capabilities,
      target.readOnlyReason,
    );
    const sorted = sortDefinitions(definitions, catalog);
    const limited = sorted.slice(0, MCP_MANAGEMENT_LIMITS.catalogRowsMax);
    const sourceErrors = catalog.sources.some(
      (source) =>
        source.state === "invalid" ||
        source.state === "permission-denied" ||
        source.state === "oversized",
    );
    return {
      protocolVersion: MCP_MANAGEMENT_PROTOCOL_VERSION,
      target: await this.publicTarget(target, specs),
      sources: catalog.sources.map(publicSource),
      definitions: limited,
      effective,
      operations: this.operations.forTarget(target.targetId),
      catalogRevision: this.catalogRevision,
      freshness: limited.length < sorted.length || sourceErrors ? "incomplete" : "fresh",
      truncated: sorted.length - limited.length,
      generatedAt: nowIso(this.now),
    };
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
    return editableDefinition(
      entry,
      providerCapabilities(target.provider, target.readOnlyReason),
      target.readOnlyReason,
    );
  }

  async getOperation(args: { operationId?: unknown }): Promise<McpOperationSnapshot> {
    await this.init();
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
    const specs = await this.specsFor(target);
    const catalog = await loadCatalog(this.store, specs, this.options.readContainerFile);
    if (fieldErrors.length) return { valid: false, fieldErrors, preview: null };
    const prepared = await this.prepare(mutation, target, specs, catalog);
    // Report a stale draft now, before the user reviews a preview of it.
    if ((prepared.source.file?.revision ?? null) !== expectedRevision(mutation)) {
      throw mcpFailure("revision-conflict");
    }
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
    const existing = this.operations.byRequest(mutation.targetId, mutation.requestId);
    if (existing) {
      if (existing.recovery.fingerprint !== fingerprint) throw mcpFailure("request-conflict");
      return this.result(existing, true);
    }
    const target = await resolveTarget(mutation.targetId, this.options.storage);
    if (target.readOnlyReason)
      throw mcpFailure("read-only-source", { message: target.readOnlyReason });
    const specs = await this.specsFor(target);
    const spec = specFor(mutation, specs);
    if (!spec.writable) throw mcpFailure("read-only-source", { message: spec.readOnlyReason });
    const stored = await this.store.withLock(spec.path, async () => {
      // Everything is re-read under the lock; nothing cached authorizes a write.
      const catalog = await loadCatalog(this.store, specs, this.options.readContainerFile);
      const prepared = await this.prepare(mutation, target, specs, catalog);
      assertNoFieldErrors(prepared.fieldErrors);
      const source = prepared.source;
      const expected = expectedRevision(mutation);
      if ((source.file?.revision ?? null) !== expected) throw mcpFailure("revision-conflict");
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
          createdAt: created,
          updatedAt: created,
        },
        recovery: {
          fingerprint,
          expectedRevision: expected,
          name: prepared.entryName,
          newName: prepared.resultName ?? undefined,
          entryDigest: prepared.intendedEntry
            ? await this.operations.digest(prepared.intendedEntry)
            : undefined,
        },
      };
      await this.operations.put(operation);
      try {
        const text = source.file?.text ?? "";
        const parsed = source.parsed ?? parseSource(spec, "");
        const next = prepared.edit ? editSource(spec, text, parsed, prepared.edit) : text;
        const written =
          next === text && source.file?.state === "ok"
            ? source.file
            : await this.store.commit(source.file!, expected ?? ABSENT_REVISION, next, {
                allowedRoot: spec.allowedRoot,
                createMode: spec.createMode,
                maxBytes: spec.maxBytes,
              });
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
      return operation;
    });
    this.catalogRevision += 1;
    if (mutation.applyIntent === "save-and-apply") {
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
    this.publish([], [stored.snapshot.operationId]);
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
        const renameBlock = entry.injected ? entry.source.spec.readOnlyReason : removalBlock(entry);
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
    if (
      definitionTransport === "stdio" &&
      mutation.applyIntent === "save-and-apply" &&
      operation.kind !== "remove"
    ) {
      warnings.push(
        `Applying starts this server's command on ${target.context.locationLabel.toLowerCase()} the next time a session loads it.`,
      );
    }
    if (spec.trust && spec.trust !== "allowed" && spec.trustReason) warnings.push(spec.trustReason);
    if (spec.sharedWith.length)
      warnings.push(`${spec.sharedWith.map(providerLabel).join(", ")} also read this file.`);
    if (spec.scope === "backend-user")
      warnings.push("Existing container environments keep the copy they were created with.");
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
    const target = await resolveTarget(stored.snapshot.targetId, this.options.storage);
    stored.snapshot.applyIntent = "save-and-apply";
    await this.startApply(stored, target);
    this.publish([], [stored.snapshot.operationId]);
    return stored.snapshot;
  }

  async cancelApply(args: { operationId?: unknown }): Promise<McpOperationSnapshot> {
    await this.init();
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
    // A newer apply for the same target supersedes queued work from older ones.
    const now = nowIso(this.now);
    for (const other of this.operations.list()) {
      if (other === stored || other.snapshot.targetId !== target.targetId) continue;
      let touched = false;
      for (const runtime of other.snapshot.apply.runtimes) {
        if (runtime.state === "queued") {
          runtime.state = "cancelled";
          runtime.reason = "Superseded by a newer change; that apply covers this one.";
          runtime.updatedAt = now;
          touched = true;
        }
      }
      if (touched) await this.finishApplyUpdate(other, false);
    }
    const environmentIds =
      spec.scope === "backend-user" ? null : new Set([target.info.environmentId!]);
    const planned = await planRuntimes(
      this.options.probe,
      target.provider,
      spec.scope,
      environmentIds,
      spec.excludedReason,
      now,
    );
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
    if (publish) this.publish([], [stored.snapshot.operationId]);
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

  private scheduleTick(delay = this.options.tickMs ?? 2_000): void {
    if (this.disposed || this.timer || !this.hasQueuedWork()) return;
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

  /** Advance queued runtimes. Runs on a timer, never on a request or event path. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const stored of Array.from(this.operations.list())) {
        const runtimes = stored.snapshot.apply.runtimes;
        if (!runtimes.some((runtime) => runtime.state === "queued" || runtime.state === "applying"))
          continue;
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
        const queuedAt = Date.parse(stored.recovery.applyQueuedAt ?? stored.snapshot.updatedAt);
        const outcome = await advanceCodexRuntimes(
          this.options.probe,
          planned,
          queuedAt,
          this.now(),
        );
        if (!outcome.changed) continue;
        stored.snapshot.apply.runtimes = outcome.runtimes.map(publicRuntime);
        await this.finishApplyUpdate(stored);
      }
    } finally {
      this.ticking = false;
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
    const entries = source.parsed?.entries ?? new Map();
    const { name, newName, entryDigest } = stored.recovery;
    let landed = false;
    switch (snapshot.kind) {
      case "remove":
        landed = !entries.has(name);
        break;
      case "rename":
        landed = !!newName && entries.has(newName) && !entries.has(name);
        break;
      default: {
        const raw = entries.get(name);
        landed = !!raw && !!entryDigest && (await this.operations.digest(raw)) === entryDigest;
      }
    }
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
  };
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
