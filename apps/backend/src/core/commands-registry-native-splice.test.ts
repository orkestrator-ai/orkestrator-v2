/**
 * Which native-agent command results the gateway splices from memoised row
 * encodings (`markSpliceableResult`). The legacy `get_native_agent_projection`
 * is deliberately left out: measured on 2026-11-10, splicing its
 * whole-session projection was slower than `JSON.stringify` on every row shape
 * the changed-read benchmark has, because the walk over its many non-row
 * fields runs in JavaScript and the joined body is copied again when the
 * gateway sizes it. Re-measure with `scripts/benchmark-transcript-changed-read.ts`
 * (`legacy-spliced` against `legacy`) before marking it; the figures are in
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
