import { encodePublicSessionId } from "@orkestrator/protocol/public-api-resources";
import type { CommandContext } from "./commands-context.js";
import {
  listSessionCommands,
  resolveSessionCommand,
  type SessionCommandContext,
} from "./public-api/actions-session-commands.js";
import { sessionPromptMode } from "./public-api/actions-sessions.js";
import { PublicActionError } from "./public-api/errors.js";
import { stopSessionTurn } from "./public-api/session-turn-stop.js";
import { resolveSession, sessionActivity, type ResolvedSession } from "./public-api/sessions.js";
import type { SurfaceCommandRunner } from "./worker-surface-runs.js";

/**
 * A worker's native agent turn, as it runs on the node that owns the worker:
 * stop the running turn, list the tab's slash commands, run one. A coordinator
 * on this node reaches them through `coordinator-worker-turn-actions.ts`; a
 * command node's coordinator through the `*_controller_*` commands there.
 * Each caller checks its own scope and refuses the project home; these act
 * on one native tab, through the same code as `session.stop`,
 * `session.commands` and `session.command`, so every restriction those have
 * holds here too.
 */

type JsonRecord = Record<string, unknown>;

/** Commands that act on a live turn; a coordinator uses `send_message` with `deliverNow`. */
const LIVE_TURN_REFUSAL =
  "acts on the turn that is already running. To correct a busy worker, use send_message with deliverNow: true.";

/** Tab types that hold a terminal (a shell or an agent CLI), as `teardown_tab` reads them. */
const TERMINAL_TAB_TYPES = new Set([
  "plain",
  "root",
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
]);

/** Command kinds that answer without starting a provider turn. */
const NO_TURN_KINDS = new Set(["bridge-local", "session-action"]);

function tabOf(layout: unknown, tabId: string): JsonRecord | null {
  const isRecord = (value: unknown): value is JsonRecord =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  let found: JsonRecord | null = null;
  const visit = (node: unknown, depth: number): void => {
    if (found || !isRecord(node) || depth > 64) return;
    if (node.kind === "leaf" && Array.isArray(node.tabs)) {
      found = node.tabs.find((tab): tab is JsonRecord => isRecord(tab) && tab.id === tabId) ?? null;
      return;
    }
    if (node.kind === "split" && Array.isArray(node.children))
      for (const child of node.children) visit(child, depth + 1);
  };
  if (isRecord(layout)) visit(layout.root, 0);
  return found;
}

/** The native agent session in `tabId`, or a refusal naming what that tab is instead. */
async function nativeWorkerSession(
  context: CommandContext,
  environmentId: string,
  tabId: string,
  tool: string,
): Promise<ResolvedSession> {
  const tab = tabOf(await context.storage.getPaneLayout(environmentId), tabId);
  if (!tab) throw new Error(`Tab ${tabId} is not open in that worker; list_tabs names its tabs.`);
  if (tab.type !== "agent-native") {
    const kind =
      tab.type === "claude-tmux"
        ? "Claude tmux"
        : TERMINAL_TAB_TYPES.has(String(tab.type))
          ? "terminal"
          : String(tab.type);
    throw new Error(
      `Tab ${tabId} is a ${kind} tab, not a native agent tab. ${tool} acts on native agent tabs only; a terminal's process ends when edit_worker_tab closes its tab.`,
    );
  }
  return resolveSession(
    { command: context },
    { sessionId: encodePublicSessionId(environmentId, tabId), environmentId, tabId },
  );
}

function sessionContext(context: CommandContext, run: SurfaceCommandRunner): SessionCommandContext {
  return {
    command: context,
    invoke: <T>(command: string, args: Record<string, unknown> = {}) =>
      run<T>(context, command, args),
  } as SessionCommandContext;
}

function activityOf(context: CommandContext, session: ResolvedSession) {
  return sessionActivity(
    { command: context },
    {
      environmentId: session.environment.id,
      agent: session.agent,
      logicalSessionKey: session.logicalSessionKey,
    },
  );
}

/**
 * Stop the running turn in one native tab, never the environment. An idle
 * tab is an answer (`stopped: false`), not an error. `beforeStop` runs only
 * when there is a turn to stop, before the provider is asked.
 */
