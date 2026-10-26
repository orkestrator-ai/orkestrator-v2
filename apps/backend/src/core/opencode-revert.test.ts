import { describe, expect, test } from "bun:test";
import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2/types";
import { openCodeMessageId } from "./opencode-history-test-support.js";
import {
  openCodeRevertMarker,
  openCodeRevertNotice,
  withoutRevertedOpenCodeMessages,
} from "./opencode-revert.js";
import { OpenCodeStreamState } from "./opencode-stream-state.js";

function message(index: number, partCount = 1) {
  const id = openCodeMessageId(index);
  return {
    info: { id, role: index === 0 ? "user" : "assistant", time: { created: 1_000 + index } },
    parts: Array.from({ length: partCount }, (_, part) => ({
      id: `prt_${index}_${part}`,
      messageID: id,
      type: "text",
      text: `${index}.${part}`,
    })),
  };
}

function ids(messages: readonly unknown[]): string[] {
  return messages.map((entry) => (entry as { info: { id: string } }).info.id);
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => openCodeMessageId(from + index));

describe("openCodeRevertMarker", () => {
  test("reads Session.revert and ignores a missing or malformed one", () => {
    expect(
      openCodeRevertMarker({ revert: { messageID: "msg_1", snapshot: "s", diff: "" } }),
    ).toEqual({ messageId: "msg_1" });
    expect(openCodeRevertMarker({ revert: { messageID: "msg_1", partID: "prt_2" } })).toEqual({
      messageId: "msg_1",
      partId: "prt_2",
    });
    expect(openCodeRevertMarker({ id: "ses_1" })).toBeUndefined();
    expect(openCodeRevertMarker({ revert: { messageID: "" } })).toBeUndefined();
    expect(openCodeRevertMarker({ revert: { messageID: "m".repeat(257) } })).toBeUndefined();
    expect(openCodeRevertMarker(null)).toBeUndefined();
  });
});

describe("withoutRevertedOpenCodeMessages", () => {
  const messages = Array.from({ length: 6 }, (_, index) => message(index, 3));

  test("hides every message from the reverted one on, like SessionRevert.cleanup", () => {
    const visible = withoutRevertedOpenCodeMessages(messages, { messageId: openCodeMessageId(3) });
    expect(ids(visible)).toEqual(range(0, 3));
    expect(withoutRevertedOpenCodeMessages(messages, undefined)).toBe(messages);
  });

  test("a partial revert keeps the target's parts before the reverted part", () => {
    const visible = withoutRevertedOpenCodeMessages(messages, {
      messageId: openCodeMessageId(3),
      partId: "prt_3_1",
    });
    expect(ids(visible)).toEqual(range(0, 4));
    const target = visible[3] as { parts: Array<{ id: string }> };
    expect(target.parts.map((part) => part.id)).toEqual(["prt_3_0"]);
    // The read itself is untouched: unrevert must find everything still there.
    expect(messages[3]!.parts).toHaveLength(3);
  });

  test("a partial revert naming a part the target lacks keeps the whole target", () => {
    const visible = withoutRevertedOpenCodeMessages(messages, {
      messageId: openCodeMessageId(3),
      partId: "prt_missing",
    });
    expect(ids(visible)).toEqual(range(0, 4));
    expect((visible[3] as { parts: unknown[] }).parts).toHaveLength(3);
  });

  test("a read that does not hold the target is cut by OpenCode's ascending ids", () => {
    // A page older than the target keeps everything.
    expect(
      ids(withoutRevertedOpenCodeMessages(messages, { messageId: openCodeMessageId(10) })),
    ).toEqual(range(0, 6));
    // A window that starts after the target hides everything.
    const later = [message(7), message(8)];
    expect(withoutRevertedOpenCodeMessages(later, { messageId: openCodeMessageId(6) })).toEqual([]);
    // A target removed from a window it fell inside still cuts at its place.
    const gapped = [message(1), message(2), message(4), message(5)];
    expect(
      ids(withoutRevertedOpenCodeMessages(gapped, { messageId: openCodeMessageId(3) })),
    ).toEqual([openCodeMessageId(1), openCodeMessageId(2)]);
  });

  test("rows without an OpenCode id are judged by position", () => {
    const compaction = {
      info: { id: "opencode-evt", role: "assistant", time: { created: 2_000 } },
      parts: [{ id: "evt", type: "compaction" }],
    };
    const read = [message(1), compaction, message(2), message(3)];
    expect(ids(withoutRevertedOpenCodeMessages(read, { messageId: openCodeMessageId(3) }))).toEqual(
      [openCodeMessageId(1), "opencode-evt", openCodeMessageId(2)],
    );
    expect(ids(withoutRevertedOpenCodeMessages(read, { messageId: openCodeMessageId(2) }))).toEqual(
      [openCodeMessageId(1), "opencode-evt"],
    );
  });
});

