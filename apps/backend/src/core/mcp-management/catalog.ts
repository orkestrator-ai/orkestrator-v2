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

import { PI_SERVERS_PER_FILE, PROVIDER_CODECS, piLoadBlock, piSanitizedName } from "./codecs.js";
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
  /** Position within its source, in the order the provider reads it. */
  order: number;
  /**
   * Several entries in one source reach the provider under the same runtime
   * name (Pi normalizes names). Editing and renaming are blocked; removal is not.
   */
  conflict?: string;
  /** The provider silently skips this entry when it loads the source. */
  skipReason?: string;
  /** Disabled by a setting outside the entry (Grok's `disabled_mcp_servers`). */
  disabledReason?: string;
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

/** Inline configuration: parsed like a file, never written. */
async function loadInlineSource(
  store: McpSourceStore,
  spec: SourceSpec,
  text: string,
): Promise<LoadedSource> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > spec.maxBytes) {
    return {
      spec,
      file: null,
      parsed: null,
      state: "oversized",
      error: "Too large to read safely.",
    };
  }
  const file: SourceFileSnapshot = {
    path: spec.path,
    realPath: spec.path,
    mode: null,
    writeBlock: spec.readOnlyReason ?? "This configuration is read-only.",
    state: "ok",
    text,
    revision: await store.revisionOf(bytes),
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
  } catch {
    // Never echo inline content: it may be a credential-bearing environment value.
    return {
      spec,
      file,
      parsed: null,
      state: "invalid",
      error: "The inline configuration could not be parsed.",
    };
  }
}

export async function loadSource(
  store: McpSourceStore,
  spec: SourceSpec,
  reader?: ContainerFileReader,
): Promise<LoadedSource> {
  if (spec.format === "runtime") return { spec, file: null, parsed: null, state: "ok" };
  if (spec.inlineText !== undefined) return loadInlineSource(store, spec, spec.inlineText);
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
          order: entries.length,
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
        order: entries.length,
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
          order: entries.length,
        });
      }
    }
  }
  markPiLoadRules(entries);
  markGrokDisabledList(sources, entries);
  return { sources, entries };
}

/**
 * Grok skips every server named in a top-level `disabled_mcp_servers` list of
 * its user or managed configuration, whichever source defines the server.
 */
function markGrokDisabledList(sources: readonly LoadedSource[], entries: LoadedEntry[]): void {
  const listedBy = new Map<string, string>();
  for (const source of sources) {
    const spec = source.spec;
    if (spec.provider !== "grok" || spec.format !== "toml") continue;
    if (spec.owner !== "native-user" && spec.owner !== "managed-policy") continue;
    const document = source.parsed?.document as Record<string, unknown> | undefined;
    const list = document?.disabled_mcp_servers;
    if (!Array.isArray(list)) continue;
    for (const name of list)
      if (typeof name === "string" && !listedBy.has(name)) listedBy.set(name, spec.displayPath);
  }
  if (!listedBy.size) return;
  for (const entry of entries) {
    if (entry.injected || entry.source.spec.provider !== "grok") continue;
    const where = listedBy.get(entry.name);
    if (where) entry.disabledReason = `Disabled: listed in disabled_mcp_servers in ${where}.`;
  }
}

/**
 * Mirror how the Pi bridge reads one file: it skips entries it cannot
 * normalize, stops after {@link PI_SERVERS_PER_FILE} accepted servers, and
 * lets the last of several entries with the same normalized name win.
 */
