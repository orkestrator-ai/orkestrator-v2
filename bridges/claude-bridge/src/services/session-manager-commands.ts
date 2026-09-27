/**
 * Claude command discovery and selected-command resolution.
 *
 * The bridge owns one command inventory per session and serves it as the
 * enhanced catalogue (version 1, see docs/architecture/native-agent-commands.md).
 * Everything here is grounded in the installed Agent SDK declaration
 * (`@anthropic-ai/claude-agent-sdk` 0.3.276, `sdk.d.ts`):
 *
 * - `SlashCommand` is `{ name, description, argumentHint, aliases? }`. It has
 *   no source or scope, so provenance is `unknown` unless it is verified: a
 *   name listed in the init frame's `skills`, a `<plugin>:` prefix naming a
 *   plugin the init frame says is loaded, or metadata the SDK actually sent.
 * - `Query.supportedCommands()` is the session's live inventory.
 * - `SDKCommandsChangedMessage` (`system/commands_changed`) is documented as a
 *   full replacement: "Clients should REPLACE their cached command list".
 * - `SDKSystemMessage` (`system/init`) carries names only (`slash_commands`,
 *   `skills`) plus `terminal_slash_commands`, the subset "bound to the local
 *   terminal". Init names are a cold fallback that any later read supersedes.
 * - `SDKConversationResetMessage` is emitted by `/clear`. This bridge does not
 *   adopt `new_conversation_id`, so it cannot follow what `/clear` does.
 *
 * Names are the SDK's own. Only the leading `/` is normalized for display, and
 * a skill that the SDK already lists as `/<name>` is annotated, never repeated
 * under an invented `/skill:<name>` spelling.
 */
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import {
  COMMAND_CATALOGUE_LIMITS,
  NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
  commandBindingRevision,
  commandCatalogueBytes,
  displayCommandName,
  normalizeCommandCataloguePayload,
  truncateUtf8,
  type BridgeCommandCatalogueResponse,
  type NativeAgentBridgeCommandInvocation,
} from "@orkestrator/protocol/agent-command-catalogue";
import { parseCommandToken } from "@orkestrator/protocol/agent-slash-commands";
import type {
  NativeAgentCommandAvailability,
  NativeAgentCommandOrigin,
  NativeAgentCommandRefreshOutcome,
  NativeAgentSlashCommand,
  NativeAgentSlashCommandSource,
} from "@orkestrator/protocol/native-agent";
import { resolveClaudeDiscoveryConfig } from "./claude-query-config.js";
import { isClosedTransportError, readableControl } from "./session-manager-catalog.js";
import {
  claudeExecutableOptions,
  persistSessionMetadata,
  sessions,
} from "./session-manager-core.js";
import { eventEmitter } from "./event-emitter.js";
import { effectiveExecutionPolicy, isCoordinatorReadOnlyPolicy } from "./read-only-policy.js";
import { runtimeEnvironmentForAgentQuery } from "./runtime-env.js";
import { MAX_LOCAL_TRANSCRIPT_ENTRIES } from "./session-preferences.js";
import type {
  ClaudeCommandInventoryState,
  ClaudeQueryControl,
  NormalizedMessage,
  SessionState,
} from "../types/index.js";

/** Changes when this bridge process restarts, so a reader can detect it. */
const CATALOGUE_GENERATION = randomUUID();
/** A discovery probe that has not answered by now is closed. */
export const COMMAND_PROBE_TIMEOUT_MS = 30_000;
/** Bound on one local command result copied into the transcript. */
const MAX_LOCAL_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 512;

/**
 * Commands whose effect reaches beyond a reply, which this bridge cannot
 * follow. Listed so the picker can explain them, but never executed.
 */
const SESSION_CHANGING_COMMANDS: Readonly<Record<string, string>> = {
  // `SDKConversationResetMessage`: the CLI moves to `new_conversation_id`,
  // while this bridge keeps resuming the old SDK session id.
  "/clear":
    "/clear starts a new Claude conversation this tab cannot follow. Start a new session instead.",
  // Each turn passes the model the backend selected, so an in-conversation
  // change would silently revert on the next turn.
  "/model":
    "Choose the model from the model picker. A /model change would not survive the next turn.",
  // Each turn passes its own permission mode, for the same reason.
  "/permissions":
    "Change permissions from the session settings. A /permissions change would not survive the next turn.",
  "/resume": "Open another conversation from the session list instead of /resume.",
};

