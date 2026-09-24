/**
 * The executable command catalogue contract (version 1).
 *
 * Discovery used to hand the composer display records only, and each provider
 * then guessed what an inserted string meant. This module is the one place
 * that turns untrusted catalogue payloads into bounded descriptors, and the one
 * place that parses the explicit command selection a prompt may carry.
 *
 * Every limit is a UTF-8 byte ceiling. Identity fields (name, id, alias) are
 * rejected when they exceed their limit rather than truncated: a truncated
 * name is a *different* command. Presentation text (description, hint,
 * availability message) is truncated with a marker.
 */
import {
  NATIVE_AGENT_COMMAND_CATALOGUE_ERROR_CODES,
  NATIVE_AGENT_COMMAND_EXECUTION_KINDS,
  NATIVE_AGENT_COMMAND_ORIGINS,
  NATIVE_AGENT_COMMAND_UNAVAILABLE_REASONS,
  type NativeAgentCommandAvailability,
  type NativeAgentCommandCatalogueErrorCode,
  type NativeAgentCommandCatalogueState,
  type NativeAgentCommandExecutionKind,
  type NativeAgentCommandInputPolicy,
  type NativeAgentCommandIntent,
  type NativeAgentCommandOrigin,
  type NativeAgentResolvedCommandRecord,
  type NativeAgentSlashCommand,
  type NativeAgentSlashCommandSource,
} from "./native-agent.js";
import type { AgentPlatform } from "./agent-platforms.js";

/** Wire version a bridge sets on an enhanced catalogue response. */
export const NATIVE_AGENT_COMMAND_CATALOGUE_VERSION = 1 as const;

export const COMMAND_CATALOGUE_LIMITS = Object.freeze({
  maxCommands: 512,
  maxNameBytes: 256,
  maxIdBytes: 256,
  maxAliasesPerCommand: 16,
  maxAliasesTotal: 2_048,
  maxDescriptionBytes: 1_000,
  maxArgumentHintBytes: 512,
  maxAvailabilityMessageBytes: 512,
  maxBindingRevisionBytes: 128,
  /** Serialized catalogue response budget. */
  maxWireBytes: 512 * 1024,
  /** Argument suffix a selected invocation may carry to a bridge. */
  maxArgumentBytes: 256 * 1024,
});

const SOURCES: ReadonlySet<string> = new Set<NativeAgentSlashCommandSource>([
  "builtin",
  "project",
  "user",
  "plugin",
  "skill",
  "template",
  "extension",
  "orkestrator",
  "unknown",
]);
const EXECUTION_KINDS: ReadonlySet<string> = new Set(NATIVE_AGENT_COMMAND_EXECUTION_KINDS);
const ORIGINS: ReadonlySet<string> = new Set(NATIVE_AGENT_COMMAND_ORIGINS);
const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set(NATIVE_AGENT_COMMAND_UNAVAILABLE_REASONS);
const ERROR_CODES: ReadonlySet<string> = new Set(NATIVE_AGENT_COMMAND_CATALOGUE_ERROR_CODES);

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  // Fast path: pure ASCII needs no encoding.
  // oxlint-disable-next-line no-control-regex -- ASCII range check, not a control-character match
  if (/^[\x00-\x7f]*$/.test(value)) return value.length;
  return encoder.encode(value).byteLength;
}

/**
 * Truncate presentation text to a byte budget without splitting a code point,
 * appending an ellipsis when anything was dropped.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  const marker = "…";
  const budget = Math.max(0, maxBytes - utf8ByteLength(marker));
  let bytes = 0;
  let out = "";
  for (const char of value) {
    const size = utf8ByteLength(char);
    if (bytes + size > budget) break;
    bytes += size;
    out += char;
  }
  return `${out}${marker}`;
}

/**
 * Stable, dependency-free binding fingerprint (FNV-1a, 64-bit, hex).
 *
 * Not a security primitive — IDs and revisions are lookup keys the executor
 * revalidates. It only has to change when the execution meaning changes and
 * be computable identically in a bridge, the backend and a browser.
 */
