/**
 * The opt-in provider-traffic recorder for this bridge.
 *
 * Null unless `ORKESTRATOR_PROVIDER_RECORD_DIR` and
 * `ORKESTRATOR_PROVIDER_RECORD_CONFIRM=1` are both set; see
 * `@orkestrator/protocol/node/provider-replay-recorder` and
 * `tests/conformance/provider-replay/README.md`. Frames are the SDK messages
 * the runtime's single consumer reads, and each `canUseTool` call in the
 * CLI's own `control_request` shape, which is how the replay suite delivers
 * it back.
 */
import { createProviderReplayRecorderFromEnv } from "@orkestrator/protocol/node/provider-replay-recorder";
import { claudeSdkVersion } from "./session-manager-interactions.js";

export const replayRecorder = createProviderReplayRecorderFromEnv({
  bridge: "claude",
  provider: "@anthropic-ai/claude-agent-sdk",
  providerVersion: claudeSdkVersion,
});
