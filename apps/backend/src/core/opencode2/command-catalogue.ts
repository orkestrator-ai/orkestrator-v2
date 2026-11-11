/**
 * OpenCode's slash-command catalogue and the decision whether a submission
 * runs as a command (`commands.ts` reads the list and sends the command).
 *
 * The picker and the executor read the same inventory: one list read,
 * normalized once, cached once. Nothing is seeded — the terminal UI's own
 * controls (`/themes`, `/exit`, `/editor`, …) are not server commands, so an
 * empty discovery stays empty. Names are exact, case-sensitive server keys
 * without the slash, and OpenCode has no aliases. A row may carry `source`,
 * `agent`, `model` and `subtask` defaults (2.x lists only `name` and
 * `description`); they are private and decide only the binding revision.
 */
import {
  COMMAND_CATALOGUE_LIMITS,
  commandBindingRevision,
  truncateUtf8,
  utf8ByteLength,
} from "@orkestrator/protocol/agent-command-catalogue";
import {
  parseCommandToken,
  resolveCommandInvocation,
} from "@orkestrator/protocol/agent-slash-commands";
import type {
  NativeAgentSlashCommand,
  NativeAgentSlashCommandSource,
} from "@orkestrator/protocol/native-agent";
import {
  PromptRejectedError,
  ProviderUnavailableError,
  type ProviderCommandCatalogue,
  type ProviderCommandRefreshResult,
  type ProviderSendOptions,
} from "../agent-provider-contract.js";
import { asRecord } from "../agent-provider-runtime.js";

/** How long a read serves both the picker and dispatch before a re-read. */
export const OPENCODE_COMMAND_CATALOGUE_TTL_MS = 30_000;

const ID_PREFIX = "opencode:";
const MAX_PRIVATE_FIELD_BYTES = 256;

/**
 * The private execution binding behind one public row. Command defaults stay
 * here: they decide what OpenCode does, but the template body is never read
 * and none of this is projected.
 */
export interface OpenCodeCommandBinding {
  id: string;
  /** Exact server key, sent without the slash. */
  name: string;
  bindingRevision: string;
  source?: "command" | "mcp" | "skill";
  agent?: string;
  model?: string;
  subtask?: boolean;
}

export interface OpenCodeCommandInventory {
  commands: NativeAgentSlashCommand[];
  bindings: ReadonlyMap<string, OpenCodeCommandBinding>;
  truncated: boolean;
}

function catalogueError(message: string, code: "malformed" | "provider-error") {
  return Object.assign(new ProviderUnavailableError(message), {
    catalogueErrorCode: code,
  });
}

/** The name a row is keyed by, or undefined when it cannot be addressed exactly. */
function canonicalName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) return undefined;
  // A leading sigil would make the typed spelling and the server key disagree.
  if (value.startsWith("/") || value.startsWith("$")) return undefined;
  if (utf8ByteLength(value) > COMMAND_CATALOGUE_LIMITS.maxNameBytes - 1) return undefined;
  if (utf8ByteLength(ID_PREFIX + value) > COMMAND_CATALOGUE_LIMITS.maxIdBytes) return undefined;
  return value;
}

function privateText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && utf8ByteLength(trimmed) <= MAX_PRIVATE_FIELD_BYTES ? trimmed : undefined;
}

/**
 * Picker grouping from the one provenance field OpenCode reports. MCP prompts
 * have no matching group, and a missing field is not evidence of anything.
 */
function publicSource(source: OpenCodeCommandBinding["source"]): NativeAgentSlashCommandSource {
  if (source === "skill") return "skill";
  if (source === "command") return "template";
  return "unknown";
}

/**
 * What a command runs as — its source and its own agent, model and subtask
 * defaults — is part of its meaning, so a change invalidates a selection. A
 * description edit does not.
 */
export function openCodeCommandBindingRevision(
  name: string,
  meta: { source?: string; agent?: string; model?: string; subtask?: boolean },
): string {
  return commandBindingRevision([
    "opencode",
    name,
    meta.source ?? "",
    meta.agent ?? "",
    meta.model ?? "",
    meta.subtask === undefined ? "" : String(meta.subtask),
  ]);
}

/**
 * Normalize one `command.list` payload. A payload that is not a list throws;
 * individual rows that cannot be addressed exactly are dropped and reported
 * as truncation, never repaired into a different command.
 */