export function commandBindingRevision(parts: readonly string[]): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const part of parts) {
    for (const byte of encoder.encode(part)) {
      hash ^= BigInt(byte);
      hash = (hash * prime) & mask;
    }
    // Separator so ["ab","c"] and ["a","bc"] differ.
    hash ^= 0xffn;
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedIdentity(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.trim() !== value || /\s/.test(value)) return undefined;
  return utf8ByteLength(value) <= maxBytes ? value : undefined;
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? truncateUtf8(trimmed, maxBytes) : undefined;
}

/** Normalize a command name to its display form with a single leading sigil. */
export function displayCommandName(name: string): string {
  return name.startsWith("/") || name.startsWith("$") ? name : `/${name}`;
}

function normalizeAvailability(value: unknown): NativeAgentCommandAvailability | undefined {
  if (!isRecord(value)) return undefined;
  if (value.state !== "available" && value.state !== "unavailable") return undefined;
  const reason =
    typeof value.reason === "string" && UNAVAILABLE_REASONS.has(value.reason)
      ? (value.reason as NativeAgentCommandAvailability["reason"])
      : undefined;
  const message = boundedText(value.message, COMMAND_CATALOGUE_LIMITS.maxAvailabilityMessageBytes);
  if (value.state === "available") return { state: "available" };
  return {
    state: "unavailable",
    // An unavailable row without an allowlisted reason is still unavailable;
    // never read a malformed reason as permission to run it.
    reason: reason ?? "unsupported",
    ...(message ? { message } : {}),
  };
}

