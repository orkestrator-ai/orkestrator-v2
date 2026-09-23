/**
 * Passive catalog: read every source a target can see, parse it without
 * resolving secrets or starting anything, and work out which entry wins.
 *
 * Reading never launches a process, never resolves a variable and never
 * touches a session. A source that fails to read is reported in its own row;
 * it is never mistaken for an empty map a later write could replace.
 */

import {
  isEnvReference,
  isProtectedMcpServerName,
  isSensitiveArg,
  isSensitiveUrl,
  mcpManagementErrorFromUnknown,
  truncateUtf8,
  visibleArgs,
  visibleCommand,
  visibleUrl,
  type McpCapabilityFlag,
  type McpConfigSource,
  type McpDefinitionSummary,
  type McpEditableDefinition,
  type McpMapEntrySummary,
  type McpTargetCapabilities,
} from "@orkestrator/protocol/mcp-management";

import { PROVIDER_CODECS, piSanitizedName } from "./codecs.js";
import { parseSource, type ParsedSource } from "./document.js";
import type { McpSourceStore, SourceFileSnapshot } from "./source-store.js";
import type { CanonicalDefinition, ContainerFileReader, NativeEntry, SourceSpec } from "./types.js";

export interface LoadedSource {
  spec: SourceSpec;
  file: SourceFileSnapshot | null;
  parsed: ParsedSource | null;
  state: McpConfigSource["state"];
  error?: string;
}

export interface LoadedEntry {
  entryId: string;
  source: LoadedSource;
  name: string;
  raw: NativeEntry | null;
  definition: CanonicalDefinition | null;
  /** Layout problem (duplicate key, inline TOML) that blocks editing. */
  issue?: string;
  injected: boolean;
}