function markPiLoadRules(entries: LoadedEntry[]): void {
  const bySource = new Map<LoadedSource, LoadedEntry[]>();
  for (const entry of entries) {
    if (entry.injected || entry.source.spec.provider !== "pi") continue;
    const list = bySource.get(entry.source) ?? [];
    list.push(entry);
    bySource.set(entry.source, list);
  }
  for (const list of bySource.values()) {
    let accepted = 0;
    const groups = new Map<string, LoadedEntry[]>();
    for (const entry of list) {
      entry.skipReason = piLoadBlock(entry.name, entry.raw);
      const id = piSanitizedName(entry.name);
      if (id) {
        const group = groups.get(id) ?? [];
        group.push(entry);
        groups.set(id, group);
      }
      if (entry.skipReason || entry.raw?.disabled === true) continue;
      if (id === "orkestrator") continue;
      if (accepted >= PI_SERVERS_PER_FILE) {
        entry.skipReason = `Pi loads at most ${PI_SERVERS_PER_FILE} servers from one file; this entry is past the limit.`;
        continue;
      }
      accepted += 1;
    }
    for (const [id, group] of groups) {
      if (group.length < 2) continue;
      const names = group.map((entry) => `"${entry.name}"`).join(", ");
      const used = [...group]
        .reverse()
        .find((entry) => !entry.skipReason && entry.raw?.disabled !== true);
      for (const entry of group) {
        const which = !used
          ? "none of them is loaded"
          : used === entry
            ? "this is the one Pi uses, because it comes last"
            : `Pi uses "${used.name}", which comes last`;
        entry.conflict =
          `Pi reads ${names} in this file as the same server "${id}"; ${which}. ` +
          "Remove the duplicates so exactly one remains.";
      }
    }
  }
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
  if (entry.skipReason || entry.disabledReason) return false;
  return true;
}

/** Highest precedence first; within one source the later entry wins. */
function byPriority(left: LoadedEntry, right: LoadedEntry): number {
  return (
    right.source.spec.precedence - left.source.spec.precedence ||
    (left.source === right.source ? right.order - left.order : 0)
  );
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
    group.sort(byPriority);
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
  remaining.sort(byPriority);
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
  if (entry.conflict) return entry.conflict;
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

/**
 * What blocks a rename beyond what blocks removal. Rename moves the native
 * entry verbatim, so it needs everything removal needs; a same-source name
 * conflict additionally blocks it, because renaming one duplicate silently
 * changes which of them the provider loads.
 */
export function entryRenameBlock(entry: LoadedEntry): string | undefined {
  return entry.conflict;
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
  const renameBlock = removeBlock ?? entryRenameBlock(entry);
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
    } else if (entry.conflict) {
      status = "invalid";
      statusReason = entry.conflict;
    } else if (definition.invalidReason) {
      status = "invalid";
      statusReason = definition.invalidReason;
    } else if (definition.unsupportedReason) {
      status = "unsupported";
      statusReason = definition.unsupportedReason;
    } else if (entry.disabledReason) {
      status = "disabled";
      statusReason = entry.disabledReason;
    } else if (entry.source.spec.provider === "pi" && definition.enabled === false) {
      // Pi drops a disabled entry before resolving names, so it never shadows
      // anything; whichever entry wins is used in its place.
      status = "disabled";
      if (winner && winner !== entry) {
        statusReason =
          byPriority(entry, winner) < 0
            ? `Disabled; the lower-priority entry in ${winner.source.spec.label} is used instead.`
            : `Disabled; ${winner.source.spec.label} also defines this name and takes priority.`;
      } else {
        statusReason = "Disabled in the saved configuration.";
      }
    } else if (entry.skipReason) {
      status = "invalid";
      statusReason = entry.skipReason;
      if (winner && winner !== entry && byPriority(entry, winner) < 0)
        statusReason += ` The lower-priority entry in ${winner.source.spec.label} is used instead.`;
    } else if (winner && winner !== entry) {
      status = "shadowed";
      shadowedBy = winner.entryId;
      statusReason = `Overridden by ${winner.source.spec.label}.`;
      const note = PROVIDER_CODECS[entry.source.spec.provider].mergeNote;
      if (note) statusReason += ` ${note}`;
    } else if (definition.enabled === false) {
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
      enabled: entry.disabledReason ? false : (definition?.enabled ?? null),
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