export async function stopWorkerTurn(
  context: CommandContext,
  run: SurfaceCommandRunner,
  environmentId: string,
  tabId: string,
  beforeStop?: () => Promise<void>,
): Promise<JsonRecord> {
  const session = await nativeWorkerSession(context, environmentId, tabId, "stop_worker_turn");
  const base = { environmentId, tabId, agent: session.agent };
  const activity = session.record ? activityOf(context, session) : "idle";
  if (activity === "idle") {
    return {
      ...base,
      stopped: false,
      turn: "idle",
      note: session.record
        ? "No turn is running in this tab, so nothing was stopped. This is not an error; do not retry."
        : "This tab has not started a conversation yet, so there is no turn to stop. This is not an error; do not retry.",
    };
  }
  await beforeStop?.();
  const stop = await stopSessionTurn(
    { ...sessionContext(context, run), now: () => Date.now() },
    session,
  );
  return {
    ...base,
    stopped: true,
    acknowledged: stop.acknowledged,
    turn: stop.phase,
    ...(stop.run ? { runId: stop.run.operationId } : {}),
    ...(stop.acknowledged
      ? {}
      : {
          note: "The stop was sent but the agent has not confirmed the turn ended yet. Check with get_tab_state before stopping again.",
        }),
  };
}

/** The tab's slash commands as `session.commands` lists them, without live-turn commands. */
export async function listWorkerCommands(
  context: CommandContext,
  run: SurfaceCommandRunner,
  environmentId: string,
  tabId: string,
  refresh: boolean,
): Promise<JsonRecord> {
  const session = await nativeWorkerSession(context, environmentId, tabId, "list_worker_commands");
  const listed = await listSessionCommands(sessionContext(context, run), session, refresh);
  return {
    environmentId,
    tabId,
    agent: listed.agent,
    catalogue: listed.catalogue,
    commands: listed.commands.filter((command) => command.busy !== "running"),
    ...(listed.refresh ? { refresh: listed.refresh } : {}),
  };
}

export interface WorkerCommandInput {
  command: string;
  arguments?: string;
  expectedBindingRevision?: string;
}

/**
 * Run one slash command in a worker tab, as a selection, with every check
 * `session.command` makes. `startsTurn` says whether the command starts a
 * provider turn (the caller opens a delegation for it) or answers without
 * one (a bridge's local command, an Orkestrator session action).
 */
export async function runWorkerCommand(
  context: CommandContext,
  run: SurfaceCommandRunner,
  environmentId: string,
  tabId: string,
  input: WorkerCommandInput,
  requestId: string,
): Promise<JsonRecord> {
  if (/^\/?steer$/i.test(input.command.trim()) || input.command.trim() === "orkestrator:steer")
    throw new Error(`/steer ${LIVE_TURN_REFUSAL}`);
  const session = await nativeWorkerSession(context, environmentId, tabId, "run_worker_command");
  const shared = sessionContext(context, run);
  const resolved = await resolveSessionCommand(shared, session, input).catch((error: unknown) => {
    if (error instanceof PublicActionError && error.code === "not-found")
      throw new PublicActionError(
        "not-found",
        "That tab has no such command; list_worker_commands lists them.",
      );
    throw error;
  });
  if (resolved.command.inputPolicy?.busy === "running")
    throw new Error(`${resolved.command.name} ${LIVE_TURN_REFUSAL}`);
  const startsTurn = !NO_TURN_KINDS.has(resolved.command.executionKind ?? "provider-prompt");
  const mode = sessionPromptMode({ command: context }, session, undefined);
  const outcome = await run<{ outcome: string; error?: string }>(
    context,
    "dispatch_native_agent_intent",
    {
      environmentId,
      agent: session.agent,
      logicalSessionKey: session.logicalSessionKey,
      requestId,
      prompt: resolved.text,
      command: resolved.intent,
      ...(mode ? { mode } : {}),
    },
  );
  if (outcome.outcome === "rejected")
    throw new Error(
      `The worker refused ${resolved.command.name}${outcome.error ? `: ${outcome.error.slice(0, 500)}` : ""}`,
    );
  return {
    environmentId,
    tabId,
    agent: session.agent,
    commandId: resolved.commandId,
    command: resolved.command.name,
    startsTurn,
    outcome: outcome.outcome,
    ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
  };
}
