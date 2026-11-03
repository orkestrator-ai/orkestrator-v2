#!/usr/bin/env bun
/**
 * The real Cursor bridge over a fake Cursor SDK, as a standalone process.
 *
 * Browser specs drive a native Cursor tab through the real backend and this
 * bridge without a credential or a network call. Only the vendor engine is
 * fake: `Agent.create`, `resume`, `list` and `listRuns` answer from a store
 * of conversations this process keeps in `FAKE_CURSOR_STORE`, so a closed
 * conversation stays listed and resumable exactly as long as the store keeps
 * it. Routes, journals, persistence, translation and close are production
 * code. Nothing in the production path knows this file exists.
 *
 * `list` reports each agent under the name it was created with (the bridge
 * always passes `Orkestrator`) and the first prompt as its `summary`.
 *
 * The store is the vendor's truth for assertions: one entry per agent, with
 * every turn it actually ran. A duplicated or lost prompt shows up there, not
 * just in the bridge's own transcript. Each turn's `prompt` is the user's text
 * with the bridge's `<orkestrator-system-instructions>` frame stripped, so a
 * spec compares what the user typed; `sent` keeps the exact text the SDK was
 * given, frame included, and is what history replay returns, as the real
 * vendor's conversation would.
 *
 * Prompts:
 * - containing `HOLD`: the run stays open until it is cancelled, then ends
 *   `cancelled`. Lets a spec close a tab in the middle of a turn.
 * - anything else: answered `Answer to: <prompt>` (the stripped prompt) and
 *   finished.
 *
 * Cold start: while the file `FAKE_CURSOR_CREATE_GATE` exists, `Agent.create`
 * does not return, standing in for an SDK agent that takes its time to start.
 *
 * Every SDK call on an agent is appended to `FAKE_CURSOR_LOG` as
 * `<event>:<agentId>` (`create`, `resume`, `send`, `steer`, `dispose`), for
 * ordering assertions.
 *
 * Environment: the bridge's own (`PORT`, `HOSTNAME`, `CWD`,
 * `CURSOR_BRIDGE_TOKEN`, `CURSOR_BRIDGE_STATE_DIR`, `CURSOR_BRIDGE_AUTH_FILE`)
 * plus `FAKE_CURSOR_STORE`, `FAKE_CURSOR_LOG` and `FAKE_CURSOR_CREATE_GATE`.
 * `CURSOR_API_KEY` is set here, so the bridge reads as signed in.
 */
import { createFakeCursorAgentApi } from "./fake-engine.js";

process.env.CURSOR_API_KEY = "fake-engine-no-provider-requests";
// Turns the workspace snapshot probe off: there is nothing to measure.
process.env.NODE_ENV = "test";

const { setCursorMcpFingerprintForTests, useCursorAgentForTests } =
  await import("../agent-session.js");
const { useCursorSdkRuntimeForTests, useCursorLocalAgentStoreForTests } =
  await import("../sdk-runtime.js");
const { useCursorModelsForTests } = await import("../models.js");
const { useCursorCredentialRuntimeForTests } = await import("../credentials.js");
const { resetPlanAccountWindowsForTests } = await import("../plan-usage.js");
const { useCommandChangeProbeForTests } = await import("../command-changes.js");
const { start } = await import("../server.js");

const storePath = process.env.FAKE_CURSOR_STORE;
if (!storePath) throw new Error("FAKE_CURSOR_STORE is required");
const fakeAgentApi = createFakeCursorAgentApi({
  storePath,
  logPath: process.env.FAKE_CURSOR_LOG,
  createGate: process.env.FAKE_CURSOR_CREATE_GATE,
});

resetPlanAccountWindowsForTests();
useCommandChangeProbeForTests(null);
setCursorMcpFingerprintForTests(async () => "fake-engine");
useCursorSdkRuntimeForTests({
  configureStore: () => undefined,
  createPlatform: (async () => ({
    prewarmLocalWorkspace: async () => async () => undefined,
  })) as unknown as typeof import("@cursor/sdk").createAgentPlatform,
});
useCursorLocalAgentStoreForTests({
  agents: { get: async () => undefined },
  runs: { get: async () => undefined },
} as unknown as Parameters<typeof useCursorLocalAgentStoreForTests>[0]);
useCursorModelsForTests({
  list: async () => [{ id: "composer-2", displayName: "Composer 2" }],
} as unknown as typeof import("@cursor/sdk").Cursor.models);
useCursorCredentialRuntimeForTests({
  store: {
    load: async () => undefined,
    save: async () => undefined,
    clear: async () => undefined,
  },
  auth: { login: async () => undefined, logout: async () => undefined } as never,
});
useCursorAgentForTests(fakeAgentApi as unknown as Parameters<typeof useCursorAgentForTests>[0]);
await start();
