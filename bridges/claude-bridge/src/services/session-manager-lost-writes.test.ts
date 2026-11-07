import { describe, expect, test } from "bun:test";
import { NATIVE_AGENT_LOST_WRITE_ADVISORY } from "@orkestrator/protocol/native-agent-lost-writes";
import type { NormalizedMessage, SSEEvent } from "../types/index.js";
import {
  A1,
  IDLE_TRANSCRIPT_EVICTION_MS,
  PERSISTED_SDK_ID,
  U1,
  U2,
  captureEvents,
  createSession,
  deleteSession,
  evictIdleHydratedTranscripts,
  getSession,
  hydratePersistedSessionMessages,
  materializePersistedSession,
  mockSdkGetSessionMessages,
  nextQueryCall,
  readSessionPreferences,
  sendPrompt,
  settleSessionPreferenceWritesForTesting,
  track,
  updateSessionPreferences,
  waitFor,
} from "./session-manager-test-harness.js";
import { sdkSessionIdFromBridgeId } from "./session-manager-core.js";

const OTHER_SESSION = "00000000-0000-4000-8000-0000000000aa";

/**
 * A turn that finished on a CLI that then reports `session_writes_lost` as it
 * exits: the frames arrive after the result, as the SDK documents.
 */
async function turnThenLoss(lostFrames: (sdkSessionId: string) => Array<Record<string, unknown>>) {
  const created = createSession("Lost writes");
  track(created.id);
  const sdkSessionId = sdkSessionIdFromBridgeId(created.id)!;
  const prompt = sendPrompt(created.id, "Write the report");
  const call = await nextQueryCall();
  call.push({
    type: "system",
    subtype: "init",
    session_id: sdkSessionId,
    mcp_servers: [],
    plugins: [],
    slash_commands: [],
  });
  call.push({
    type: "assistant",
    uuid: "assistant-1",
    message: { model: "claude-opus-test", content: [{ type: "text", text: "Done." }] },
  });
  call.push({ type: "result", subtype: "success" });
  let events: SSEEvent[] = [];
  const capture = captureEvents();
  try {
    for (const frame of lostFrames(sdkSessionId)) {
      call.push({
        type: "system",
        subtype: "session_writes_lost",
        error_code: "ENOSPC",
        session_id: sdkSessionId,
        ...frame,
      });
    }
    call.finish();
    // The prompt settles at the result; the CLI's exit frames come after it.
    await prompt;
    await waitFor(() => getSession(created.id)?.claudeRuntime === undefined);
    events = capture.events;
  } finally {
    capture.stop();
  }
  await settleSessionPreferenceWritesForTesting();
  return { session: getSession(created.id)!, sdkSessionId, events };
}

function advisoryRows(messages: readonly NormalizedMessage[]): NormalizedMessage[] {
  return messages.filter((message) =>
    message.parts.some(
      (part) => part.type === "status" && part.content === NATIVE_AGENT_LOST_WRITE_ADVISORY,
    ),
  );
}

/** What a row shows: its text, or a status-only row's status line. */
function shownText(message: NormalizedMessage): string {
  const status = message.parts.find((part) => part.type === "status");
  return message.content || (status?.content ?? "");
}

function lostWriteNotices(session: NonNullable<ReturnType<typeof getSession>>) {
  return (
    session.health
      ?.snapshot()
      ?.notices.filter((notice) => notice.method === "system/session_writes_lost") ?? []
  );
}