test("the pending-revert notice is an info advisory keyed by the marker", () => {
  expect(openCodeRevertNotice(undefined)).toEqual([]);
  const [notice] = openCodeRevertNotice({ messageId: "msg_1" });
  expect(notice).toMatchObject({
    kind: "advisory",
    severity: "info",
    occurrenceId: "opencode-revert:msg_1:",
  });
  expect(openCodeRevertNotice({ messageId: "msg_2" })[0]!.occurrenceId).not.toBe(
    notice!.occurrenceId,
  );
});

describe("OpenCodeStreamState revert marker", () => {
  const updated = (revert?: Record<string, unknown>) =>
    ({
      type: "session.updated",
      properties: {
        sessionID: "session",
        info: { id: "session", title: "Title", ...(revert ? { revert } : {}) },
      },
    }) as unknown as OpenCodeEvent;

  test("session.updated sets and clears it, moving revision and history epoch", () => {
    const state = new OpenCodeStreamState();
    state.register("session");
    expect(state.revertMarkerKnown("session")).toBe(false);

    const epoch = state.historyEpoch("session");
    state.apply(updated({ messageID: "msg_2", snapshot: "abc" }));
    expect(state.revertMarker("session")).toEqual({ messageId: "msg_2" });
    expect(state.revertMarkerKnown("session")).toBe(true);
    const reverted = state.historyEpoch("session");
    expect(reverted).not.toBe(epoch);

    // A title update re-sends the same marker: paged history stays valid.
    const revision = state.revision("session");
    state.apply(updated({ messageID: "msg_2", snapshot: "abc" }));
    expect(state.historyEpoch("session")).toBe(reverted);
    expect(state.revision("session")).toBe(revision + 1);

    // A cleared revert is published without the field.
    state.apply(updated());
    expect(state.revertMarker("session")).toBeUndefined();
    expect(state.historyEpoch("session")).not.toBe(reverted);
  });

  test("an update with no marker on a session that never had one keeps the epoch", () => {
    const state = new OpenCodeStreamState();
    const epoch = state.historyEpoch("session");
    state.apply(updated());
    expect(state.revertMarkerKnown("session")).toBe(true);
    expect(state.historyEpoch("session")).toBe(epoch);
  });

  test("a stream gap makes the marker unknown but keeps it to serve meanwhile", () => {
    const state = new OpenCodeStreamState();
    state.apply(updated({ messageID: "msg_2" }));
    state.markGap();
    expect(state.revertMarkerKnown("session")).toBe(false);
    expect(state.revertMarker("session")).toEqual({ messageId: "msg_2" });
  });

  test("a session read an update overtook does not install its older marker", () => {
    const state = new OpenCodeStreamState();
    state.register("session");
    const version = state.revertVersion("session");
    state.apply(updated({ messageID: "msg_4" }));
    expect(state.observeRevert("session", undefined, version)).toBe(false);
    expect(state.revertMarker("session")).toEqual({ messageId: "msg_4" });

    const current = state.revertVersion("session");
    expect(state.observeRevert("session", undefined, current)).toBe(true);
    expect(state.revertMarker("session")).toBeUndefined();
  });

  test("invalidateRevert asks for a read without dropping the marker", () => {
    const state = new OpenCodeStreamState();
    state.observeRevert("session", { messageId: "msg_1" });
    const version = state.revertVersion("session");
    state.invalidateRevert("session");
    expect(state.revertMarkerKnown("session")).toBe(false);
    expect(state.revertVersion("session")).not.toBe(version);
    expect(state.revertMarker("session")).toEqual({ messageId: "msg_1" });
  });
});
