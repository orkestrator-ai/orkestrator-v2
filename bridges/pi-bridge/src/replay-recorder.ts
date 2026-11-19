/**
 * The opt-in provider-traffic recorder for this bridge.
 *
 * Null unless `ORKESTRATOR_PROVIDER_RECORD_DIR` and
 * `ORKESTRATOR_PROVIDER_RECORD_CONFIRM=1` are both set; see
 * `@orkestrator/protocol/node/provider-replay-recorder` and
 * `tests/conformance/provider-replay/README.md`. Frames are recorded where
 * `applySessionEvent` and the approval hook receive them, in the shape the
 * replay suite hands back to those same functions.
 */
import { VERSION } from "@earendil-works/pi-coding-agent";
import { createProviderReplayRecorderFromEnv } from "@orkestrator/protocol/node/provider-replay-recorder";

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";

export const replayRecorder = createProviderReplayRecorderFromEnv({
  bridge: "pi",
  provider: SDK_PACKAGE,
  providerVersion: VERSION,
});
