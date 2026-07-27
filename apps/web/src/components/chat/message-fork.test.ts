import { describe, expect, test } from "bun:test";
import type {
  NativeMessage,
  NativeMessagePart,
} from "@/lib/chat/native-message-types";
import {
  buildMessageForkActionKinds,
  buildMessageForkPlan,
  countForkPromptAttachments,
  findNextForkMessage,
  findPreviousForkMessage,
  forkAttachmentNotice,
  getForkPromptText,
  type MessageForkBoundary,
} from "./message-fork";

function message(
  id: string,
  role: NativeMessage["role"],
  content = id,
  extra: Partial<NativeMessage> = {},
): NativeMessage {
  return {
    id,
    role,
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-07-27T12:00:00.000Z",
    ...extra,
  };
}

function withParts(
  id: string,
  role: NativeMessage["role"],
  parts: NativeMessagePart[],
  content = "",
): NativeMessage {
  return { id, role, content, parts, createdAt: "2026-07-27T12:00:00.000Z" };
}

/** Resolvers that accept everything, so a test isolates placement alone. */
const acceptAll = {
  resolvePromptBoundary: (m: NativeMessage): MessageForkBoundary => ({
    type: "message",
    messageId: m.id,
  }),
  resolveResponseBoundary: (m: NativeMessage): MessageForkBoundary => ({
    type: "message",
    messageId: m.id,
  }),
};

describe("message fork placement", () => {
  test("adds actions to every prompt and only the bottom of each response", () => {
    const messages = [
      message("user-1", "user"),
      message("assistant-1a", "assistant"),
      message("assistant-1b", "assistant"),
      message("user-2", "user"),
      message("assistant-2", "assistant"),
    ];

    expect(
      Array.from(buildMessageForkActionKinds(messages, false)),
    ).toEqual([
      ["user-1", "prompt"],
      ["assistant-1b", "response"],
      ["user-2", "prompt"],
      ["assistant-2", "response"],
    ]);
  });

  test("does not expose an unfinished response or client-only optimistic prompt", () => {
    const messages = [
      message("user-1", "user"),
      message("assistant-1", "assistant"),
      message("optimistic-user-2", "user"),
    ];

    expect(
      Array.from(buildMessageForkActionKinds(messages, true)),
    ).toEqual([["user-1", "prompt"]]);
  });

  test("exposes the trailing response once the turn has finished", () => {
    const messages = [
      message("user-1", "user"),
      message("assistant-1", "assistant"),
    ];

    expect(
      Array.from(buildMessageForkActionKinds(messages, false)),
    ).toEqual([
      ["user-1", "prompt"],
      ["assistant-1", "response"],
    ]);
  });

  test("places nothing on an empty or wholly client-only transcript", () => {
    expect(Array.from(buildMessageForkActionKinds([], false))).toEqual([]);
    expect(
      Array.from(
        buildMessageForkActionKinds(
          [
            message("system-local", "system"),
            message("optimistic-user-1", "user"),
          ],
          false,
        ),
      ),
    ).toEqual([]);
  });

  test("a system row between two assistant rows does not split one response", () => {
    const messages = [
      message("user-1", "user"),
      message("assistant-1a", "assistant"),
      message("system-local", "system"),
      message("assistant-1b", "assistant"),
    ];

    expect(
      Array.from(buildMessageForkActionKinds(messages, false)),
    ).toEqual([
      ["user-1", "prompt"],
      ["assistant-1b", "response"],
    ]);
  });
});

describe("message fork boundaries", () => {
  const messages = [
    message("user-1", "user"),
    message("assistant-1", "assistant"),
    message("system-local", "system"),
    message("user-2", "user", "Edit this prompt"),
    message("assistant-2", "assistant"),
  ];

  test("finds the persisted messages on either side of a selection", () => {
    expect(findPreviousForkMessage(messages, "user-2")?.id).toBe("assistant-1");
    expect(findNextForkMessage(messages, "assistant-1")?.id).toBe("user-2");
  });

  test("reports no neighbour at either end of the transcript", () => {
    expect(findPreviousForkMessage(messages, "user-1")).toBeUndefined();
    expect(findNextForkMessage(messages, "assistant-2")).toBeUndefined();
  });

  test("reports no neighbour for a message that is not in the transcript", () => {
    expect(findPreviousForkMessage(messages, "gone")).toBeUndefined();
    expect(findNextForkMessage(messages, "gone")).toBeUndefined();
  });

  test("honours a predicate that skips otherwise eligible candidates", () => {
    const turns = [
      message("user-1", "user", "user-1", { turnId: "turn-1" }),
      message("assistant-1", "assistant", "assistant-1", { turnId: "turn-1" }),
      message("user-2", "user", "user-2", { turnId: "turn-2" }),
      message("assistant-2", "assistant", "assistant-2", { turnId: "turn-2" }),
    ];

    // The Codex rule: the previous message belonging to a *different* turn.
    expect(
      findPreviousForkMessage(
        turns,
        "assistant-2",
        (candidate) => Boolean(candidate.turnId) && candidate.turnId !== "turn-2",
      )?.id,
    ).toBe("assistant-1");
  });

  test("extracts the selected prompt text for the new draft", () => {
    expect(getForkPromptText(messages[3]!)).toBe("Edit this prompt");
  });

  test("joins several text parts and falls back to content when there are none", () => {
    expect(
      getForkPromptText(
        withParts("user-1", "user", [
          { type: "text", content: "first" },
          { type: "file", content: "/tmp/a.png" },
          { type: "text", content: "second" },
        ]),
      ),
    ).toBe("first\n\nsecond");

    expect(
      getForkPromptText(
        withParts(
          "user-2",
          "user",
          [{ type: "file", content: "/tmp/a.png" }],
          "only content",
        ),
      ),
    ).toBe("only content");
  });
});