/** Commands that need Claude's own terminal UI or account flow. */
const INTERACTIVE_COMMANDS: ReadonlySet<string> = new Set(["/login", "/logout"]);

/**
 * Terminal-oriented commands whose headless behavior has not been qualified
 * through this bridge. They stay listed and disabled rather than runnable.
 */
const UNQUALIFIED_COMMANDS: ReadonlySet<string> = new Set([
  "/config",
  "/doctor",
  "/exit",
  "/ide",
  "/quit",
  "/statusline",
  "/terminal-setup",
  "/theme",
  "/vim",
]);

const AUTHORITY_RANK: Record<ClaudeCommandInventoryState["authority"], number> = {
  init: 1,
  probe: 2,
  live: 3,
  replacement: 3,
};

/** Per-session write counter, so a read that started earlier cannot win. */
const inventoryWrites = new WeakMap<SessionState, number>();
/** Single-flight discovery probes, keyed by session and configuration. */
const probesInFlight = new Map<string, Promise<SlashCommand[]>>();

export function resetClaudeCommandInventoryForTesting(): void {
  probesInFlight.clear();
}

function boundedMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error && error.message ? error.message : fallback;
  return truncateUtf8(message, MAX_MESSAGE_BYTES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Keep only well-formed SDK rows, bounded before any further work. */
function sdkRows(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) return [];
  const rows: SlashCommand[] = [];
  for (const candidate of value.slice(0, COMMAND_CATALOGUE_LIMITS.maxCommands)) {
    if (!isRecord(candidate) || typeof candidate.name !== "string" || !candidate.name) continue;
    rows.push(candidate as unknown as SlashCommand);
  }
  return rows;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

/**
 * Map provenance the SDK actually supplied. The installed declaration has no
 * such field; this only reads one if a CLI sends it, and never guesses.
 */
function suppliedSource(command: SlashCommand): NativeAgentSlashCommandSource | undefined {
  const raw = (command as { source?: unknown }).source;
  if (typeof raw !== "string") return undefined;
  switch (raw.toLowerCase()) {
    case "project":
    case "projectsettings":
    case "local":
    case "localsettings":
      return "project";
    case "user":
    case "usersettings":
      return "user";
    case "plugin":
      return "plugin";
    case "skill":
    case "skills":
      return "skill";
    case "builtin":
    case "built-in":
      return "builtin";
    default:
      return undefined;
  }
}

export interface AnnotationContext {
  skills: ReadonlySet<string>;
  plugins: ReadonlySet<string>;
  terminal: ReadonlySet<string>;
}

function annotationContext(session: SessionState): AnnotationContext {
  const init = session.initData;
  const skills = new Set<string>();
  for (const skill of [...(init?.skills ?? []), ...(session.commandSkillNames ?? [])]) {
    skills.add(displayCommandName(skill));
  }
  const plugins = new Set<string>();
  for (const plugin of init?.plugins ?? []) {
    // Only plugins the init frame reports under `plugins` carry a path; the
    // `plugin:`-prefixed MCP servers folded into the same list do not.
    if (plugin.path && plugin.name) plugins.add(plugin.name);
  }
  const terminal = new Set((init?.terminalSlashCommands ?? []).map(displayCommandName));
  return { skills, plugins, terminal };
}

function provenance(
  name: string,
  command: SlashCommand,
  context: AnnotationContext,
): { source: NativeAgentSlashCommandSource; origin?: NativeAgentCommandOrigin } {
  if (context.skills.has(name)) return { source: "skill" };
  const supplied = suppliedSource(command);
  if (supplied) return { source: supplied, ...(supplied === "plugin" ? { origin: "plugin" } : {}) };
  // A colon alone proves nothing; the prefix must name a loaded plugin.
  const colon = name.indexOf(":");
  if (colon > 1 && context.plugins.has(name.slice(1, colon))) {
    return { source: "plugin", origin: "plugin" };
  }
  return { source: "unknown" };
}

function availabilityFor(
  spellings: readonly string[],
  context: AnnotationContext,
): NativeAgentCommandAvailability | undefined {
  const folded = spellings.map((spelling) => spelling.toLowerCase());
  for (const spelling of folded) {
    const message = SESSION_CHANGING_COMMANDS[spelling];
    if (message) return { state: "unavailable", reason: "session-changing", message };
  }
  const canonical = spellings[0]!;
  if (
    folded.some((spelling) => INTERACTIVE_COMMANDS.has(spelling)) ||
    spellings.some((spelling) => context.terminal.has(spelling))
  ) {
    return {
      state: "unavailable",
      reason: "requires-interactive-ui",
      message: `${canonical} needs Claude's terminal interface. Run it in a Claude terminal tab.`,
    };
  }
  if (folded.some((spelling) => UNQUALIFIED_COMMANDS.has(spelling))) {
    return {
      state: "unavailable",
      reason: "unqualified",
      message: `${canonical} has not been qualified for this tab. Run it in a Claude terminal tab.`,
    };
  }
  return undefined;
}

/**
 * Build enhanced catalogue rows from SDK rows.
 *
 * Every row runs as `provider-prompt`: its canonical name is sent through the
 * ordinary query prompt, and the CLI resolves it exactly as it would typed
 * text. The identity is the canonical name, so it survives description edits
 * and reordering; the binding revision covers the same parts.
 */
export function claudeCommandRows(
  commands: readonly SlashCommand[],
  context: AnnotationContext,
): { commands: NativeAgentSlashCommand[]; truncated: boolean } {
  const rows = commands.map((command) => {
    const name = displayCommandName(command.name);
    const aliases = stringList(command.aliases).map(displayCommandName);
    const { source, origin } = provenance(name, command, context);
    const availability = availabilityFor([name, ...aliases], context);
    return {
      name,
      id: `claude:${name}`,
      executionKind: "provider-prompt",
      source,
      ...(origin ? { origin } : {}),
      ...(typeof command.description === "string" ? { description: command.description } : {}),
      ...(typeof command.argumentHint === "string" ? { argumentHint: command.argumentHint } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      scope: "session",
      ...(availability ? { availability } : {}),
      bindingRevision: commandBindingRevision(["claude", name]),
    };
  });
  // The shared normalizer enforces every identity and presentation bound, and
  // rejects rather than truncates an over-long name.
  const normalized = normalizeCommandCataloguePayload({
    catalogueVersion: NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
    commands: rows,
  });
  let result = normalized.commands;
  let truncated = normalized.truncated || commands.length > COMMAND_CATALOGUE_LIMITS.maxCommands;
  while (
    result.length > 0 &&
    commandCatalogueBytes(result) > COMMAND_CATALOGUE_LIMITS.maxWireBytes
  ) {
    result = result.slice(0, Math.floor(result.length * 0.9));
    truncated = true;
  }
  return { commands: result, truncated };
}

/** Names-only rows from an init frame: skills and commands, one row per name. */
function initRows(session: SessionState): SlashCommand[] {
  const seen = new Set<string>();
  const rows: SlashCommand[] = [];
  for (const name of [
    ...stringList(session.initData?.slashCommands),
    ...stringList(session.initData?.skills),
  ]) {
    const display = displayCommandName(name);
    if (seen.has(display)) continue;
    seen.add(display);
    rows.push({ name, description: "", argumentHint: "" });
  }
  return rows;
}

/**
 * Replace a session's inventory.
 *
 * `startedAt` is the write counter observed when the read began. A read that
 * a newer write overtook is dropped unless it is strictly more authoritative:
 * a slow `supportedCommands()` must not undo a `commands_changed` push, and a
 * probe must not undo either.
 */
function applyInventory(
  session: SessionState,
  authority: ClaudeCommandInventoryState["authority"],
  commands: SlashCommand[] | undefined,
  options: { startedAt?: number; probeFingerprint?: string; reannotation?: boolean } = {},
): boolean {
  const previous = session.commandInventoryState;
  const writes = inventoryWrites.get(session) ?? 0;
  if (
    previous &&
    options.startedAt !== undefined &&
    options.startedAt !== writes &&
    AUTHORITY_RANK[previous.authority] >= AUTHORITY_RANK[authority]
  ) {
    return false;
  }
  const sdkCommands = commands ?? initRows(session);
  const { commands: rows, truncated } = claudeCommandRows(sdkCommands, annotationContext(session));
  const changed =
    !previous ||
    previous.authority !== authority ||
    previous.refreshFailed === true ||
    JSON.stringify(session.commandInventory ?? []) !== JSON.stringify(rows);
  const revision = (previous?.revision ?? 0) + (changed ? 1 : 0);
  session.commandInventory = rows;
  session.commandInventoryState = {
    authority,
    ...(commands ? { sdkCommands } : {}),
    revision,
    truncated,
    ...(options.probeFingerprint ? { probeFingerprint: options.probeFingerprint } : {}),
  };
  // Re-deriving annotations is not new content, so it must not make an
  // in-flight read look overtaken.
  if (!options.reannotation) inventoryWrites.set(session, writes + 1);
  if (changed) {
    // A hint for live readers only. The inventory itself is already updated,
    // whether or not anybody is listening, and a reader that missed this sees
    // the new revision on its next read.
    eventEmitter.emit({
      type: "session.updated",
      sessionId: session.id,
      data: { commandCatalogueRevision: revision },
    });
  }
  return true;
}

/** Re-derive rows after the annotation inputs (init skills/plugins) changed. */
function reannotate(session: SessionState): void {
  const state = session.commandInventoryState;
  if (!state) return;
  applyInventory(session, state.authority, state.sdkCommands, {
    reannotation: true,
    ...(state.probeFingerprint ? { probeFingerprint: state.probeFingerprint } : {}),
  });
}

/**
 * Record a turn's init frame.
 *
 * Init names are only a cold fallback: they seed an empty inventory, and never
 * replace one a live read or a replacement push produced — otherwise a command
 * a later `commands_changed` removed would come back with the next turn.
 */
export function recordInitCommandInventory(session: SessionState): void {
  const state = session.commandInventoryState;
  if (!state || state.authority === "init") {
    applyInventory(session, "init", undefined);
    return;
  }
  reannotate(session);
}

/** `system/commands_changed`: a full replacement, applied unconditionally. */
export function recordCommandsChanged(session: SessionState, message: unknown): void {
  if (!isRecord(message) || !Array.isArray(message.commands)) return;
  applyInventory(session, "replacement", sdkRows(message.commands));
}

async function readControlCommands(
  session: SessionState,
  control: ClaudeQueryControl,
): Promise<void> {
  const startedAt = inventoryWrites.get(session) ?? 0;
  const commands = sdkRows(await control.supportedCommands!());
  applyInventory(session, "live", commands, { startedAt });
}

/**
 * Refresh the inventory from a turn's own control, off the message path.
 *
 * Called once per turn so the inventory a prompt is validated against comes
 * from the session's own query rather than a probe. Failures are not surfaced:
 * the previous inventory stays, and an explicit read still reports errors.
 */
export function readLiveCommandInventory(session: SessionState, control: ClaudeQueryControl): void {
  if (typeof control.supportedCommands !== "function") return;
  void readControlCommands(session, control).catch(() => undefined);
}

async function probeCommands(session: SessionState, force: boolean): Promise<void> {
  const config = await resolveClaudeDiscoveryConfig(
    session.executionPolicy,
    session.commandDiscoveryInputs ?? { readOnly: false, includeLocalSettings: false },
  );
  const state = session.commandInventoryState;
  if (!force && state?.authority === "probe" && state.probeFingerprint === config.fingerprint) {
    return;
  }
  const key = `${session.id}\0${config.fingerprint}`;
  let pending = probesInFlight.get(key);
  if (!pending) {
    pending = runDiscoveryProbe(config).finally(() => {
      probesInFlight.delete(key);
    });
    probesInFlight.set(key, pending);
  }
  const startedAt = inventoryWrites.get(session) ?? 0;
  const commands = await pending;
  if (sessions.get(session.id) !== session) return;
  applyInventory(session, "probe", commands, { startedAt, probeFingerprint: config.fingerprint });
}

/**
 * Spawn a zero-turn CLI configured like the session's turns and read its
 * inventory. Bounded by {@link COMMAND_PROBE_TIMEOUT_MS} and closed on every
 * outcome; every promise it creates has a rejection handler.
 */
async function runDiscoveryProbe(
  config: Awaited<ReturnType<typeof resolveClaudeDiscoveryConfig>>,
): Promise<SlashCommand[]> {
  const env = await runtimeEnvironmentForAgentQuery();
  let probe: Query | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    probe = query({
      prompt: "",
      options: {
        maxTurns: 0,
        cwd: config.cwd,
        env,
        settingSources: config.settingSources,
        ...(config.plugins.length > 0 ? { plugins: config.plugins } : {}),
        ...claudeExecutableOptions(),
      },
    });
    const read = probe.supportedCommands();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Claude command discovery timed out")),
        COMMAND_PROBE_TIMEOUT_MS,
      );
    });
    // The losing side of the race still settles; keep it from surfacing as
    // an unhandled rejection after the probe is closed.
    read.catch(() => undefined);
    return sdkRows(await Promise.race([read, timeout]));
  } finally {
    if (timer) clearTimeout(timer);
    await Promise.resolve(probe?.close()).catch(() => undefined);
  }
}