describe("session_writes_lost", () => {
  test("a lost write naming this session adds one advisory after the turn, kept on disk", async () => {
    const { session, sdkSessionId, events } = await turnThenLoss((self) => [
      { uuid: "lost-1", lost: ["transcript", "global_config"], transcript_session_ids: [self] },
      // A later process reporting again adds nothing: once per session.
      { uuid: "lost-2", lost: ["transcript"], transcript_session_ids: [self] },
    ]);

    const rows = advisoryRows(session.messages);
    expect(rows).toEqual([
      {
        id: `session-writes-lost:${sdkSessionId}`,
        // The shared shape: the status line is the whole row.
        role: "assistant",
        content: "",
        parts: [
          {
            type: "status",
            severity: "warning",
            content: NATIVE_AGENT_LOST_WRITE_ADVISORY,
            createdAt: session.writesLostAt!,
          },
        ],
        createdAt: session.writesLostAt!,
      },
    ]);
    // Arrived after the turn's own rows, so it is the newest.
    expect(session.messages.at(-1)).toBe(rows[0]!);
    expect(events).toContainEqual({
      type: "message.updated",
      sessionId: session.id,
      data: { message: rows[0] },
    });
    // `handled+notice`: the health panel keeps the storage fault as well.
    expect(lostWriteNotices(session)).toEqual([
      expect.objectContaining({ severity: "warning", source: "provider", count: 2 }),
    ]);
    expect((await readSessionPreferences(sdkSessionId))?.writesLostAt).toBe(session.writesLostAt);
  });

  test("a global_config-only loss, or one naming another session, stays a health notice", async () => {
    const { session, sdkSessionId } = await turnThenLoss(() => [
      { uuid: "lost-config", lost: ["global_config"] },
      // A CLI that /clear'ed into a new session lists the earlier one.
      { uuid: "lost-other", lost: ["transcript"], transcript_session_ids: [OTHER_SESSION] },
    ]);
    expect(advisoryRows(session.messages)).toEqual([]);
    expect(session.writesLostAt).toBeUndefined();
    expect(lostWriteNotices(session)).toEqual([expect.objectContaining({ severity: "warning" })]);
    expect((await readSessionPreferences(sdkSessionId))?.writesLostAt).toBeUndefined();
  });

  test("the advisory survives eviction and rehydration from the rollout", async () => {
    const { session, sdkSessionId } = await turnThenLoss((self) => [
      { uuid: "lost-1", lost: ["transcript"], transcript_session_ids: [self] },
    ]);
    const lostAt = Date.parse(session.writesLostAt!);
    mockSdkGetSessionMessages.mockImplementation(async () => [
      {
        type: "user",
        uuid: U1,
        session_id: sdkSessionId,
        timestamp: new Date(lostAt - 2_000).toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Write the report" }] },
        parent_tool_use_id: null,
      },
      {
        type: "assistant",
        uuid: A1,
        session_id: sdkSessionId,
        timestamp: new Date(lostAt - 1_000).toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        parent_tool_use_id: null,
      },
      {
        type: "user",
        uuid: U2,
        session_id: sdkSessionId,
        timestamp: new Date(lostAt + 60_000).toISOString(),
        message: { role: "user", content: [{ type: "text", text: "A later prompt" }] },
        parent_tool_use_id: null,
      },
    ]);
    session.lastAccessedAt = Date.now() - IDLE_TRANSCRIPT_EVICTION_MS - 1;
    session.lastStreamedRevisionAt = Date.now() - IDLE_TRANSCRIPT_EVICTION_MS - 1;
    expect(evictIdleHydratedTranscripts(Date.now())).toContain(session.id);
    expect(session.messages).toEqual([]);

    const messages = await hydratePersistedSessionMessages(session.id);
    // Placed by time, where the live tab showed it, not under the later turn.
    expect(messages.map(shownText)).toEqual([
      "Write the report",
      "Done.",
      NATIVE_AGENT_LOST_WRITE_ADVISORY,
      "A later prompt",
    ]);
    expect(advisoryRows(await hydratePersistedSessionMessages(session.id))).toHaveLength(1);
  });

  test("a restarted bridge restores the advisory from the session preferences", async () => {
    const writesLostAt = "2026-07-01T00:00:00.000Z";
    await updateSessionPreferences(PERSISTED_SDK_ID, { writesLostAt });
    await settleSessionPreferenceWritesForTesting();
    mockSdkGetSessionMessages.mockImplementation(async () => [
      {
        type: "user",
        uuid: U1,
        session_id: PERSISTED_SDK_ID,
        timestamp: "2026-06-30T23:59:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Before the loss" }] },
        parent_tool_use_id: null,
      },
    ]);
    const restored = await materializePersistedSession();
    expect(restored.writesLostAt).toBe(writesLostAt);
    const messages = await hydratePersistedSessionMessages(restored.id);
    expect(messages.map(shownText)).toEqual(["Before the loss", NATIVE_AGENT_LOST_WRITE_ADVISORY]);
    expect(advisoryRows(messages)[0]?.createdAt).toBe(writesLostAt);
    deleteSession(restored.id);
  });
});