function normalizeInputPolicy(value: unknown): NativeAgentCommandInputPolicy | undefined {
  if (!isRecord(value)) return undefined;
  const policy: NativeAgentCommandInputPolicy = {};
  if (
    value.arguments === "none" ||
    value.arguments === "optional" ||
    value.arguments === "required"
  ) {
    policy.arguments = value.arguments;
  }
  if (
    value.attachments === "none" ||
    value.attachments === "images" ||
    value.attachments === "any"
  ) {
    policy.attachments = value.attachments;
  }
  if (value.busy === "queue" || value.busy === "idle" || value.busy === "running") {
    policy.busy = value.busy;
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

export interface NormalizedCommandCatalogue {
  /** True only when the payload declared catalogue version 1. */
  enhanced: boolean;
  commands: NativeAgentSlashCommand[];
  /** Rows were dropped for count/alias budgets or invalid identity. */
  truncated: boolean;
  /** Rows rejected for malformed identity (counted, never logged by name). */
  rejected: number;
  /**
   * Bridge-reported status for this list, when supplied. `missing` is an
   * enhanced bridge answering an unknown session in band — never a reason to
   * fall back to a global list.
   */
  status?: "ready" | "stale" | "unsupported" | "missing";
  revision?: number;
  generation?: string;
  freshness?: "push" | "ttl";
}

/**
 * Normalize one untrusted catalogue payload.
 *
 * Accepts `{ commands: [...] }` with either strings or records. A payload
 * with `catalogueVersion: 1` is enhanced: its rows must carry an `id` and an
 * `executionKind`, or they are dropped, because an enhanced bridge promised to
 * execute exactly what it listed. Legacy rows keep today's meaning — ordinary
 * prompt text — and get a synthetic, clearly-legacy identity.
 */
export function normalizeCommandCataloguePayload(
  payload: unknown,
  options: { defaultSource?: NativeAgentSlashCommandSource } = {},
): NormalizedCommandCatalogue {
  const record = isRecord(payload) ? payload : {};
  const enhanced = record.catalogueVersion === NATIVE_AGENT_COMMAND_CATALOGUE_VERSION;
  const rows = Array.isArray(record.commands) ? record.commands : [];
  const byId = new Map<string, NativeAgentSlashCommand>();
  let truncated = record.truncated === true || rows.length > COMMAND_CATALOGUE_LIMITS.maxCommands;
  let rejected = 0;
  let aliasBudget = COMMAND_CATALOGUE_LIMITS.maxAliasesTotal;
  for (const candidate of rows.slice(0, COMMAND_CATALOGUE_LIMITS.maxCommands)) {
    const row = typeof candidate === "string" ? { name: candidate } : candidate;
    if (!isRecord(row)) {
      rejected += 1;
      continue;
    }
    const rawName = boundedIdentity(row.name, COMMAND_CATALOGUE_LIMITS.maxNameBytes - 1);
    if (!rawName) {
      rejected += 1;
      continue;
    }
    const name = displayCommandName(rawName);
    const source =
      typeof row.source === "string" && SOURCES.has(row.source)
        ? (row.source as NativeAgentSlashCommandSource)
        : (options.defaultSource ?? "unknown");
    let id: string | undefined;
    let executionKind: NativeAgentCommandExecutionKind | undefined;
    if (enhanced) {
      id = boundedIdentity(row.id, COMMAND_CATALOGUE_LIMITS.maxIdBytes);
      executionKind =
        typeof row.executionKind === "string" && EXECUTION_KINDS.has(row.executionKind)
          ? (row.executionKind as NativeAgentCommandExecutionKind)
          : undefined;
      // Session actions are the backend's own; a bridge cannot mint one.
      if (!id || !executionKind || executionKind === "session-action") {
        rejected += 1;
        continue;
      }
    } else {
      id = legacyCommandId(name);
    }
    if (byId.has(id)) {
      // Duplicate identity: the first row wins, deterministically.
      rejected += 1;
      continue;
    }
    const aliases: string[] = [];
    if (Array.isArray(row.aliases)) {
      for (const alias of row.aliases.slice(0, COMMAND_CATALOGUE_LIMITS.maxAliasesPerCommand)) {
        const bounded = boundedIdentity(alias, COMMAND_CATALOGUE_LIMITS.maxNameBytes - 1);
        if (!bounded) continue;
        if (aliasBudget <= 0) {
          truncated = true;
          break;
        }
        const display = displayCommandName(bounded);
        if (display !== name && !aliases.includes(display)) {
          aliases.push(display);
          aliasBudget -= 1;
        }
      }
    }
    const description = boundedText(row.description, COMMAND_CATALOGUE_LIMITS.maxDescriptionBytes);
    const argumentHint = boundedText(
      row.argumentHint ?? row.inputHint,
      COMMAND_CATALOGUE_LIMITS.maxArgumentHintBytes,
    );
    const insertText = boundedIdentity(row.insertText, COMMAND_CATALOGUE_LIMITS.maxNameBytes);
    const origin =
      typeof row.origin === "string" && ORIGINS.has(row.origin)
        ? (row.origin as NativeAgentCommandOrigin)
        : undefined;
    const bindingRevision = boundedIdentity(
      row.bindingRevision,
      COMMAND_CATALOGUE_LIMITS.maxBindingRevisionBytes,
    );
    const availability = normalizeAvailability(row.availability);
    const inputPolicy = normalizeInputPolicy(row.inputPolicy);
    byId.set(id, {
      name,
      source,
      id,
      executionKind: executionKind ?? "provider-prompt",
      ...(description ? { description } : {}),
      ...(argumentHint ? { argumentHint } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(row.scope === "global" || row.scope === "session" ? { scope: row.scope } : {}),
      ...(insertText && insertText !== name ? { insertText } : {}),
      ...(origin ? { origin } : {}),
      ...(availability ? { availability } : {}),
      ...(inputPolicy ? { inputPolicy } : {}),
      bindingRevision: bindingRevision ?? (enhanced ? commandBindingRevision([id]) : "legacy"),
      ...(row.caseSensitive === true ? { caseSensitive: true } : {}),
    });
  }
  const status =
    record.status === "ready" ||
    record.status === "stale" ||
    record.status === "unsupported" ||
    record.status === "missing"
      ? record.status
      : undefined;
  const revision =
    typeof record.revision === "number" &&
    Number.isSafeInteger(record.revision) &&
    record.revision >= 0
      ? record.revision
      : undefined;
  const generation =
    typeof record.generation === "string" && record.generation.length <= 256
      ? record.generation
      : typeof record.generation === "number" && Number.isSafeInteger(record.generation)
        ? String(record.generation)
        : undefined;
  const freshness =
    record.freshness === "push" || record.freshness === "ttl" ? record.freshness : undefined;
  return {
    enhanced,
    commands: [...byId.values()],
    truncated: truncated || rejected > 0,
    rejected,
    ...(status ? { status } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(generation ? { generation } : {}),
    ...(freshness ? { freshness } : {}),
  };
}

const LEGACY_ID_PREFIX = "legacy:";

/** Identity for a row from a legacy (version 0) catalogue. */
export function legacyCommandId(name: string): string {
  return `${LEGACY_ID_PREFIX}${name}`;
}

export function isLegacyCommandId(id: string): boolean {
  return id.startsWith(LEGACY_ID_PREFIX);
}

/**
 * Give every row of a list an identity so a picker can hold a selection
 * across refreshes. Rows that already carry one are returned unchanged.
 */
export function withCommandIdentities(
  commands: readonly NativeAgentSlashCommand[],
): NativeAgentSlashCommand[] {
  return commands.map((command) =>
    command.id
      ? command
      : {
          ...command,
          id: legacyCommandId(command.name),
          executionKind: command.executionKind ?? "provider-prompt",
          bindingRevision: command.bindingRevision ?? "legacy",
        },
  );
}

/** Bytes a list would occupy on the wire. Used for cache budgets. */
export function commandCatalogueBytes(commands: readonly NativeAgentSlashCommand[]): number {
  return utf8ByteLength(JSON.stringify(commands));
}

export function commandIsAvailable(command: NativeAgentSlashCommand): boolean {
  return command.availability?.state !== "unavailable";
}

export function isCommandCatalogueErrorCode(
  value: unknown,
): value is NativeAgentCommandCatalogueErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value);
}

export function parseNativeAgentCommandIntent(
  value: unknown,
): NativeAgentCommandIntent | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "literal") return { kind: "literal" };
  if (value.kind === "typed") return { kind: "typed" };
  if (value.kind !== "selected") return undefined;
  const commandId = boundedIdentity(value.commandId, COMMAND_CATALOGUE_LIMITS.maxIdBytes);
  if (!commandId) return undefined;
  const bindingRevision =
    value.bindingRevision === undefined
      ? undefined
      : boundedIdentity(value.bindingRevision, COMMAND_CATALOGUE_LIMITS.maxBindingRevisionBytes);
  if (value.bindingRevision !== undefined && !bindingRevision) return undefined;
  return { kind: "selected", commandId, ...(bindingRevision ? { bindingRevision } : {}) };
}

