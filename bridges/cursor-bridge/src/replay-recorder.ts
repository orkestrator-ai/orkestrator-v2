/**
 * The opt-in provider-traffic recorder for this bridge.
 *
 * Null unless `ORKESTRATOR_PROVIDER_RECORD_DIR` and
 * `ORKESTRATOR_PROVIDER_RECORD_CONFIRM=1` are both set; see
 * `@orkestrator/protocol/node/provider-replay-recorder` and
 * `tests/conformance/provider-replay/README.md`. Frames are the interaction
 * updates `onDelta` delivers, recorded before the bridge reads them, in the
 * shape the replay suite hands back to `applyInteractionUpdate`.
 */
import {
  createProviderReplayRecorderFromEnv,
  installedPackageVersion,
} from "@orkestrator/protocol/node/provider-replay-recorder";

const SDK_PACKAGE = "@cursor/sdk";

export const replayRecorder = createProviderReplayRecorderFromEnv({
  bridge: "cursor",
  provider: SDK_PACKAGE,
  providerVersion: () => installedPackageVersion(SDK_PACKAGE, import.meta.url),
});
