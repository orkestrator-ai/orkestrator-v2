/**
 * The ACP command inventory and the enhanced catalogue (version 1) built on it.
 *
 * ACP has no `commands/list` request. An agent *pushes* its full inventory as
 * `available_commands_update`, each one replacing the last, and a command runs
 * as ordinary `session/prompt` text (`/name args`). So this module only
 * normalizes what the agent pushed, reports how authoritative that list is,
 * and checks a selected command against it before the prompt route sends the
 * canonical text.
 *
 * Authority is scoped to this bridge process. A list restored from the state
 * file is shown (`stale`) so the picker is not empty after a restart, but it
 * never authorizes execution: the agent may have removed a command while the
 * bridge was down. It becomes authoritative again only when the live agent
 * re-reports its inventory, which replaces the restored rows outright.
 */
import { randomBytes } from "node:crypto";
import {
  COMMAND_CATALOGUE_LIMITS,
  NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
  commandBindingRevision,
  truncateUtf8,
  utf8ByteLength,
  type BridgeCommandCatalogueResponse,
  type NativeAgentBridgeCommandInvocation,
} from "@orkestrator/protocol/agent-command-catalogue";
import type { NativeAgentSlashCommand } from "@orkestrator/protocol/native-agent";
import { isObject, provider, type JsonObject, type SessionState } from "./acp-context.js";

/**
 * Identifies this bridge process's command authority. A restart changes it, so
 * a backend can tell a revision counted by a predecessor from one of ours.
 */
export const COMMAND_CATALOGUE_GENERATION = `${provider}:${randomBytes(8).toString("hex")}`;

/** Headroom under the response budget for the envelope around the rows. */
const COMMAND_ROWS_BYTE_BUDGET = COMMAND_CATALOGUE_LIMITS.maxWireBytes - 16 * 1024;

