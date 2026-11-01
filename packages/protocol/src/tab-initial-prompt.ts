/**
 * The contract between whoever opens an agent tab with an opening prompt (the
 * renderer's action bar, design workspace, the backend's startup launch) and
 * the backend's durable prompt-queue dispatcher that actually sends it.
 *
 * Every party has to agree on three things, so they are written once here:
 * the startup tab's stable ID, the one request ID an opening prompt is ever
 * sent under (sharing it is what keeps the prompt at most once when the queue
 * and a mounted tab race), and the per-provider queue message shape the
 * dispatcher reads (`native-agent-queue-message.ts`).
 */
import type { AgentPlatform } from "./agent-platforms.js";

/** Stable ID of the one-shot startup agent tab, shared by every renderer and the backend. */
export const STARTUP_AGENT_TAB_ID = "startup-agent" as const;

export type StartupAgentTabId = typeof STARTUP_AGENT_TAB_ID;

/** Prefix of every opening-prompt request ID. */
export const TAB_INITIAL_PROMPT_REQUEST_PREFIX = "initial-prompt:";

/**
 * The one request ID a tab's opening prompt is ever sent under, by the backend
 * queue or by the mounted tab.
 */
export function tabInitialPromptRequestId(environmentId: string, tabId: string): string {
  return `${TAB_INITIAL_PROMPT_REQUEST_PREFIX}${environmentId}:${tabId}`;
}

/** True for a request ID minted by {@link tabInitialPromptRequestId}. */
export function isTabInitialPromptRequestId(requestId: string): boolean {
  return requestId.startsWith(TAB_INITIAL_PROMPT_REQUEST_PREFIX);
}

/**
 * The same ready-for-handoff predicate the backend and renderer use before the
 * startup agent takes focus. Prompt-less launches never mint a provider
 * session, so this is the durable boundary that setup has finished.
 */
export function environmentIsReadyForSetupHandoff(
  environment:
    | {
        setupPhase?: string | null;
        setupScriptsComplete?: boolean | null;
        setupOverride?: boolean | null;
      }
    | null
    | undefined,
): boolean {
  if (!environment) return false;
  return (
    environment.setupPhase === "ready" ||
    environment.setupScriptsComplete === true ||
    environment.setupOverride === true
  );
}

export interface TabInitialPromptOptions {
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  /** Defaults to Build, as a composer send does. */
  mode?: "build" | "plan";
  /** Already staged in the workspace, as the composer stages them. */
  attachments?: ReadonlyArray<{
    /** Renderer identity used to remove only the seeded draft attachment. */
    id?: string;
    type: "image" | "file";
    path: string;
    filename?: string;
  }>;
}

/**
 * A durable prompt-queue entry in the shape the backend dispatcher reads for
 * each provider (Claude's `effort`/`planModeEnabled`/`fastModeEnabled`,
 * Codex's `reasoningEffort`, the others' `variant` and `mode`).
 */
export function buildTabInitialPromptQueueMessage(
  agent: AgentPlatform,
  requestId: string,
  text: string,
  options: TabInitialPromptOptions = {},
): Record<string, unknown> {
  const attachments = (options.attachments ?? []).map(({ type, path, filename }) => ({
    type,
    path,
    ...(filename ? { filename } : {}),
  }));
  const base = { id: requestId, requestId, text, attachments, model: options.model };
  if (agent === "claude")
    return {
      ...base,
      ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
      planModeEnabled: options.mode === "plan",
      ...(typeof options.fastMode === "boolean" ? { fastModeEnabled: options.fastMode } : {}),
    };
  return {
    ...base,
    ...(options.reasoningEffort
      ? agent === "codex"
        ? { reasoningEffort: options.reasoningEffort }
        : { variant: options.reasoningEffort }
      : {}),
    mode: options.mode ?? "build",
    ...(typeof options.fastMode === "boolean" ? { fastMode: options.fastMode } : {}),
  };
}