export function parseNativeAgentResolvedCommandRecord(
  value: unknown,
): NativeAgentResolvedCommandRecord | undefined {
  if (!isRecord(value)) return undefined;
  const intent = parseNativeAgentCommandIntent(value.intent);
  if (!intent) return undefined;
  const commandId = boundedIdentity(value.commandId, COMMAND_CATALOGUE_LIMITS.maxIdBytes);
  const name = boundedIdentity(value.name, COMMAND_CATALOGUE_LIMITS.maxNameBytes);
  const executionKind =
    typeof value.executionKind === "string" && EXECUTION_KINDS.has(value.executionKind)
      ? (value.executionKind as NativeAgentCommandExecutionKind)
      : undefined;
  const bindingRevision = boundedIdentity(
    value.bindingRevision,
    COMMAND_CATALOGUE_LIMITS.maxBindingRevisionBytes,
  );
  return {
    intent,
    ...(commandId ? { commandId } : {}),
    ...(name ? { name } : {}),
    ...(executionKind ? { executionKind } : {}),
    ...(bindingRevision ? { bindingRevision } : {}),
  };
}

/**
 * The explicit command a backend hands a bridge with a prompt.
 *
 * Carries only public identity plus the user's argument suffix. The bridge
 * resolves every private binding (skill path, template file) from its own
 * registry; nothing here can name a path or a shell command.
 */
export interface NativeAgentBridgeCommandInvocation {
  id: string;
  /** Canonical provider spelling of the resolved command. */
  name: string;
  executionKind: NativeAgentCommandExecutionKind;
  bindingRevision?: string;
  /** Argument suffix exactly as typed; may be empty. */
  arguments: string;
}

export type ParsedBridgeCommandInvocation =
  | { ok: true; invocation?: NativeAgentBridgeCommandInvocation }
  | { ok: false; error: string };