const PROVIDER_LABEL = `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;

export interface NormalizedAcpCommands {
  commands: NativeAgentSlashCommand[];
  /** Advertised rows were dropped: over a count/byte budget, malformed or duplicate. */
  truncated: boolean;
}

function commandId(name: string): string {
  return `${provider}:${name}`;
}

/**
 * The provider's own spelling, without the display sigil.
 *
 * Namespaces (`plugin:name`, `dir/name`) are kept verbatim. A name that is
 * empty, contains whitespace or control characters, or does not fit the
 * identity budgets is rejected: truncating it would list — and later send —
 * a different command from the one the agent advertised.
 */
function canonicalCommandName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.startsWith("/") ? value.slice(1) : value;
  // oxlint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (!name || /[\s\u0000-\u001f\u007f]/u.test(name)) return undefined;
  // The display name adds one byte for its leading `/`.
  if (utf8ByteLength(name) + 1 > COMMAND_CATALOGUE_LIMITS.maxNameBytes) return undefined;
  if (utf8ByteLength(commandId(name)) > COMMAND_CATALOGUE_LIMITS.maxIdBytes) return undefined;
  return name;
}

/** Presentation text is truncated, never rejected, without splitting a code point. */
function presentationText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // Every UTF-16 unit is at least one byte, so this cut cannot hide an
  // overflow; it only keeps a hostile megabyte out of the byte counter.
  const trimmed = value.trim().slice(0, maxBytes + 1);
  return trimmed ? truncateUtf8(trimmed, maxBytes) : undefined;
}

/**
 * Standard ACP nests the hint as `input.hint` (`UnstructuredCommandInput`).
 * `inputHint` and `argumentHint` are pre-standard spellings, read only when
 * the standard field is absent so they can never override it.
 */
function advertisedArgumentHint(candidate: JsonObject): string | undefined {
  const max = COMMAND_CATALOGUE_LIMITS.maxArgumentHintBytes;
  const input = isObject(candidate.input) ? candidate.input : undefined;
  return (
    presentationText(input?.hint, max) ??
    presentationText(candidate.inputHint, max) ??
    presentationText(candidate.argumentHint, max)
  );
}

function commandRow(
  name: string,
  description: string | undefined,
  argumentHint: string | undefined,
): NativeAgentSlashCommand {
  return {
    name: `/${name}`,
    id: commandId(name),
    executionKind: "provider-prompt",
    // Being advertised over ACP says how a command arrived, not who owns it.
    // The agent sends no provenance, so none is claimed.
    source: "unknown",
    scope: "session",
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    bindingRevision: commandBindingRevision([provider, name]),
  };
}

function normalizeRows(
  rows: readonly unknown[],
  read: (candidate: JsonObject) => { name: unknown; description: unknown; argumentHint?: string },
): NormalizedAcpCommands {
  const commands: NativeAgentSlashCommand[] = [];
  const seen = new Set<string>();
  let truncated = rows.length > COMMAND_CATALOGUE_LIMITS.maxCommands;
  let bytes = 0;
  for (const candidate of rows.slice(0, COMMAND_CATALOGUE_LIMITS.maxCommands)) {
    if (!isObject(candidate)) {
      truncated = true;
      continue;
    }
    const fields = read(candidate);
    const name = canonicalCommandName(fields.name);
    // First advertisement of a name wins, so the result does not depend on
    // which duplicate a map happened to keep.
    if (!name || seen.has(name)) {
      truncated = true;
      continue;
    }
    const row = commandRow(
      name,
      presentationText(fields.description, COMMAND_CATALOGUE_LIMITS.maxDescriptionBytes),
      fields.argumentHint,
    );
    const size = utf8ByteLength(JSON.stringify(row)) + 1;
    if (bytes + size > COMMAND_ROWS_BYTE_BUDGET) {
      truncated = true;
      break;
    }
    bytes += size;
    seen.add(name);
    commands.push(row);
  }
  return { commands, truncated };
}

/** Normalize one `available_commands_update.availableCommands` list. */
export function normalizeAdvertisedCommands(rows: readonly unknown[]): NormalizedAcpCommands {
  return normalizeRows(rows, (candidate) => ({
    name: candidate.name,
    description: candidate.description,
    argumentHint: advertisedArgumentHint(candidate),
  }));
}

/**
 * Rebuild persisted public rows. Identity (`id`, `bindingRevision`) is derived
 * again from the name rather than trusted from disk.
 */
export function restorePersistedCommands(rows: readonly unknown[]): NormalizedAcpCommands {
  return normalizeRows(rows, (candidate) => ({
    name: candidate.name,
    description: candidate.description,
    argumentHint: presentationText(
      candidate.argumentHint,
      COMMAND_CATALOGUE_LIMITS.maxArgumentHintBytes,
    ),
  }));
}

/**
 * Apply a pushed inventory. It replaces the previous list completely — an
 * empty list removes every command — and is authoritative because the agent
 * attached to this process sent it.
 */
export function applyCommandInventory(state: SessionState, rows: readonly unknown[]): void {
  const normalized = normalizeAdvertisedCommands(rows);
  state.availableCommands = normalized.commands;
  state.commandsTruncated = normalized.truncated || undefined;
  state.commandsLive = true;
  state.commandsRevision = (state.commandsRevision ?? 0) + 1;
}

/**
 * The enhanced catalogue for one session, or `missing` for none.
 *
 * `ready` is reserved for an inventory the agent pushed to this process —
 * including a pushed empty list, which really does mean "no commands". Every
 * other case is `stale`: rows restored from a predecessor process, or no
 * inventory at all yet (`commands: []`). ACP gives a client no way to ask, so
 * "not reported yet" must never read as "has none"; the backend keeps a
 * `stale` list for display and never treats it as authoritative.
 */
export function commandCatalogue(state: SessionState | undefined): BridgeCommandCatalogueResponse {
  if (!state) {
    return {
      catalogueVersion: NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
      status: "missing",
      commands: [],
    };
  }
  return {
    catalogueVersion: NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
    status: state.commandsLive ? "ready" : "stale",
    revision: state.commandsRevision ?? 0,
    generation: COMMAND_CATALOGUE_GENERATION,
    freshness: "push",
    truncated: state.commandsTruncated === true,
    commands: state.availableCommands ?? [],
  };
}

/**
 * What an explicit refresh can honestly do: nothing but re-read. ACP defines
 * no request that makes an agent re-announce its commands, and restarting a
 * live agent just to repaint a menu would cost the user their running turn.
 */
export function refreshCommandCatalogue(state: SessionState | undefined): {
  outcome: "reread" | "unsupported" | "failed";
  message: string;
} {
  if (!state) return { outcome: "failed", message: "Session not found" };
  if (state.commandsLive) {
    return {
      outcome: "reread",
      message: `${PROVIDER_LABEL} pushes its commands; this is the latest list it reported`,
    };
  }
  return {
    outcome: "unsupported",
    message: `${PROVIDER_LABEL} has not reported its commands to this bridge yet and cannot be asked to`,
  };
}

export type SelectedCommandResolution =
  | { ok: true; text: string; command: NativeAgentSlashCommand }
  | { ok: false; message: string };

/**
 * Check a backend-selected command against the live inventory and build the
 * exact prompt text: the canonical `/name`, then the arguments verbatim —
 * multi-line text included, never split into tokens.
 */
export function resolveSelectedCommand(
  state: SessionState,
  invocation: NativeAgentBridgeCommandInvocation,
): SelectedCommandResolution {
  if (invocation.executionKind !== "provider-prompt") {
    return {
      ok: false,
      message: `${PROVIDER_LABEL} commands run as prompts, not as ${invocation.executionKind}`,
    };
  }
  if (!state.commandsLive) {
    return {
      ok: false,
      message: `${PROVIDER_LABEL} has not re-reported its commands since the bridge restarted`,
    };
  }
  const command = state.availableCommands?.find((candidate) => candidate.id === invocation.id);
  if (!command) {
    return { ok: false, message: `${PROVIDER_LABEL} no longer offers ${invocation.name}` };
  }
  if (
    (invocation.bindingRevision !== undefined &&
      invocation.bindingRevision !== command.bindingRevision) ||
    (invocation.name !== command.name && `/${invocation.name}` !== command.name)
  ) {
    return {
      ok: false,
      message: `${PROVIDER_LABEL} changed ${command.name} since it was selected`,
    };
  }
  return {
    ok: true,
    command,
    text:
      invocation.arguments.length > 0 ? `${command.name} ${invocation.arguments}` : command.name,
  };
}