export interface LoadedCatalog {
  sources: LoadedSource[];
  entries: LoadedEntry[];
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function entryIdFor(sourceId: string, name: string): string {
  return `${sourceId}/${base64url(name)}`;
}

export function parseEntryId(entryId: string): { sourceId: string; name: string } | null {
  const slash = entryId.lastIndexOf("/");
  if (slash <= 0) return null;
  try {
    return {
      sourceId: entryId.slice(0, slash),
      name: Buffer.from(entryId.slice(slash + 1), "base64url").toString("utf8"),
    };
  } catch {
    return null;
  }
}

async function loadContainerSource(
  store: McpSourceStore,
  spec: SourceSpec,
  reader: ContainerFileReader | undefined,
): Promise<LoadedSource> {
  const offline = (error: string): LoadedSource => ({
    spec,
    file: null,
    parsed: null,
    state: "offline",
    error,
  });
  if (!reader) return offline("Container files cannot be read from this backend.");
  let result: Awaited<ReturnType<ContainerFileReader>>;
  try {
    result = await reader(spec.container!.containerId, spec.path, spec.maxBytes);
  } catch {
    return offline("The container could not be read.");
  }
  if (result.state === "offline")
    return offline("The container is not running; start it to see its configuration.");
  const base = {
    path: spec.path,
    realPath: spec.path,
    mode: null,
    writeBlock: spec.readOnlyReason,
  };
  if (result.state === "absent") {
    return {
      spec,
      file: { ...base, state: "absent", text: null, revision: "absent" },
      parsed: null,
      state: "absent",
    };
  }
  if (result.state !== "ok") {
    return {
      spec,
      file: null,
      parsed: null,
      state: "oversized",
      error: "Too large to read safely.",
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
  } catch {
    return { spec, file: null, parsed: null, state: "invalid", error: "Not valid UTF-8." };
  }
  const file = {
    ...base,
    state: "ok" as const,
    text,
    revision: await store.revisionOf(result.bytes),
  };
  try {
    const parsed = parseSource(spec, text);
    return {
      spec,
      file,
      parsed,
      state: parsed.addBlock ? "unsupported-layout" : "ok",
      error: parsed.addBlock,
    };
  } catch (error) {
    return {
      spec,
      file,
      parsed: null,
      state: "invalid",
      error: mcpManagementErrorFromUnknown(error)?.message ?? "The file could not be parsed.",
    };
  }
}

export async function loadSource(
  store: McpSourceStore,
  spec: SourceSpec,
  reader?: ContainerFileReader,
): Promise<LoadedSource> {
  if (spec.format === "runtime") return { spec, file: null, parsed: null, state: "ok" };
  if (spec.container) return loadContainerSource(store, spec, reader);
  let file: SourceFileSnapshot;
  try {
    file = await store.read(spec.path, {
      allowedRoot: spec.allowedRoot,
      createMode: spec.createMode,
      maxBytes: spec.maxBytes,
    });
  } catch {
    return {
      spec,
      file: null,
      parsed: null,
      state: "permission-denied",
      error: "The file could not be read.",
    };
  }
  if (file.state === "absent") return { spec, file, parsed: null, state: "absent" };
  if (file.state !== "ok" || file.text === null) {
    return {
      spec,
      file,
      parsed: null,
      state: file.state === "invalid" ? "invalid" : file.state,
      error: file.error,
    };
  }
  try {
    const parsed = parseSource(spec, file.text);
    return {
      spec,
      file,
      parsed,
      state: parsed.addBlock ? "unsupported-layout" : "ok",
      error: parsed.addBlock,
    };
  } catch (error) {
    const detail = mcpManagementErrorFromUnknown(error);
    return {
      spec,
      file,
      parsed: null,
      state: "invalid",
      error: detail?.message ?? "The file could not be parsed.",
    };
  }
}

export async function loadCatalog(
  store: McpSourceStore,
  specs: readonly SourceSpec[],
  reader?: ContainerFileReader,
): Promise<LoadedCatalog> {
  const sources = await Promise.all(specs.map((spec) => loadSource(store, spec, reader)));
  const entries: LoadedEntry[] = [];
  for (const source of sources) {
    const codec = PROVIDER_CODECS[source.spec.provider];
    if (source.spec.format === "runtime") {
      for (const name of source.spec.runtimeNames ?? []) {
        entries.push({
          entryId: entryIdFor(source.spec.sourceId, name),
          source,
          name,
          raw: null,
          definition: null,
          injected: true,
        });
      }
      continue;
    }
    if (!source.parsed) continue;
    for (const [name, raw] of source.parsed.entries) {
      entries.push({
        entryId: entryIdFor(source.spec.sourceId, name),
        source,
        name,
        raw,
        definition: codec.decode(raw),
        issue: source.parsed.entryIssues.get(name),
        injected: false,
      });
    }
    for (const [name, issue] of source.parsed.entryIssues) {
      if (!source.parsed.entries.has(name)) {
        entries.push({
          entryId: entryIdFor(source.spec.sourceId, name),
          source,
          name,
          raw: null,
          definition: null,
          issue,
          injected: false,
        });
      }
    }
  }
  return { sources, entries };
}

/** The runtime identity two same-provider entries collide on. */
function identityOf(entry: LoadedEntry): string {
  if (entry.source.spec.provider === "pi")
    return piSanitizedName(entry.name) ?? `\u0000${entry.name}`;
  return entry.name;
}

function isCandidate(entry: LoadedEntry): boolean {
  if (entry.source.spec.excludedReason) return false;
  // The Pi bridge skips a disabled entry entirely, so a lower one takes over.
  if (entry.source.spec.provider === "pi" && entry.definition?.enabled === false) return false;
  return true;
}

export interface EffectiveView {
  /** identity -> winning entry */
  winners: Map<string, LoadedEntry>;
  /** entryId -> entries it hides */
  shadows: Map<string, LoadedEntry[]>;
}

export function computeEffective(entries: readonly LoadedEntry[]): EffectiveView {
  const groups = new Map<string, LoadedEntry[]>();
  for (const entry of entries) {
    if (!isCandidate(entry)) continue;
    const identity = identityOf(entry);
    const group = groups.get(identity) ?? [];
    group.push(entry);
    groups.set(identity, group);
  }
  const winners = new Map<string, LoadedEntry>();
  const shadows = new Map<string, LoadedEntry[]>();
  for (const [identity, group] of groups) {
    group.sort((left, right) => right.source.spec.precedence - left.source.spec.precedence);
    const winner = group[0]!;
    winners.set(identity, winner);
    shadows.set(winner.entryId, group.slice(1));
  }
  // An injected connection wins over any file entry claiming a protected name.
  for (const entry of entries) {
    if (entry.injected || !isProtectedMcpServerName(entry.name)) continue;
    const injected = entries.find(
      (candidate) => candidate.injected && candidate.name === entry.name,
    );
    if (injected && winners.get(identityOf(entry)) !== injected) {
      const hidden = shadows.get(injected.entryId) ?? [];
      if (!hidden.includes(entry)) hidden.push(entry);
      shadows.set(injected.entryId, hidden);
    }
  }
  return { winners, shadows };
}

/** The entry that becomes effective when `entry` is removed, if any. */
export function revealedBy(
  entries: readonly LoadedEntry[],
  entry: LoadedEntry,
): LoadedEntry | undefined {
  const identity = identityOf(entry);
  const remaining = entries.filter(
    (candidate) =>
      candidate !== entry && isCandidate(candidate) && identityOf(candidate) === identity,
  );
  remaining.sort((left, right) => right.source.spec.precedence - left.source.spec.precedence);
  const view = computeEffective(entries);
  return view.winners.get(identity) === entry ? remaining[0] : undefined;
}

export function sameIdentityEntries(
  entries: readonly LoadedEntry[],
  provider: string,
  name: string,
): LoadedEntry[] {
  const probe = provider === "pi" ? (piSanitizedName(name) ?? `\u0000${name}`) : name;
  return entries.filter((entry) => identityOf(entry) === probe);
}

const allowed: McpCapabilityFlag = { supported: true };
const denied = (reason: string): McpCapabilityFlag => ({ supported: false, reason });

/** Why a row cannot be edited, in priority order. */
export function entryEditBlock(
  entry: LoadedEntry,
  capabilities: McpTargetCapabilities,
  targetReadOnly?: string,
): string | undefined {
  if (targetReadOnly) return targetReadOnly;
  if (entry.injected) return entry.source.spec.readOnlyReason;
  if (!entry.source.spec.writable)
    return entry.source.spec.readOnlyReason ?? "This source is read-only.";
  if (entry.source.file?.writeBlock) return entry.source.file.writeBlock;
  if (entry.issue) return entry.issue;
  if (!entry.definition) return "The entry could not be read.";
  if (entry.definition.unsupportedReason) return entry.definition.unsupportedReason;
  if (entry.definition.invalidReason)
    return `${entry.definition.invalidReason} Fix it in the file, or remove the entry.`;
  if (
    entry.definition.transport !== "unknown" &&
    !capabilities.transports[entry.definition.transport].supported
  ) {
    return capabilities.transports[entry.definition.transport].reason;
  }
  return undefined;
}

function entryActions(
  entry: LoadedEntry,
  capabilities: McpTargetCapabilities,
  targetReadOnly?: string,
): McpDefinitionSummary["actions"] {
  const editBlock = entryEditBlock(entry, capabilities, targetReadOnly);
  // Removal needs a writable, unambiguous source, but tolerates an entry the
  // form cannot represent: removing it is how a user repairs one.
  const removeBlock =
    targetReadOnly ??
    (entry.injected
      ? entry.source.spec.readOnlyReason
      : !entry.source.spec.writable
        ? (entry.source.spec.readOnlyReason ?? "This source is read-only.")
        : (entry.source.file?.writeBlock ?? entry.issue));
  // Rename moves the native entry verbatim, so it needs exactly what removal needs.
  const renameBlock = removeBlock;
  const setEnabled = !capabilities.operations.setEnabled.supported
    ? capabilities.operations.setEnabled
    : editBlock
      ? denied(editBlock)
      : allowed;
  return {
    edit: editBlock ? denied(editBlock) : allowed,
    rename: renameBlock ? denied(renameBlock) : allowed,
    remove: removeBlock ? denied(removeBlock) : allowed,
    setEnabled,
  };
}

function secretCount(definition: CanonicalDefinition | null): number {
  if (!definition) return 0;
  let count = 0;
  for (const value of [...Object.values(definition.env), ...Object.values(definition.headers)]) {
    if (!isEnvReference(value)) count += 1;
  }
  definition.args.forEach((arg, index) => {
    if (isSensitiveArg(arg, definition.args[index - 1])) count += 1;
  });
  if (definition.url && isSensitiveUrl(definition.url)) count += 1;
  return count;
}

export function summarizeEntries(
  catalog: LoadedCatalog,
  capabilities: McpTargetCapabilities,
  targetReadOnly?: string,
): { definitions: McpDefinitionSummary[]; effective: Record<string, string> } {
  const view = computeEffective(catalog.entries);
  const winnerOf = new Map<string, LoadedEntry>();
  for (const [identity, winner] of view.winners) winnerOf.set(identity, winner);
  const definitions: McpDefinitionSummary[] = [];
  for (const entry of catalog.entries) {
    const definition = entry.definition;
    const identity = identityOf(entry);
    const winner = winnerOf.get(identity);
    const injectedWinner =
      !entry.injected && isProtectedMcpServerName(entry.name)
        ? catalog.entries.find((candidate) => candidate.injected && candidate.name === entry.name)
        : undefined;
    let status: McpDefinitionSummary["status"];
    let statusReason: string | undefined;
    let shadowedBy: string | undefined;
    if (entry.injected) {
      status = "protected";
      statusReason = "Orkestrator's own connection.";
    } else if (entry.source.spec.excludedReason) {
      status = "policy-excluded";
      statusReason = entry.source.spec.excludedReason;
    } else if (injectedWinner) {
      status = "shadowed";
      shadowedBy = injectedWinner.entryId;
      statusReason = "Orkestrator's own connection uses this name, so this entry is never loaded.";
    } else if (!definition || entry.issue) {
      status = "invalid";
      statusReason = entry.issue ?? "The entry could not be read.";
    } else if (definition.invalidReason) {
      status = "invalid";
      statusReason = definition.invalidReason;
    } else if (definition.unsupportedReason) {
      status = "unsupported";
      statusReason = definition.unsupportedReason;
    } else if (winner && winner !== entry) {
      status = "shadowed";
      shadowedBy = winner.entryId;
      statusReason = `Overridden by ${winner.source.spec.label}.`;
      const note = PROVIDER_CODECS[entry.source.spec.provider].mergeNote;
      if (note) statusReason += ` ${note}`;
    } else if (definition.enabled === false) {
      status = "disabled";
      statusReason =
        entry.source.spec.provider === "pi" && winner && winner !== entry
          ? "Disabled; a lower-priority entry with this name is used instead."
          : "Disabled in the saved configuration.";
    } else if (!winner && entry.source.spec.provider === "pi") {
      status = "disabled";
      statusReason = "Disabled in the saved configuration.";
    } else {
      status = "effective";
    }
    const actions = entryActions(entry, capabilities, targetReadOnly);
    definitions.push({
      entryId: entry.entryId,
      sourceId: entry.source.spec.sourceId,
      name: entry.name,
      transport: definition?.transport ?? (entry.injected ? "http" : "unknown"),
      enabled: definition?.enabled ?? null,
      status,
      statusReason,
      shadowedBy,
      shadows: (view.shadows.get(entry.entryId) ?? []).map((hidden) => hidden.entryId),
      command: definition?.command !== undefined ? visibleCommand(definition.command) : undefined,
      argCount: definition ? definition.args.length : undefined,
      url: definition?.url !== undefined ? visibleUrl(definition.url) : undefined,
      readOnlyReason: actions.edit.supported ? undefined : actions.edit.reason,
      actions,
      preservedFields: definition?.preservedFields ?? [],
      secretCount: secretCount(definition),
    });
  }
  const effective: Record<string, string> = {};
  for (const [, winner] of view.winners) effective[winner.name] = winner.entryId;
  for (const entry of catalog.entries) if (entry.injected) effective[entry.name] = entry.entryId;
  return { definitions, effective };
}

export function publicSource(source: LoadedSource): McpConfigSource {
  const spec = source.spec;
  const writeBlock = source.file?.writeBlock;
  const stateBlock =
    source.state === "invalid" ||
    source.state === "oversized" ||
    source.state === "permission-denied"
      ? (source.error ?? "The file cannot be edited safely.")
      : undefined;
  const readOnlyReason = !spec.writable ? spec.readOnlyReason : (writeBlock ?? stateBlock);
  return {
    sourceId: spec.sourceId,
    scope: spec.scope,
    owner: spec.owner,
    format: spec.format,
    label: spec.label,
    displayPath: spec.displayPath,
    precedence: spec.precedence,
    state: source.state,
    error: source.error ? truncateUtf8(source.error, 512) : undefined,
    writable: spec.writable && !readOnlyReason,
    readOnlyReason,
    revision: spec.format === "runtime" ? null : (source.file?.revision ?? null),
    sharedWith: spec.sharedWith,
    trust: spec.trust,
    trustReason: spec.trustReason,
  };
}

function mapSummary(map: Record<string, string>): McpMapEntrySummary[] {
  return Object.entries(map).map(([key, value]) =>
    isEnvReference(value)
      ? { key, presence: "reference", reference: value }
      : { key, presence: "literal" },
  );
}

export function editableDefinition(
  entry: LoadedEntry,
  capabilities: McpTargetCapabilities,
  targetReadOnly?: string,
): McpEditableDefinition {
  const definition = entry.definition;
  const block = entryEditBlock(entry, capabilities, targetReadOnly);
  return {
    entryId: entry.entryId,
    sourceId: entry.source.spec.sourceId,
    sourceRevision: entry.source.file?.revision ?? "",
    name: entry.name,
    transport: definition?.transport ?? "unknown",
    enabled: definition?.enabled ?? null,
    command: definition?.command !== undefined ? visibleCommand(definition.command) : undefined,
    args: definition ? visibleArgs(definition.args) : [],
    cwd: definition?.cwd,
    url: definition?.url !== undefined ? visibleUrl(definition.url) : undefined,
    env: definition ? mapSummary(definition.env) : [],
    headers: definition ? mapSummary(definition.headers) : [],
    advanced: definition ? { ...definition.advanced } : {},
    preservedFields: definition?.preservedFields ?? [],
    readOnlyReason: block,
  };
}