/**
 * Make sure the session has an inventory to answer from.
 *
 * Order: the turn's readable control, then the retained inventory, then one
 * probe. A closed transport falls back; every other SDK error propagates —
 * a failed read must not look like an authoritative answer.
 */
async function ensureInventory(session: SessionState): Promise<void> {
  const control = readableControl(session);
  if (typeof control?.supportedCommands === "function") {
    try {
      await readControlCommands(session, control);
      return;
    } catch (error) {
      if (!isClosedTransportError(error)) throw error;
    }
  }
  // A probe costs a whole CLI process; a retained answer is strictly better.
  if (session.commandInventoryState) return;
  await probeCommands(session, false);
}

function catalogueStatus(state: ClaudeCommandInventoryState): "ready" | "stale" {
  // A probe cannot see MCP-prompt commands or per-turn options, and init
  // frames carry names only: both are provisional until the session's own
  // query answers.
  if (state.refreshFailed) return "stale";
  return state.authority === "live" || state.authority === "replacement" ? "ready" : "stale";
}

function catalogueResponse(session: SessionState): BridgeCommandCatalogueResponse {
  const state = session.commandInventoryState!;
  return {
    catalogueVersion: NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
    status: catalogueStatus(state),
    commands: session.commandInventory ?? [],
    revision: state.revision,
    generation: CATALOGUE_GENERATION,
    // The bridge emits a hint on change, but nothing guarantees a reader saw it.
    freshness: "ttl",
    ...(state.truncated ? { truncated: true } : {}),
  };
}

