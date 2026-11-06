/**
 * Pi's compaction controls beyond the compact action itself: stopping a
 * compaction in flight, and turning auto-compaction on or off for one session.
 *
 * Stopping goes through the ordinary cancel routes. A turn's own compaction
 * (Pi compacts in a prompt's preflight and after `agent_end`, both inside the
 * run) already stops with the turn, because `AgentSession.abort()` aborts it.
 * What had no way out was the manual compaction the compact route starts: it
 * holds no prompt claim, so a cancel found nothing to stop while a hung
 * summary request kept the session busy.
 *
 * Auto-compaction is a session toggle published as a model parameter, which
 * the shared composer already renders. Pi's own `setAutoCompactionEnabled`
 * writes `compaction.enabled` into the account-wide `settings.json`, changing
 * every Pi session and terminal tab on the host, so the bridge never calls it.
 * The choice instead overrides the session's settings manager in memory and
 * is kept in the bridge's state file, so it survives a re-attach and a
 * restart without touching the user's Pi settings.
 */
import type { AgentModel, NativeAgentComposerState } from "@orkestrator/protocol/native-agent";
import type { SettingsManager } from "./pi-sdk.js";
import type { SessionState } from "./state.js";

/** The composer parameter id; the backend stores the value under it. */
export const AUTO_COMPACTION_PARAMETER_ID = "autoCompaction";

/** Pi's built-in default when no settings file says otherwise. */
const PI_AUTO_COMPACTION_DEFAULT = true;

/** What the cancel route answers when a compaction was stopped. */
export const COMPACTION_CANCELLED_MESSAGE =
  "Compaction was stopped before it finished; the conversation was not compacted.";

/**
 * A manual compaction the compact route is running. Runtime-only: a process
 * that restarts has no compaction in flight.
 */
export interface ManualCompaction {
  cancelRequested: boolean;
  /** Settles when the route is done; `true` when the compaction was stopped. */
  settled: Promise<boolean>;
}

/** Whether auto-compaction is on for this session, as Pi will apply it. */
export function autoCompactionEnabled(
  state: Pick<SessionState, "autoCompaction" | "autoCompactionSetting">,
): boolean {
  return state.autoCompaction ?? state.autoCompactionSetting ?? PI_AUTO_COMPACTION_DEFAULT;
}

/**
 * The session's composer as published: every model carries the toggle and the
 * composer carries its current value.
 *
 * Derived at publication rather than stored, so a catalogue rehydration, a
 * restored selection or a test hook that replaces the model list can never
 * drop it. The descriptor's default is Pi's own setting, so a session nobody
 * toggled shows what Pi will actually do.
 */
export function publicComposer(state: SessionState): NativeAgentComposerState {
  const composer = state.composer;
  const parameter: NonNullable<AgentModel["parameters"]>[number] = {
    id: AUTO_COMPACTION_PARAMETER_ID,
    label: "Auto-compact",
    kind: "toggle",
    defaultValue: state.autoCompactionSetting ?? PI_AUTO_COMPACTION_DEFAULT,
    scope: "session",
  };
  return {
    ...composer,
    models: composer.models.map((model) => ({
      ...model,
      parameters: [
        ...(model.parameters ?? []).filter((entry) => entry.id !== AUTO_COMPACTION_PARAMETER_ID),
        parameter,
      ],
    })),
    parameterValues: {
      ...composer.parameterValues,
      [AUTO_COMPACTION_PARAMETER_ID]: autoCompactionEnabled(state),
    },
  };
}

/** The toggle's value from a request body's `parameterValues`, if it sets one. */
export function parseAutoCompaction(parameterValues: unknown): boolean | undefined {
  if (!parameterValues || typeof parameterValues !== "object" || Array.isArray(parameterValues)) {
    return undefined;
  }
  const value = (parameterValues as Record<string, unknown>)[AUTO_COMPACTION_PARAMETER_ID];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Make the session's settings manager answer the session's choice.
 *
 * Instance-level, and read on every call, so the override holds across the
 * settings manager's own `save()` and `reload()` (both recompute its merged
 * settings, which would drop an `applyOverrides` patch) and follows a later
 * toggle without re-attaching. `getCompactionSettings` and
 * `AgentSession.autoCompactionEnabled` both read through
 * `getCompactionEnabled`; `compaction-controls.test.ts` pins that against the
 * real SDK. Returns Pi's own setting, read before the override.
 */
export function installAutoCompactionOverride(
  settingsManager: SettingsManager,
  choice: () => boolean | undefined,
): boolean {
  const own = settingsManager.getCompactionEnabled.bind(settingsManager);
  const setting = own();
  settingsManager.getCompactionEnabled = () => choice() ?? own();
  return setting;
}

/** Read Pi's own auto-compaction setting; `undefined` when it cannot be read. */
export function readAutoCompactionSetting(read: () => SettingsManager): boolean | undefined {
  try {
    return read().getCompactionEnabled();
  } catch {
    return undefined;
  }
}

/**
 * Stop the manual compaction in flight, if there is one.
 *
 * Recorded first, so a compaction Pi has not started yet (the route is still
 * attaching, or Pi is inside `compact()`'s own `abort()` before it creates its
 * abort controller) is stopped as soon as it can be: the route checks the mark
 * before calling Pi, and the session listener aborts again on
 * `compaction_start`. Returns the route's settlement, or `undefined` when no
 * manual compaction is running.
 */
export function requestCompactionCancellation(state: SessionState): Promise<boolean> | undefined {
  const compaction = state.manualCompaction;
  if (!compaction) return undefined;
  compaction.cancelRequested = true;
  state.session?.abortCompaction();
  return compaction.settled;
}

/**
 * The session listener's half of {@link requestCompactionCancellation}: a
 * cancel recorded before Pi created the compaction's abort controller is
 * applied the moment Pi announces the compaction.
 */
export function abortCancelledCompactionOnStart(
  state: SessionState,
  event: { type: string },
  session: { abortCompaction(): void },
): void {
  if (event.type === "compaction_start" && state.manualCompaction?.cancelRequested) {
    session.abortCompaction();
  }
}
