import { describe, expect, test } from "bun:test";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  buildMessageRewindPlan,
  describeNativeAgentRewind,
  resolveNativeAgentRewindTarget,
} from "./native-agent-rewind";

function message(
  id: string,
  role: NativeMessage["role"],
  extra: Partial<NativeMessage> = {},
): NativeMessage {
  const content = extra.content ?? id;
  return {
    id,
    role,
    content,
    parts: extra.parts ?? [{ type: "text", content }],
    createdAt: "2026-11-09T12:00:00.000Z",
    ...extra,
  };
}

/** Three completed turns, Codex-shaped (every row carries its turn id). */
function conversation(): NativeMessage[] {
  return [
    message("p1", "user", { turnId: "t1", content: "first" }),
    message("r1", "assistant", { turnId: "t1" }),
    message("p2", "user", { turnId: "t2", content: "second" }),
    message("r2", "assistant", { turnId: "t2" }),
    message("p3", "user", { turnId: "t3", content: "third" }),
    message("r3", "assistant", { turnId: "t3" }),
  ];
}

describe("message rewind plan", () => {
  test.each(["codex", "pi", "cursor"] as const)(
    "%s offers rewind on every prompt and never on a response",
    (platform) => {
      const plan = buildMessageRewindPlan(conversation(), {
        platform,
        responseInProgress: false,
      });
      expect([...plan.keys()]).toEqual(["p1", "p2", "p3"]);
      expect(plan.get("p2")).toEqual({
        messageId: "p2",
        droppedTurns: 2,
        draftText: "second",
        draftAnnotations: [],
        droppedAttachmentCount: 0,
      });
      expect(plan.get("p1")!.droppedTurns).toBe(3);
      expect(plan.get("p3")!.droppedTurns).toBe(1);
    },
  );

  test("platforms without message rewind get no plan", () => {
    for (const platform of ["claude", "opencode", "grok"] as const) {
      expect(
        buildMessageRewindPlan(conversation(), { platform, responseInProgress: false }).size,
      ).toBe(0);
    }
  });

  test("Codex withdraws a prompt with no turn id: its bridge would refuse it", () => {
    const rows = conversation();
    rows[2] = message("p2", "user", { content: "second" });
    expect(resolveNativeAgentRewindTarget("codex", rows[2]!)).toBeNull();
    expect(resolveNativeAgentRewindTarget("pi", rows[2]!)).toBe("p2");
    const plan = buildMessageRewindPlan(rows, { platform: "codex", responseInProgress: false });
    expect([...plan.keys()]).toEqual(["p1", "p3"]);
  });

  test("optimistic prompts are neither offered nor counted as dropped turns", () => {
    const rows = [
      ...conversation(),
      message("optimistic-user-1", "user", { content: "not sent yet" }),
    ];
    const plan = buildMessageRewindPlan(rows, { platform: "pi", responseInProgress: false });
    expect(plan.has("optimistic-user-1")).toBe(false);
    expect(plan.get("p3")!.droppedTurns).toBe(1);
  });

  test("attachments the restored draft cannot carry are counted", () => {
    const rows = conversation();
    rows[4] = message("p3", "user", {
      turnId: "t3",
      content: "third",
      parts: [
        { type: "text", content: "third" },
        { type: "file", content: "a.png", filename: "a.png" } as never,
      ],
    });
    const plan = buildMessageRewindPlan(rows, { platform: "cursor", responseInProgress: false });
    expect(plan.get("p3")).toMatchObject({ draftText: "third", droppedAttachmentCount: 1 });
  });
});

describe("rewind confirmation copy", () => {
  test("names the turns dropped and says Pi keeps them as a branch", () => {
    const copy = describeNativeAgentRewind("pi", "Pi", { droppedTurns: 3 });
    expect(copy.title).toBe("Rewind Pi to before this prompt?");
    expect(copy.description[0]).toContain("3 turns");
    expect(copy.description[1]).toContain("another branch");
  });

  test("says Codex and Cursor cannot bring the turns back", () => {
    for (const [platform, label] of [
      ["codex", "Codex"],
      ["cursor", "Cursor"],
    ] as const) {
      const copy = describeNativeAgentRewind(platform, label, { droppedTurns: 1 });
      expect(copy.description[0]).toBe(
        `This removes this prompt and ${label}'s response from the conversation.`,
      );
      expect(copy.description[1]).toContain("cannot undo this");
    }
  });
});
