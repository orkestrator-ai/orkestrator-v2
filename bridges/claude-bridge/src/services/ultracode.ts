/**
 * Claude Code's Ultracode: standing dynamic-workflow orchestration for a
 * session. The composer offers it as a reasoning level (`ultracode`), which
 * `resolveUltracodeEffort` splits into `high` effort plus the internal
 * `parameterValues.ultracode` flag; this module is the only place that knows how
 * the CLI spells it.
 *
 * Since Claude Code 2.1.284 (Agent SDK 0.3.284) Ultracode is independent of
 * effort: it no longer forces `xhigh` and stays on at any level. Two CLI rules
 * shape what follows:
 *
 * - It is a flag-layer setting (`settings.ultracode`), never persisted, so each
 *   turn's query has to be started with it again.
 * - A partial `applyFlagSettings` can turn Ultracode off. The backend's control
 *   updates are partial, so the bridge carries the applied value into a flag
 *   change to keep it on.
 */

import { CLAUDE_ULTRACODE_REASONING_ID } from "@orkestrator/protocol/claude-model-catalog";
import { sessionHealth, type ClaudeQueryControl, type SessionState } from "../types/index.js";

/** The bridge-internal flag `resolveUltracodeEffort` sets and the rest of this module reads. */
const ULTRACODE_PARAMETER_ID = "ultracode";

/**
 * Split a requested reasoning level into what the CLI understands.
 *
 * The `ultracode` level runs at `high` effort with the flag on. Any real effort
 * level turns the flag off explicitly, so leaving Ultracode for another level
 * is not undone by the carry-over in `ultracodeFlagSetting`. No level leaves
 * both untouched.
 */
export function resolveUltracodeEffort(
  effort: string | undefined,
  parameterValues: Record<string, string | boolean> | undefined,
): {
  effort: string | undefined;
  parameterValues: Record<string, string | boolean> | undefined;
} {
  if (effort === undefined) return { effort, parameterValues };
  const ultracode = effort === CLAUDE_ULTRACODE_REASONING_ID;
  return {
    effort: ultracode ? "high" : effort,
    parameterValues: { ...parameterValues, [ULTRACODE_PARAMETER_ID]: ultracode },
  };
}

/** Whether this turn's parameters ask for Ultracode. */
export function requestsUltracode(
  parameterValues: Record<string, string | boolean> | undefined,
): boolean {
  return parameterValues?.[ULTRACODE_PARAMETER_ID] === true;
}

/**
 * The `ultracode` key to merge into one `applyFlagSettings` call, if any.
 *
 * An explicit toggle wins. Otherwise the live value is carried along with an
 * flag change so the CLI keeps it on. A model change instead turns it off:
 * the backend clears model-scoped parameters on a model switch, so the live
 * query has to follow or the composer would show Off over a turn running with
 * it. `false` is always accepted; `true` makes the CLI refuse the whole call
 * when the new model cannot run Ultracode.
 */
export function ultracodeFlagSetting(input: {
  parameterValues?: Record<string, string | boolean>;
  effortChanged: boolean;
  fastModeChanged: boolean;
  modelChanged: boolean;
  live: boolean | undefined;
}): { ultracode: boolean } | Record<string, never> {
  const explicit = input.parameterValues?.[ULTRACODE_PARAMETER_ID];
  if (typeof explicit === "boolean") return { ultracode: explicit };
  if (input.live !== true) return {};
  if (input.modelChanged) return { ultracode: false };
  return input.effortChanged || input.fastModeChanged ? { ultracode: true } : {};
}

export interface UltracodeRuntimeState {
  requested: boolean;
  active: boolean;
  available?: boolean;
}

/**
 * Read the CLI's runtime Ultracode state from a `getSettings()` answer.
 *
 * `applied` is the runtime-resolved block, not the on-disk merge: `ultracode`
 * says whether it is in effect, `ultracodeRequested` whether the session asked
 * for it, and `ultracodeAvailable` whether dynamic workflows are enabled and
 * the model supports it. Undefined for a CLI that predates the fields.
 */
export function ultracodeRuntimeState(settings: unknown): UltracodeRuntimeState | undefined {
  if (!settings || typeof settings !== "object") return undefined;
  const applied = (settings as { applied?: unknown }).applied;
  if (!applied || typeof applied !== "object") return undefined;
  const { ultracode, ultracodeRequested, ultracodeAvailable } = applied as Record<string, unknown>;
  if (typeof ultracodeRequested !== "boolean") return undefined;
  return {
    requested: ultracodeRequested,
    active: ultracode === true,
    ...(typeof ultracodeAvailable === "boolean" ? { available: ultracodeAvailable } : {}),
  };
}

/**
 * Advisory text for a turn that asked for Ultracode and did not get it, or
 * undefined when there is nothing to say.
 */
export function ultracodeUnavailableNotice(
  state: UltracodeRuntimeState | undefined,
): { message: string; detail: string } | undefined {
  if (!state?.requested || state.active) return undefined;
  return {
    message: "Ultracode is not available for this Claude session",
    detail:
      state.available === false
        ? "Claude Code reports that dynamic workflows are off for this account or the selected model does not support Ultracode. The turn ran without it."
        : "Claude Code did not turn Ultracode on for this turn. The turn ran without it.",
  };
}

/** Sessions already told this; cleared once Ultracode takes effect again. */
const noticedSessions = new WeakSet<SessionState>();

/**
 * One runtime read per turn that asked for Ultracode, off the message path.
 *
 * The composer offers the toggle from the model catalogue, which cannot see
 * whether dynamic workflows are enabled for the account. The CLI can, and
 * starts the turn without Ultracode rather than failing it, so without this
 * read a user would see "Ultracode: On" over a turn that ran without it.
 */
export function reportUltracodeRuntime(session: SessionState, control: ClaudeQueryControl): void {
  if (session.ultracode !== true || typeof control.getSettings !== "function") return;
  void control
    .getSettings()
    .then((settings) => {
      if (session.queryControl !== control) return;
      const state = ultracodeRuntimeState(settings);
      if (state) session.ultracodeApplied = state.active;
      if (state?.active) {
        noticedSessions.delete(session);
        return;
      }
      const notice = ultracodeUnavailableNotice(state);
      if (!notice || noticedSessions.has(session)) return;
      noticedSessions.add(session);
      sessionHealth(session).recordNotice({
        ...notice,
        method: "settings/ultracode",
        severity: "warning",
        source: "provider",
      });
    })
    // A turn that ends before the read answers has nothing left to report on.
    .catch(() => undefined);
}
