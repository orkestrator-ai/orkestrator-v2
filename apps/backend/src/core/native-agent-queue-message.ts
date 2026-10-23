import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import type { ProviderExecutionMode } from "./agent-provider-contract.js";
import { nonBlank } from "./native-agent-service-shared.js";

/*
 * Readers for one persisted prompt-queue message. The queue stores renderer
 * compose state as untyped JSON, so every field is checked before use and a
 * malformed one reads as absent (or, for the mode, as the safe `plan`).
 */

export function queueBoolean(message: unknown, field: string): boolean | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const value = (message as Record<string, unknown>)[field];
  return typeof value === "boolean" ? value : undefined;
}

export function queueString(message: unknown, field: string): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const value = (message as Record<string, unknown>)[field];
  return nonBlank(value) ? value : undefined;
}

export function queueReasoningEffort(message: unknown): string | undefined {
  return (
    queueString(message, "reasoningEffort") ??
    queueString(message, "effort") ??
    queueString(message, "variant")
  );
}

export function queueFastMode(agent: BuildPipelineAgent, message: unknown): boolean | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  // Native compose queues persist the shared `fastMode` field for every
  // provider. Keep accepting Claude's legacy `fastModeEnabled` shape while
  // forwarding the shared field to Codex, Cursor, and Grok.
  //
  // Each candidate is type-checked before the next is considered rather than
  // coalesced first: `??` only falls through on null/undefined, so a garbage
  // legacy value would otherwise shadow a perfectly good shared field and
  // silently drop the user's speed selection.
  const candidates =
    agent === "claude" ? [record.fastModeEnabled, record.fastMode] : [record.fastMode];
  for (const candidate of candidates) {
    if (typeof candidate === "boolean") return candidate;
  }
  return undefined;
}

export function queueExecutionMode(
  agent: BuildPipelineAgent,
  message: unknown,
): ProviderExecutionMode {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "plan";
  }
  const record = message as Record<string, unknown>;
  if (agent === "claude") {
    if (record.planModeEnabled === true) return "plan";
    if (record.planModeEnabled === false || record.planModeEnabled === undefined) {
      return "build";
    }
    return "plan";
  }
  if (record.mode === "plan" || record.mode === "build") return record.mode;
  return record.mode === undefined ? "build" : "plan";
}

/**
 * The mode actually sent with a queued prompt. Backend-authored prompts may
 * ask to leave the session's own mode untouched (`preserveSessionMode`):
 * several providers persist a prompt's mode on the session, so sending the
 * `build` default would silently change a mode the user chose.
 */
export function queueDispatchMode(
  agent: BuildPipelineAgent,
  message: unknown,
): ProviderExecutionMode | undefined {
  if (
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    (message as Record<string, unknown>).preserveSessionMode === true &&
    (message as Record<string, unknown>).mode === undefined &&
    (message as Record<string, unknown>).planModeEnabled === undefined
  ) {
    return undefined;
  }
  return queueExecutionMode(agent, message);
}
