/** Merge a control update consistently for picker changes and admitted dispatches. */
import type { NativeAgentControlUpdate } from "@orkestrator/protocol/native-agent";
import type { PersistedNativeAgentSession } from "./models.js";
import { isRetiredParameter } from "./native-agent-retired-parameters.js";

export function nativeAgentSessionWithControls(
  existing: PersistedNativeAgentSession,
  update: NativeAgentControlUpdate,
): PersistedNativeAgentSession {
  const modelChanged =
    update.modelId !== undefined && update.modelId !== existing.controls?.modelId;
  // Most parameter values are model-scoped and must be cleared when their
  // model changes. Claude's settings-backed values are session defaults:
  // unsupported models ignore context1m, and switching back must restore
  // the value the session started with rather than losing it permanently.
  // A retired value (Claude's pre-approval-mode `permissionMode`, Codex's
  // reasoning `summary`) has no descriptor any more, so any control update
  // drops it.
  const retainedParameterValues = modelChanged
    ? Object.fromEntries(
        Object.entries(existing.controls?.parameterValues ?? {}).filter(
          ([id]) =>
            existing.agent === "claude" &&
            (id === "thinking" || id === "context1m" || id === "chrome"),
        ),
      )
    : Object.fromEntries(
        Object.entries(existing.controls?.parameterValues ?? {}).filter(
          ([id]) =>
            !isRetiredParameter(existing.agent, id) &&
            !(
              existing.agent === "claude" &&
              id === "ultracode" &&
              update.reasoningId !== undefined
            ),
        ),
      );
  const controls = {
    ...existing.controls,
    ...(modelChanged && existing.agent === "codex" ? { reasoningId: undefined } : {}),
    ...update,
    ...(update.parameterValues
      ? {
          parameterValues: {
            ...retainedParameterValues,
            ...update.parameterValues,
          },
        }
      : Object.keys(retainedParameterValues).length > 0
        ? { parameterValues: retainedParameterValues }
        : { parameterValues: undefined }),
  };
  const updated: PersistedNativeAgentSession = {
    ...existing,
    controls,
    updatedAt: new Date().toISOString(),
  };
  if (update.modelId !== undefined) delete updated.inferredComposerSelection;
  return updated;
}