/**
 * The enhanced catalogue read behind `GET /session/:id/commands`.
 *
 * Metadata only: it reads the session map directly, so it never touches
 * liveness, hydrates a transcript or re-attaches an idle session. An unknown
 * session is answered in band as `missing`.
 */
export async function readClaudeCommandCatalogue(
  sessionId: string,
): Promise<BridgeCommandCatalogueResponse> {
  const session = sessions.get(sessionId);
  if (!session) {
    return {
      catalogueVersion: NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
      status: "missing",
      commands: [],
    };
  }
  await ensureInventory(session);
  return catalogueResponse(session);
}

/** Legacy list shape, kept for in-process callers that only need rows. */
export async function readSessionCommands(sessionId: string): Promise<NativeAgentSlashCommand[]> {
  return (await readClaudeCommandCatalogue(sessionId)).commands;
}

/**
 * A failed refresh. `retained` marks the list as one the bridge could not
 * re-read; a list that *was* re-read after a partial reload failure is still
 * the CLI's current inventory, so it keeps its status.
 */
function failedRefresh(session: SessionState, message: string, retained = true) {
  if (retained && session.commandInventoryState) {
    session.commandInventoryState.refreshFailed = true;
  }
  return { outcome: "failed" as const, message: truncateUtf8(message, MAX_MESSAGE_BYTES) };
}