export function normalizeOpenCodeCommandList(data: unknown): OpenCodeCommandInventory {
  if (!Array.isArray(data)) {
    throw catalogueError("OpenCode returned a malformed command list", "malformed");
  }
  const commands: NativeAgentSlashCommand[] = [];
  const bindings = new Map<string, OpenCodeCommandBinding>();
  let truncated = data.length > COMMAND_CATALOGUE_LIMITS.maxCommands;
  let wireBytes = 2;
  for (const candidate of data.slice(0, COMMAND_CATALOGUE_LIMITS.maxCommands)) {
    const row = asRecord(candidate);
    const name = canonicalName(row?.name);
    const id = name ? ID_PREFIX + name : undefined;
    if (!row || !name || !id || bindings.has(id)) {
      truncated = true;
      continue;
    }
    const source =
      row.source === "command" || row.source === "mcp" || row.source === "skill"
        ? row.source
        : undefined;
    const agent = privateText(row.agent);
    const model = privateText(row.model);
    const bindingRevision = openCodeCommandBindingRevision(name, {
      source,
      agent,
      model,
      subtask: typeof row.subtask === "boolean" ? row.subtask : undefined,
    });
    const description =
      typeof row.description === "string" && row.description.trim()
        ? truncateUtf8(row.description.trim(), COMMAND_CATALOGUE_LIMITS.maxDescriptionBytes)
        : undefined;
    const hints = Array.isArray(row.hints)
      ? row.hints.filter((hint): hint is string => typeof hint === "string" && hint.length > 0)
      : [];
    const argumentHint = hints.length
      ? truncateUtf8(hints.join(" "), COMMAND_CATALOGUE_LIMITS.maxArgumentHintBytes)
      : undefined;
    const command: NativeAgentSlashCommand = {
      name: `/${name}`,
      id,
      executionKind: "provider-command",
      source: publicSource(source),
      ...(description ? { description } : {}),
      ...(argumentHint ? { argumentHint } : {}),
      bindingRevision,
      caseSensitive: true,
    };
    const rowBytes = utf8ByteLength(JSON.stringify(command)) + 1;
    if (wireBytes + rowBytes > COMMAND_CATALOGUE_LIMITS.maxWireBytes) {
      truncated = true;
      break;
    }
    wireBytes += rowBytes;
    commands.push(command);
    bindings.set(id, {
      id,
      name,
      bindingRevision,
      ...(source ? { source } : {}),
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(typeof row.subtask === "boolean" ? { subtask: row.subtask } : {}),
    });
  }
  return { commands, bindings, truncated };
}

/**
 * One cache for the picker and the executor, so a selection is always
 * checked against the list it was chosen from or a newer one. An explicit
 * invalidation also discards a read that was already in flight.
 */
export class OpenCodeCommandRegistry {
  private cached: {
    inventory: OpenCodeCommandInventory;
    expiresAt: number;
  } | null = null;
  private inFlight: {
    generation: number;
    promise: Promise<OpenCodeCommandInventory>;
  } | null = null;
  private generation = 0;

  constructor(
    private readonly load: () => Promise<OpenCodeCommandInventory>,
    private readonly now: () => number,
    private readonly ttlMs = OPENCODE_COMMAND_CATALOGUE_TTL_MS,
  ) {}

  read(): Promise<OpenCodeCommandInventory> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return Promise.resolve(this.cached.inventory);
    }
    if (this.inFlight?.generation === this.generation) return this.inFlight.promise;
    const generation = this.generation;
    const promise = this.load()
      .then((inventory) => {
        if (this.generation === generation) {
          this.cached = { inventory, expiresAt: this.now() + this.ttlMs };
        }
        return inventory;
      })
      .finally(() => {
        if (this.inFlight?.promise === promise) this.inFlight = null;
      });
    this.inFlight = { generation, promise };
    return promise;
  }

  invalidate(): void {
    this.generation += 1;
    this.cached = null;
    this.inFlight = null;
  }

  refresh(): Promise<OpenCodeCommandInventory> {
    this.invalidate();
    return this.read();
  }

  async catalogue(): Promise<ProviderCommandCatalogue> {
    const inventory = await this.read();
    return {
      enhanced: true,
      status: "ready",
      commands: inventory.commands,
      truncated: inventory.truncated,
      freshness: "ttl",
    };
  }

  /** An explicit refresh: the list is read again. */
  async refreshCommands(): Promise<ProviderCommandRefreshResult> {
    try {
      await this.refresh();
    } catch {
      return {
        outcome: "failed",
        message: "OpenCode could not list its commands.",
      };
    }
    return { outcome: "reread" };
  }
}

export interface OpenCodeCommandDispatch {
  binding: OpenCodeCommandBinding;
  /** Argument suffix exactly as typed; `""` for a bare command. */
  arguments: string;
}

function commandLabel(name: string): string {
  return name.startsWith("/") ? name : `/${name}`;
}

