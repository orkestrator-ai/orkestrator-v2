/**
 * Which provider-replay scenarios apply to which bridge.
 *
 * One row per bridge, one entry per scenario, no defaults. A scenario a
 * bridge cannot have is `supported: false` with the reason, reported as a
 * skipped test, and the runner refuses a fixture for it. A `false` is a
 * statement about the provider and the bridge as they are, not a coverage gap
 * to paper over: change the row together with the bridge.
 *
 * Every supported scenario needs at least one fixture in that bridge's
 * `src/testing/provider-replay/` directory.
 */
import type { ProviderReplayBridge } from "./fixture.js";
import type { ProviderReplayScenarioId } from "./scenarios.js";

export type ReplayCapability = { supported: true } | { supported: false; reason: string };

const yes: ReplayCapability = { supported: true };
const no = (reason: string): ReplayCapability => ({ supported: false, reason });

export const PROVIDER_REPLAY_CAPABILITIES: Record<
  ProviderReplayBridge,
  Record<ProviderReplayScenarioId, ReplayCapability>
> = {
  claude: {
    "basic-turn": yes,
    "approval-denial": yes,
    interruption: yes,
    "late-background-output": yes,
    resume: yes,
    "session-rekey": yes,
    "malformed-events": yes,
    "outside-tail-update": yes,
  },
  cursor: {
    "basic-turn": yes,
    "approval-denial": no(
      "the Cursor SDK exposes no approval callback; the bridge answers /approvals and /interactions with []",
    ),
    interruption: yes,
    "late-background-output": no(
      "the SDK reports output only through the run's own updates, so nothing can arrive after the run settles; children are settled as detached at run end",
    ),
    resume: yes,
    "session-rekey": no(
      "the bridge keeps the SDK agent id it created or resumed and never adopts a different one from the provider",
    ),
    "malformed-events": yes,
    "outside-tail-update": yes,
  },
  pi: {
    "basic-turn": yes,
    "approval-denial": yes,
    interruption: yes,
    "late-background-output": no(
      "Pi frames carry no run identity, so the bridge drops turn-scoped frames once the run settles (turnFramesWelcome); there is no late-output path to pin",
    ),
    resume: yes,
    "session-rekey": no(
      "the SDK session is opened from the bridge's own session file; Pi never answers under another session id",
    ),
    "malformed-events": yes,
    "outside-tail-update": yes,
  },
  acp: {
    "basic-turn": yes,
    "approval-denial": yes,
    interruption: yes,
    "late-background-output": yes,
    resume: yes,
    "session-rekey": no(
      "session/new and session/load answer under the id the bridge asked for; ACP has no frame that moves a live session to a new id",
    ),
    "malformed-events": yes,
    "outside-tail-update": yes,
  },
};