/**
 * `POST /session/:id/commands/refresh`.
 *
 * With a readable turn control, reload skills and plugins and re-read. Partial
 * reload failure is `failed`, never success: `allSettled` resolving does not
 * mean every resource reloaded. A coordinator session only re-reads, because
 * reloading from disk could load resources its policy excludes. Without a
 * control, the session defers to its next turn, which starts a fresh CLI that
 * loads resources from disk and re-reads the inventory — unless all it holds
 * is a provisional (probe or init) list, which a probe can improve. A probe
 * never replaces a list the session's own query produced: it cannot see
 * MCP-prompt commands, so it would silently drop them.
 */
export async function refreshClaudeCommandCatalogue(
  sessionId: string,
): Promise<{ outcome: NativeAgentCommandRefreshOutcome; message?: string }> {
  const session = sessions.get(sessionId);
  if (!session) return { outcome: "failed", message: "The bridge does not hold this session." };
  const control = readableControl(session);
  if (typeof control?.supportedCommands === "function") {
    const mayReload =
      !isCoordinatorReadOnlyPolicy(effectiveExecutionPolicy(session.executionPolicy)) &&
      (typeof control.reloadSkills === "function" || typeof control.reloadPlugins === "function");
    let reloadFailure: string | undefined;
    let transportClosed = false;
    if (mayReload) {
      const [skills, plugins] = await Promise.allSettled([
        control.reloadSkills?.(),
        control.reloadPlugins?.(),
      ]);
      const failures: string[] = [];
      for (const [label, result] of [
        ["skills", skills],
        ["plugins", plugins],
      ] as const) {
        if (result.status === "fulfilled") continue;
        if (isClosedTransportError(result.reason)) transportClosed = true;
        else failures.push(`${label}: ${boundedMessage(result.reason, "reload failed")}`);
      }
      if (skills.status === "fulfilled" && isRecord(skills.value)) {
        session.commandSkillNames = sdkRows(skills.value.skills).map((skill) => skill.name);
      }
      const errorCount =
        plugins.status === "fulfilled" && isRecord(plugins.value)
          ? plugins.value.error_count
          : undefined;
      if (typeof errorCount === "number" && errorCount > 0) {
        failures.push(`plugins: ${errorCount} failed to load`);
      }
      if (failures.length > 0) {
        reloadFailure = `Claude could not reload every command resource (${failures.join("; ")}).`;
      }
    }
    if (!transportClosed) {
      try {
        await readControlCommands(session, control);
        if (reloadFailure) return failedRefresh(session, reloadFailure, false);
        return { outcome: mayReload ? "reloaded" : "reread" };
      } catch (error) {
        if (!isClosedTransportError(error)) {
          return failedRefresh(session, boundedMessage(error, "Claude command discovery failed"));
        }
      }
    }
    if (reloadFailure) return failedRefresh(session, reloadFailure);
  }
  const authority = session.commandInventoryState?.authority;
  if (session.status === "running" || authority === "live" || authority === "replacement") {
    return {
      outcome: "deferred",
      message: "Claude loads changed commands when this session starts its next turn.",
    };
  }
  try {
    await probeCommands(session, true);
    return {
      outcome: "reread",
      message: "Commands were re-read from disk. The session loads them on its next turn.",
    };
  } catch (error) {
    return failedRefresh(session, boundedMessage(error, "Claude command discovery failed"));
  }
}