/** A command cannot be restricted per turn, so it never runs in a read-only one. */
function assertWithinPolicy(
  binding: OpenCodeCommandBinding,
  options: Pick<ProviderSendOptions, "readOnly">,
): void {
  if (options.readOnly) {
    throw new PromptRejectedError(
      `${commandLabel(binding.name)} cannot run in a read-only turn: OpenCode commands cannot be restricted per turn. Nothing was sent.`,
    );
  }
}

/**
 * Decide whether a submission runs as an OpenCode command.
 *
 * - A selected command must still be in the effective catalogue (one forced
 *   re-read if it is not) with the same binding revision; otherwise the
 *   submission is refused before anything is sent — never downgraded to text.
 * - `allowProviderCommands !== true` is literal: no discovery, no command.
 * - Typed text resolves by exact canonical spelling (OpenCode is
 *   case-sensitive and has no aliases). Unknown names, and a list that cannot
 *   be read, keep the documented literal path; only an advertised name can
 *   ever be sent as a command.
 */
export async function resolveOpenCodeCommandDispatch(
  registry: OpenCodeCommandRegistry,
  prompt: string,
  options: Pick<ProviderSendOptions, "command" | "allowProviderCommands" | "schema" | "readOnly">,
): Promise<OpenCodeCommandDispatch | null> {
  const selected = options.command;
  if (selected) {
    const label = commandLabel(selected.name);
    if (options.allowProviderCommands === false) {
      throw new PromptRejectedError("A literal prompt cannot carry a command selection.");
    }
    if (selected.executionKind !== "provider-command") {
      throw new PromptRejectedError(
        `${label} is not an OpenCode command. Choose it again from the menu.`,
      );
    }
    if (options.schema) {
      throw new PromptRejectedError("Commands cannot be combined with structured output.");
    }
    let binding: OpenCodeCommandBinding | undefined;
    try {
      binding =
        (await registry.read()).bindings.get(selected.id) ??
        (await registry.refresh()).bindings.get(selected.id);
    } catch {
      throw new PromptRejectedError(
        `OpenCode's command list is unavailable, so ${label} could not be verified. Nothing was sent.`,
      );
    }
    if (!binding) {
      throw new PromptRejectedError(
        `${label} is no longer available in OpenCode. Choose it again from the menu. Nothing was sent.`,
      );
    }
    if (
      selected.bindingRevision !== undefined &&
      selected.bindingRevision !== binding.bindingRevision
    ) {
      throw new PromptRejectedError(
        `${label} changed since it was selected. Choose it again from the menu. Nothing was sent.`,
      );
    }
    assertWithinPolicy(binding, options);
    return { binding, arguments: selected.arguments };
  }
  if (options.allowProviderCommands !== true || options.schema) return null;
  // Only text that starts with a slash pays for discovery.
  if (!parseCommandToken(prompt)) return null;
  let inventory: OpenCodeCommandInventory;
  try {
    inventory = await registry.read();
  } catch {
    return null;
  }
  const resolution = resolveCommandInvocation({
    text: prompt,
    intent: { kind: "typed" },
    commands: inventory.commands,
  });
  if (resolution.kind === "ambiguous") throw new PromptRejectedError(resolution.message);
  if (resolution.kind !== "command") {
    const tuiOnly = openCodeTerminalOnlyCommand(prompt);
    if (tuiOnly) {
      // A terminal control the server does not advertise. Explaining it beats
      // handing the model "/exit" as if the user had asked it something.
      throw new PromptRejectedError(
        `${tuiOnly} is an OpenCode terminal command and has no equivalent in this tab. Nothing was sent.`,
      );
    }
    return null;
  }
  const binding = inventory.bindings.get(resolution.command.id ?? "");
  if (!binding) return null;
  assertWithinPolicy(binding, options);
  return { binding, arguments: resolution.token.arguments };
}

/**
 * OpenCode TUI controls that are not server commands. Kept as explanatory
 * metadata only: they never enter the executable catalogue, and a server that
 * advertises a same-named command takes precedence because the catalogue is
 * consulted first.
 *
 * `/share` and `/unshare` stay listed although OpenCode discontinued session
 * sharing: the entry is what refuses them, and without it the literal text
 * would reach the model as a prompt.
 */
const OPENCODE_TERMINAL_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "/editor",
  "/exit",
  "/quit",
  "/q",
  "/themes",
  "/theme",
  "/sessions",
  "/new",
  "/clear",
  "/models",
  "/agents",
  "/help",
  "/details",
  "/export",
  "/share",
  "/unshare",
  "/undo",
  "/redo",
  "/connect",
]);

function openCodeTerminalOnlyCommand(prompt: string): string | undefined {
  const token = parseCommandToken(prompt)?.token;
  return token && OPENCODE_TERMINAL_ONLY_COMMANDS.has(token.toLowerCase()) ? token : undefined;
}
