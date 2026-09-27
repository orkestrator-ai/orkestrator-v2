/**
 * Which shared bridge HTTP-contract scenarios apply to which managed bridge.
 *
 * One row per bridge, one entry per scenario, and no defaults: a scenario a
 * bridge does not support is an explicit `supported: false` with the reason,
 * reported by the runner as a skipped test. Nothing is silently absent, and no
 * bridge is granted a behaviour its engine does not have — see plan step 11
 * ("do not create a universal fake agent that falsely grants every vendor
 * every feature").
 *
 * A `false` here is a statement about the bridge's current contract, not a
 * test gap to paper over. Where the reason names a divergent wire shape, that
 * divergence is the finding; change the bridge (and this row) together.
 */
import type { BridgeId, ScenarioId } from "./scenarios.js";

export type Capability = { supported: true } | { supported: false; reason: string };

const yes: Capability = { supported: true };
const no = (reason: string): Capability => ({ supported: false, reason });

export const BRIDGE_CONTRACT_CAPABILITIES: Record<BridgeId, Record<ScenarioId, Capability>> = {
  cursor: {
    "unknown-session-in-band": yes,
    "close-retains-then-missing": yes,
    "close-pending-fences-prompt": yes,
    "cancel-idle-in-band": yes,
    "abort-idle-acknowledged": yes,
    "transcript-cursor-grammar": yes,
    "create-ack-recoverable": yes,
    "dispatch-probe-unknown": yes,
    "steer-dispatch-probe-unknown": yes,
    "bounded-recovery-summary": yes,
  },
  pi: {
    "unknown-session-in-band": yes,
    "close-retains-then-missing": yes,
    "close-pending-fences-prompt": yes,
    "cancel-idle-in-band": yes,
    "abort-idle-acknowledged": yes,
    "transcript-cursor-grammar": yes,
    "create-ack-recoverable": yes,
    "dispatch-probe-unknown": yes,
    "steer-dispatch-probe-unknown": yes,
    "bounded-recovery-summary": no(
      "runtime-health publishes no bounded-state occupancy or limits (steer journal and queue sizes are internal)",
    ),
  },
  claude: {
    "unknown-session-in-band": yes,
    "close-retains-then-missing": yes,
    "close-pending-fences-prompt": yes,
    "cancel-idle-in-band": no(
      "no /cancel route; idle /abort answers 200 {status:'not_running'} rather than {cancelled:false}",
    ),
    "abort-idle-acknowledged": yes,
    "transcript-cursor-grammar": no(
      "/messages has no fromIndex cursor; it answers the bounded whole transcript",
    ),
    "create-ack-recoverable": no(
      "nothing is published at create: the bridge id is derived from the client key (session-client-<sdk uuid>) and the SDK rollout is the durable record",
    ),
    "dispatch-probe-unknown": yes,
    "steer-dispatch-probe-unknown": yes,
    "bounded-recovery-summary": no("runtime-health publishes no bounded-state occupancy or limits"),
  },
  codex: {
    "unknown-session-in-band": yes,
    "close-retains-then-missing": yes,
    "close-pending-fences-prompt": yes,
    "cancel-idle-in-band": no(
      "no /cancel route; /abort answers 202 {status, phase} because turn/interrupt is asynchronous",
    ),
    "abort-idle-acknowledged": yes,
    "transcript-cursor-grammar": no(
      "/messages has no fromIndex cursor; it answers the bounded whole transcript",
    ),
    "create-ack-recoverable": no(
      "nothing is published at create: the id is sha256(cwd, clientSessionKey) and no Codex thread exists until the first prompt",
    ),
    "dispatch-probe-unknown": yes,
    "steer-dispatch-probe-unknown": yes,
    "bounded-recovery-summary": no("runtime-health publishes no bounded-state occupancy or limits"),
  },
  acp: {
    "unknown-session-in-band": yes,
    "close-retains-then-missing": yes,
    "close-pending-fences-prompt": yes,
    "cancel-idle-in-band": no(
      "cancel/abort are fire-and-forget session/cancel notifications answered 202 {accepted:true} in every state",
    ),
    "abort-idle-acknowledged": yes,
    "transcript-cursor-grammar": yes,
    "create-ack-recoverable": yes,
    "dispatch-probe-unknown": yes,
    "steer-dispatch-probe-unknown": no(
      "no steer route: Grok interjections are journaled prompts, and there is no /steer/dispatch probe",
    ),
    "bounded-recovery-summary": no("runtime-health publishes no bounded-state occupancy or limits"),
  },
};