describe("fork attachment accounting", () => {
  test("counts only the file parts a restored draft cannot carry", () => {
    expect(
      countForkPromptAttachments(
        withParts("user-1", "user", [
          { type: "text", content: "look" },
          { type: "file", content: "/tmp/a.png" },
          { type: "file", content: "/tmp/b.png" },
        ]),
      ),
    ).toBe(2);
    expect(countForkPromptAttachments(message("user-2", "user"))).toBe(0);
  });

  test("phrases the notice per count and stays silent when nothing was lost", () => {
    expect(forkAttachmentNotice(0)).toBeUndefined();
    expect(forkAttachmentNotice(-1)).toBeUndefined();
    expect(forkAttachmentNotice(1)).toContain("1 attachment was not carried");
    expect(forkAttachmentNotice(3)).toContain("3 attachments were not carried");
  });
});

describe("message fork plan", () => {
  test("carries the draft and dropped-attachment count on prompts only", () => {
    const messages = [
      withParts(
        "user-1",
        "user",
        [
          { type: "text", content: "Add pagination" },
          { type: "file", content: "/tmp/mock.png" },
        ],
      ),
      message("assistant-1", "assistant", "Done"),
    ];

    const plan = buildMessageForkPlan(messages, {
      responseInProgress: false,
      ...acceptAll,
    });

    expect(plan.get("user-1")).toEqual({
      kind: "prompt",
      boundary: { type: "message", messageId: "user-1" },
      draftText: "Add pagination",
      droppedAttachmentCount: 1,
    });
    expect(plan.get("assistant-1")).toEqual({
      kind: "response",
      boundary: { type: "message", messageId: "assistant-1" },
      draftText: "",
      droppedAttachmentCount: 0,
    });
  });

  test("withdraws an action whose boundary the provider cannot resolve", () => {
    const messages = [
      message("user-1", "user"),
      message("assistant-1", "assistant"),
      message("user-2", "user"),
      message("assistant-2", "assistant"),
    ];

    const plan = buildMessageForkPlan(messages, {
      responseInProgress: false,
      resolvePromptBoundary: (m) => (
        m.id === "user-2" ? null : { type: "session-start" }
      ),
      resolveResponseBoundary: (m) => (
        m.id === "assistant-2"
          ? null
          : { type: "message", messageId: m.id }
      ),
    });

    expect(Array.from(plan.keys())).toEqual(["user-1", "assistant-1"]);
  });

  test("passes the whole transcript to a resolver that needs a neighbour", () => {
    const messages = [
      message("user-1", "user"),
      message("assistant-1", "assistant"),
      message("user-2", "user"),
      message("assistant-2", "assistant"),
    ];

    const plan = buildMessageForkPlan(messages, {
      responseInProgress: false,
      resolvePromptBoundary: (m, all) => {
        const previous = findPreviousForkMessage(all, m.id);
        return previous
          ? { type: "message", messageId: previous.id }
          : { type: "session-start" };
      },
      resolveResponseBoundary: (m, all) => {
        const next = findNextForkMessage(all, m.id);
        return next
          ? { type: "message", messageId: next.id }
          : { type: "whole-session" };
      },
    });

    expect(plan.get("user-1")?.boundary).toEqual({ type: "session-start" });
    expect(plan.get("user-2")?.boundary).toEqual({
      type: "message",
      messageId: "assistant-1",
    });
    expect(plan.get("assistant-1")?.boundary).toEqual({
      type: "message",
      messageId: "user-2",
    });
    expect(plan.get("assistant-2")?.boundary).toEqual({ type: "whole-session" });
  });

  test("plans nothing for a transcript with no forkable rows", () => {
    expect(
      buildMessageForkPlan([], { responseInProgress: false, ...acceptAll }).size,
    ).toBe(0);
    expect(
      buildMessageForkPlan(
        [message("user-1", "user"), message("assistant-1", "assistant")],
        { responseInProgress: true, ...acceptAll },
      ).size,
    ).toBe(1);
  });
});
