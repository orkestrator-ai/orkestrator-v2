/**
 * OpenCode's executable command catalogue and its `session.command` dispatch.
 *
 * The picker and the executor read the same inventory: one directory-scoped
 * `command.list` result, normalized once, cached once. Nothing is seeded — the
 * terminal UI's own controls (`/themes`, `/exit`, `/editor`, …) are not server
 * commands, so an empty discovery stays empty.
 *
 * Facts below come from the pinned 1.18.31 SDK types and the matching server
 * build:
 *
 * - `Command` is `{ name, description?, agent?, model?, source?, template,
 *   subtask?, hints }` with `source: "command" | "mcp" | "skill"`. There is no
 *   alias field and no ownership (project/user) field. `hints` is derived from
 *   the template's `$1…$n` / `$ARGUMENTS` placeholders.
 * - `source: "command"` covers config-defined templates *and* the server's own
 *   built-in templates (`init`, `review`); the config it reads merges global
 *   and project files. It says what a row is (a template), never who owns it.
 * - The server resolves `session.command` by exact object-key lookup, so names
 *   are case-sensitive and must be sent in their canonical spelling, without
 *   the slash.
 * - A client built with `directory` sends it as a header that the SDK rewrites
 *   into the `directory` query of every GET, so an "unscoped" list from this
 *   client is the same request as the scoped one; one read is enough.
 */
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
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
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  ProviderUnavailableError,
  type ProviderCommandCatalogue,
  type ProviderCommandRefreshResult,
  type ProviderSendOptions,
} from "./agent-provider-contract.js";
import { asRecord } from "./agent-provider-runtime.js";

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
  /** Exact server key; `session.command` takes it without a slash. */
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

/** Read the effective catalogue for the environment's directory. */
export async function readOpenCodeCommandInventory(
  client: OpencodeClient,
  directory: string | undefined,
  requestOptions: () => { signal: AbortSignal },
): Promise<OpenCodeCommandInventory> {
  let response: Awaited<ReturnType<OpencodeClient["command"]["list"]>>;
  try {
    response = await client.command.list({ directory }, requestOptions());
  } catch (error) {
    throw new ProviderUnavailableError("OpenCode command list is unavailable", {
      cause: error,
    });
  }
  if (!response || ("error" in response && response.error)) {
    throw catalogueError("OpenCode command list failed", "provider-error");
  }
  return normalizeOpenCodeCommandList(response.data);
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

  /**
   * OpenCode documents no command-reload operation or change event, so an
   * explicit refresh is exactly a fresh read of what the server lists now.
   */
  async refreshCommands(): Promise<ProviderCommandRefreshResult> {
    try {
      await this.refresh();
      return { outcome: "reread" };
    } catch {
      return {
        outcome: "failed",
        message: "OpenCode could not list its commands.",
      };
    }
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

/**
 * `session.command` has no per-turn tool mask, and a command's own `agent`
 * outranks the one a request names. Neither may widen a read-only boundary.
 */
function assertWithinPolicy(
  binding: OpenCodeCommandBinding,
  options: Pick<ProviderSendOptions, "readOnly">,
  coordinatorAgent: string | undefined,
): void {
  const label = commandLabel(binding.name);
  if (options.readOnly) {
    throw new PromptRejectedError(
      `${label} cannot run in a read-only turn: OpenCode commands cannot be restricted per turn. Nothing was sent.`,
    );
  }
  if (coordinatorAgent && binding.agent && binding.agent !== coordinatorAgent) {
    throw new PromptRejectedError(
      `${label} selects its own OpenCode agent, which this read-only coordinator session does not allow. Nothing was sent.`,
    );
  }
}

/**
 * Decide whether a submission runs through `session.command`.
 *
 * - A selected command must still be in the effective catalogue (one forced
 *   re-read if it is not) with the same binding revision; otherwise the
 *   submission is refused before anything is sent — never downgraded to text.
 * - `allowProviderCommands !== true` is literal: no discovery, no command.
 * - Typed text resolves by exact canonical spelling (OpenCode is
 *   case-sensitive and has no aliases). Unknown names, and a list that cannot
 *   be read, keep the documented literal path; only an advertised name can
 *   ever reach `session.command`.
 */
export async function resolveOpenCodeCommandDispatch(
  registry: OpenCodeCommandRegistry,
  prompt: string,
  options: Pick<ProviderSendOptions, "command" | "allowProviderCommands" | "schema" | "readOnly">,
  coordinatorAgent: string | undefined,
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
    assertWithinPolicy(binding, options, coordinatorAgent);
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
  assertWithinPolicy(binding, options, coordinatorAgent);
  return { binding, arguments: resolution.token.arguments };
}

/**
 * OpenCode TUI controls that are not server commands. Kept as explanatory
 * metadata only: they never enter the executable catalogue, and a server that
 * advertises a same-named command takes precedence because the catalogue is
 * consulted first.
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

type OpenCodeCommandParameters = Parameters<OpencodeClient["session"]["command"]>[0];
type OpenCodeCommandResponse = {
  error?: unknown;
  response?: { status?: number };
};

/**
 * Send one command and report what is actually known about it.
 *
 * Unlike `promptAsync` (204 as soon as the turn is forked), the server answers
 * `session.command` only after the command's whole turn has finished, and it
 * maps every failure — including one after the turn started — to HTTP 400.
 * So neither a slow answer nor an error proves the command did not run:
 *
 * - The request is never aborted by the prompt timeout (an aborted handler
 *   can stop a command still expanding its template); only disposal cancels it.
 * - When the timeout passes or the answer is an error, the transcript decides:
 *   the reserved `messageID` present means the command was accepted.
 * - No answer and no transcript evidence is ambiguous, never a rejection, and
 *   the caller keeps the same `messageID` for reconciliation. Nothing here
 *   ever falls back to `promptAsync`.
 */
export async function dispatchOpenCodeCommand(input: {
  client: OpencodeClient;
  command: OpenCodeCommandDispatch;
  /**
   * Everything but the command itself. OpenCode applies `command.agent` before
   * the request's `agent`, and `command.model`, then the command agent's
   * model, before the request's `model`: an explicit or session default here
   * fills a gap and can never override a command's own configuration.
   */
  request: Omit<OpenCodeCommandParameters, "command" | "arguments">;
  signal: AbortSignal;
  timeoutMs: number;
  dispatched: () => Promise<boolean>;
}): Promise<{ materialized: true } | { materialized: false; response: OpenCodeCommandResponse }> {
  const parameters: OpenCodeCommandParameters = {
    ...input.request,
    // The exact server key: lookup is case-sensitive and slash-free.
    command: input.command.binding.name,
    // Required by the server even when empty; the typed bytes, verbatim. The
    // command replaces the prompt text, so no text part repeats it.
    arguments: input.command.arguments,
  };
  const request = input.client.session.command(parameters, {
    signal: input.signal,
  }) as Promise<OpenCodeCommandResponse | undefined>;
  const pending = Symbol("pending");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof pending>((resolve) => {
    timer = setTimeout(() => resolve(pending), input.timeoutMs);
  });
  let answer: OpenCodeCommandResponse | undefined | typeof pending;
  try {
    answer = await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (answer !== pending && !answer?.error) return { materialized: false, response: answer ?? {} };
  // Still running (or failed after it started): observe the late outcome
  // without owning it; the event stream reports the turn itself.
  if (answer === pending) void request.then(undefined, () => undefined);
  if (await input.dispatched()) return { materialized: true };
  if (answer === pending) {
    throw new AmbiguousPromptDispatchError("OpenCode did not acknowledge the command in time");
  }
  return { materialized: false, response: answer! };
}