/** `POST /global/refresh-catalog`: bounded fan-out over held sessions. */
export async function refreshClaudeCatalogs(): Promise<void> {
  const sessionIds = Array.from(sessions.keys()).slice(0, 128);
  let next = 0;
  await Promise.allSettled(
    Array.from({ length: Math.min(8, sessionIds.length) }, async () => {
      while (next < sessionIds.length) {
        const sessionId = sessionIds[next++];
        if (sessionId) await refreshClaudeCommandCatalogue(sessionId);
      }
    }),
  );
}

export type ClaudeCommandResolution =
  | { ok: true; providerPrompt: string; command: NativeAgentSlashCommand }
  | { ok: false; message: string };

/**
 * Resolve a selected command against the session's own inventory.
 *
 * Runs before any journaling or dispatch. Anything that no longer matches —
 * an unknown or forged id, a different canonical name, a changed binding, an
 * unavailable row — is refused; it is never downgraded to prompt text. A
 * retained inventory is used as is: no probe is spawned per prompt.
 */
export async function resolveClaudeCommandInvocation(
  session: SessionState,
  invocation: NativeAgentBridgeCommandInvocation,
): Promise<ClaudeCommandResolution> {
  if (invocation.executionKind !== "provider-prompt") {
    return { ok: false, message: `${invocation.name} cannot run in a Claude session.` };
  }
  try {
    await ensureInventory(session);
  } catch {
    return {
      ok: false,
      message: "Claude's command list is unavailable right now. Try again in a moment.",
    };
  }
  const command = session.commandInventory?.find((candidate) => candidate.id === invocation.id);
  if (!command || command.name !== invocation.name) {
    return {
      ok: false,
      message: `${invocation.name} is no longer available in this session. Choose it again from the menu.`,
    };
  }
  if (
    invocation.bindingRevision !== undefined &&
    command.bindingRevision !== invocation.bindingRevision
  ) {
    return {
      ok: false,
      message: `${command.name} changed since it was selected. Choose it again from the menu.`,
    };
  }
  if (command.availability?.state === "unavailable") {
    return {
      ok: false,
      message: command.availability.message ?? `${command.name} is not available in this session.`,
    };
  }
  // The argument suffix travels byte for byte; only the separator is fixed.
  return {
    ok: true,
    command,
    providerPrompt: invocation.arguments ? `${command.name} ${invocation.arguments}` : command.name,
  };
}

