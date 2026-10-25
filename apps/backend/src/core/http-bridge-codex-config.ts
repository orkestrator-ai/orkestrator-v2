/**
 * The Codex bridge's per-session config (`/session/:id/config`).
 *
 * Codex binds model, effort, mode and fast tier to the bridge session rather
 * than the prompt, and the bridge's `POST` replaces the whole config: a field
 * left out is reset (mode to Build, fast tier off). Every write here therefore
 * reads the current config first and restates what it does not change.
 */
import type { NativeAgentControlUpdate } from "@orkestrator/protocol/native-agent";
import {
  ProviderUnavailableError,
  type BridgeConnection,
  type ProviderExecutionMode,
} from "./agent-provider-contract.js";
import { isTransientHttpStatus } from "./agent-provider-runtime.js";
import { assertOk, bridgeFetch } from "./http-bridge-transport.js";

interface CodexSessionConfig {
  model?: string;
  modelReasoningEffort?: string;
  mode: ProviderExecutionMode;
  fastMode: boolean;
  durable: boolean;
}

function configPath(sessionId: string): string {
  return `/session/${encodeURIComponent(sessionId)}/config`;
}

/** The session's whole config; `operation` names the caller in a retryable refusal. */
async function readCodexConfig(
  connection: BridgeConnection,
  fetchImpl: typeof fetch,
  sessionId: string,
  operation: string,
): Promise<CodexSessionConfig> {
  const currentResponse = await bridgeFetch(connection, configPath(sessionId), {}, fetchImpl);
  if (
    currentResponse.status === 404 ||
    currentResponse.status === 409 ||
    isTransientHttpStatus(currentResponse.status)
  ) {
    throw new ProviderUnavailableError(
      `${operation} is temporarily unavailable (HTTP ${currentResponse.status})`,
    );
  }
  assertOk(currentResponse, "Codex config read");
  const current = (await currentResponse.json()) as {
    model?: unknown;
    modelReasoningEffort?: unknown;
    mode?: unknown;
    fastMode?: unknown;
    durable?: unknown;
  };
  if (
    (current.mode !== "plan" && current.mode !== "build") ||
    (current.model !== undefined && typeof current.model !== "string") ||
    (current.modelReasoningEffort !== undefined &&
      typeof current.modelReasoningEffort !== "string") ||
    typeof current.fastMode !== "boolean" ||
    typeof current.durable !== "boolean"
  ) {
    throw new Error("Codex returned a malformed session config");
  }
  return {
    ...(current.model !== undefined ? { model: current.model } : {}),
    ...(current.modelReasoningEffort !== undefined
      ? { modelReasoningEffort: current.modelReasoningEffort }
      : {}),
    mode: current.mode,
    fastMode: current.fastMode,
    durable: current.durable,
  };
}

/**
 * Codex stores execution mode on the session rather than accepting it on the
 * prompt route. Reused workflow threads can move between plan and build
 * turns, so reconcile the idle thread before dispatching when needed.
 */
export async function ensureCodexMode(
  connection: BridgeConnection,
  fetchImpl: typeof fetch,
  sessionId: string,
  mode: ProviderExecutionMode,
): Promise<void> {
  const current = await readCodexConfig(
    connection,
    fetchImpl,
    sessionId,
    "Codex mode reconciliation",
  );
  if (current.mode === mode && current.durable) return;

  const updateResponse = await bridgeFetch(
    connection,
    configPath(sessionId),
    {
      method: "POST",
      body: JSON.stringify({
        model: current.model,
        modelReasoningEffort: current.modelReasoningEffort,
        mode,
        fastMode: current.fastMode,
      }),
    },
    fetchImpl,
  );
  if (
    updateResponse.status === 404 ||
    updateResponse.status === 409 ||
    isTransientHttpStatus(updateResponse.status)
  ) {
    throw new ProviderUnavailableError(
      `Codex mode update is temporarily unavailable (HTTP ${updateResponse.status})`,
    );
  }
  assertOk(updateResponse, "Codex config update");
  const update = (await updateResponse.json()) as { durable?: unknown };
  if (update.durable !== true) {
    throw new ProviderUnavailableError("Codex mode update was not durably persisted");
  }
}

/**
 * Apply a composer control change, restating every field it leaves alone. A
 * model pick alone would otherwise move a Plan session to Build (and its
 * read-only sandbox to full access) and turn fast mode off. A new model keeps
 * the old effort only when the update names one; otherwise Codex applies the
 * new model's default, which every model supports.
 *
 * Undefined when the update carries nothing the bridge stores (approval mode
 * is persisted by the backend and sent with each turn); otherwise the mode
 * now configured and whether the bridge persisted it.
 */
export async function updateCodexSessionConfig(
  connection: BridgeConnection,
  fetchImpl: typeof fetch,
  sessionId: string,
  update: NativeAgentControlUpdate,
): Promise<{ mode: ProviderExecutionMode; durable: boolean } | undefined> {
  const hasConfig = [update.modelId, update.reasoningId, update.mode].some(Boolean);
  if (!hasConfig && update.fastMode === undefined) return undefined;
  const current = await readCodexConfig(
    connection,
    fetchImpl,
    sessionId,
    "Codex session config update",
  );
  const modelChanged = update.modelId !== undefined && update.modelId !== current.model;
  const model = update.modelId ?? current.model;
  const effort = update.reasoningId ?? (modelChanged ? undefined : current.modelReasoningEffort);
  const mode = update.mode ?? current.mode;
  const response = await bridgeFetch(
    connection,
    configPath(sessionId),
    {
      method: "POST",
      body: JSON.stringify({
        ...(model ? { model } : {}),
        ...(effort ? { modelReasoningEffort: effort } : {}),
        mode,
        fastMode: update.fastMode ?? current.fastMode,
      }),
    },
    fetchImpl,
  );
  if (response.status === 404 || response.status === 409) {
    throw new ProviderUnavailableError(
      `Codex session config update is temporarily unavailable (HTTP ${response.status})`,
    );
  }
  assertOk(response, "Codex session config update");
  const outcome = (await response.json().catch(() => null)) as { durable?: unknown } | null;
  return { mode, durable: outcome?.durable === true };
}
