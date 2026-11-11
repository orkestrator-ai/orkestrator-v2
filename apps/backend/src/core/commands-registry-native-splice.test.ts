/**
 * Which native-agent command results the gateway splices from memoised row
 * encodings (`markSpliceableResult`). The legacy `get_native_agent_projection`
 * is still left out. On 2026-11-10 the first splice was slower than
 * `JSON.stringify` on its whole-session projection; the narrowed splice
 * (to-do 7553, retired 2026-11-11) measures cheaper there, and marking it,
 * which also sets its contract `encoded` flag, is to-do 7755. Re-measure with
 * `scripts/benchmark-transcript-changed-read.ts` (`legacy-spliced` against
 * `legacy`) before marking it; the figures are in
 * docs/architecture/native-transcripts.md, "Response encoding".
 */
import { describe, expect, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { isSpliceableResult } from "./native-agent-projection-encoding.js";

const identity = {
  environmentId: "env-1",
  agent: "codex",
  logicalSessionKey: "env-env-1:splice",
};
const liveWindow = { messages: 100, targetBytes: 512 * 1024 };

const nativeAgents = {
  getProjection: async () => ({ messages: [{ id: "m1" }] }),
  getTranscriptUpdate: async () => ({ status: "snapshot", value: { messages: [] } }),
  getLiveUpdate: async () => ({ transcript: { status: "unchanged" } }),
  getProjectionUpdate: async () => ({ status: "snapshot", value: { messages: [] } }),
  getMessagePage: async () => ({ messages: [] }),
};

const calls: Array<[command: string, args: Record<string, unknown>, spliced: boolean]> = [
  ["get_native_agent_projection", identity, false],
  ["get_native_agent_transcript_update", { ...identity, viewVersion: 1, liveWindow }, true],
  ["get_native_agent_live_update", { ...identity, viewVersion: 1, liveWindow }, true],
  ["get_native_agent_projection_update", { ...identity, syncVersion: 1, liveWindow }, true],
  ["get_native_agent_message_page", { ...identity, syncVersion: 1, before: "cursor" }, true],
];

describe("native agent command splicing", () => {
  test.each(calls)("%s spliced: %p", async (command, args, spliced) => {
    const registry = createCommandRegistry();
    const handler = registry.get(command);
    expect(handler).toBeDefined();
    const result = await handler!(args, { nativeAgents } as unknown as CommandContext);
    expect(result).toBeDefined();
    expect(isSpliceableResult(result)).toBe(spliced);
  });
});