/**
 * Defence in depth for typed text with no selection.
 *
 * The Claude CLI interprets a leading `/` itself, so a typed `/clear` would
 * run even if the backend never saw a catalogue (its read failed). Refuse a
 * leading token that names a command this bridge marks unavailable — a held
 * row by name or alias, or one of the fixed session-changing, interactive or
 * unqualified names, or an init `terminal_slash_commands` entry. Case-folded.
 * Unknown tokens and paths pass through untouched. In-memory only.
 */
export function typedCommandUnavailableMessage(
  session: SessionState,
  prompt: string,
): string | undefined {
  const token = parseCommandToken(prompt);
  if (!token) return undefined;
  const folded = token.token.toLowerCase();
  for (const command of session.commandInventory ?? []) {
    if (command.availability?.state !== "unavailable") continue;
    const spellings = [command.name, ...(command.aliases ?? [])];
    if (spellings.some((spelling) => spelling.toLowerCase() === folded)) {
      return command.availability.message ?? `${command.name} is not available in this session.`;
    }
  }
  const context = annotationContext(session);
  const terminal = new Set(Array.from(context.terminal, (name) => name.toLowerCase()));
  const availability = availabilityFor([folded], { ...context, terminal });
  return availability?.state === "unavailable" ? availability.message : undefined;
}

/**
 * Show a command's local result — one the CLI answered without a model turn —
 * as an assistant message, and keep it in the durable local overlay so it
 * survives transcript eviction and a bridge restart.
 */
export function appendLocalCommandResult(
  session: SessionState,
  content: string,
  key: string,
): void {
  const text = content.trim();
  if (!text) return;
  const id = `local-command:${key}`;
  if (session.messages.some((message) => message.id === id)) return;
  const bounded = truncateUtf8(text, MAX_LOCAL_COMMAND_OUTPUT_BYTES);
  const message: NormalizedMessage = {
    id,
    role: "assistant",
    content: bounded,
    parts: [{ type: "text", content: bounded }],
    createdAt: new Date().toISOString(),
  };
  session.messages.push(message);
  session.localTranscript = [...(session.localTranscript ?? []), message].slice(
    -MAX_LOCAL_TRANSCRIPT_ENTRIES,
  );
  session.lastActivity = new Date();
  eventEmitter.emit({ type: "message.updated", sessionId: session.id, data: { message } });
  void persistSessionMetadata(session).catch(() => {
    // The in-memory message is visible; the next durable write retries.
  });
}