/** Validate the optional `command` field of a bridge prompt body. */
export function parseBridgeCommandInvocation(value: unknown): ParsedBridgeCommandInvocation {
  if (value === undefined || value === null) return { ok: true };
  if (!isRecord(value)) return { ok: false, error: "command must be an object" };
  const id = boundedIdentity(value.id, COMMAND_CATALOGUE_LIMITS.maxIdBytes);
  const name = boundedIdentity(value.name, COMMAND_CATALOGUE_LIMITS.maxNameBytes);
  const executionKind =
    typeof value.executionKind === "string" && EXECUTION_KINDS.has(value.executionKind)
      ? (value.executionKind as NativeAgentCommandExecutionKind)
      : undefined;
  if (!id || !name || !executionKind) return { ok: false, error: "command identity is invalid" };
  if (typeof value.arguments !== "string") {
    return { ok: false, error: "command arguments must be a string" };
  }
  if (utf8ByteLength(value.arguments) > COMMAND_CATALOGUE_LIMITS.maxArgumentBytes) {
    return { ok: false, error: "command arguments are too large" };
  }
  const bindingRevision =
    value.bindingRevision === undefined
      ? undefined
      : boundedIdentity(value.bindingRevision, COMMAND_CATALOGUE_LIMITS.maxBindingRevisionBytes);
  if (value.bindingRevision !== undefined && !bindingRevision) {
    return { ok: false, error: "command binding revision is invalid" };
  }
  return {
    ok: true,
    invocation: {
      id,
      name,
      executionKind,
      arguments: value.arguments,
      ...(bindingRevision ? { bindingRevision } : {}),
    },
  };
}

/**
 * The prompt body fields a bridge reads to decide command interpretation.
 *
 * `allowProviderCommands: false` is literal intent: the bridge must not run
 * its own command resolver (templates, local built-ins, skills) and must use
 * its provider's command-suppression mechanism where one exists.
 */
export function readBridgePromptCommandFields(body: Record<string, unknown>):
  | {
      ok: true;
      allowProviderCommands: boolean;
      command?: NativeAgentBridgeCommandInvocation;
    }
  | { ok: false; error: string } {
  if (body.allowProviderCommands !== undefined && typeof body.allowProviderCommands !== "boolean") {
    return { ok: false, error: "allowProviderCommands must be a boolean" };
  }
  const parsed = parseBridgeCommandInvocation(body.command);
  if (!parsed.ok) return parsed;
  // A legacy backend never sends the flag; it has always meant "interpret".
  const allowProviderCommands = body.allowProviderCommands !== false;
  if (parsed.invocation && !allowProviderCommands) {
    return { ok: false, error: "A literal prompt cannot carry a command selection" };
  }
  return {
    ok: true,
    allowProviderCommands,
    ...(parsed.invocation ? { command: parsed.invocation } : {}),
  };
}

/**
 * JSON error body a bridge returns (HTTP 422) when a selected command cannot
 * run. The backend reports it as a rejection, never as an ambiguous dispatch,
 * because nothing was sent.
 */
export function commandUnavailableResponse(message: string): {
  error: string;
  kind: "command-unavailable";
} {
  return { error: truncateUtf8(message, 1_024), kind: "command-unavailable" };
}

/**
 * Whether a provider can guarantee that literal text is not interpreted as a
 * command. Where it cannot (the Claude SDK and ACP interpret prompt text
 * themselves), the backend refuses a literal submission whose leading token
 * names a known command rather than silently running it.
 */
export function literalCommandSuppression(platform: AgentPlatform): boolean {
  return !(platform === "claude" || platform === "grok");
}

/**
 * The enhanced catalogue response a bridge serves from its command routes.
 * Old clients read `commands` only; every legacy field is still present.
 */
export interface BridgeCommandCatalogueResponse {
  catalogueVersion: typeof NATIVE_AGENT_COMMAND_CATALOGUE_VERSION;
  status: "ready" | "stale" | "unsupported" | "missing";
  commands: NativeAgentSlashCommand[];
  revision?: number;
  generation?: string;
  freshness?: "push" | "ttl";
  truncated?: boolean;
}

/** Catalogue state for an integration with no provider command surface. */
export function unsupportedCommandCatalogueState(revision = 0): NativeAgentCommandCatalogueState {
  return { status: "unsupported", revision, enhanced: true };
}
