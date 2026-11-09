import { expect, test } from "bun:test";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { recoverActionHistory } from "./coordinator-action-history";
import { coordinatorActionCards } from "./coordinator-action-cards";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
const message = (id: string): NativeMessage => ({
  id,
  role: "assistant",
  createdAt: "2026-11-09",
  content: "prose",
  parts: [],
});
const question = {
  ...message("old-question"),
  parts: [
    {
      type: "tool-invocation" as const,
      content: "",
      toolName: "orkestrator_mark_question",
      toolState: "success" as const,
      toolArgs: { title: "Old question" },
    },
  ],
};
test("independent clients recover outstanding evidence beyond a 512-row tail and replay live revisions", async () => {
  const tail = Array.from({ length: 512 }, (_, i) => message(`tail-${i}`));
  const pr: NativeMessage = {
    ...message("old-pr"),
    peerMail: {
      messageId: "mail",
      kind: "notice",
      sender: "System",
      warning: "",
      body: "",
      notice: {
        resource: { kind: "pull-request", id: "pr" },
        state: "pr-opened",
        tone: "attention",
      },
    },
  };
  for (let client = 0; client < 2; client++) {
    const cursors: string[] = [];
    const history = await recoverActionHistory(tail, "page", "epoch", async (cursor) => {
      cursors.push(cursor);
      return {
        syncVersion: 1,
        messages: [question, pr],
        historyEpoch: "epoch",
        complete: true,
        truncated: false,
      };
    });
    expect(cursors).toEqual(["page"]);
    const cards = coordinatorActionCards(history);
    expect(cards.map((card) => card.anchorId)).toEqual(["old-question", "old-pr"]);
    expect(cards.every((card) => !card.done)).toBe(true);
    expect(history[2]!.content).toBe("");
    expect(
      coordinatorActionCards([
        ...history,
        {
          ...pr,
          id: "gone",
          peerMail: { ...pr.peerMail!, notice: { ...pr.peerMail!.notice!, state: "pr-gone" } },
        },
      ]).find((card) => card.kind === "pr"),
    ).toMatchObject({ anchorId: "old-pr", state: "gone", done: true });
  }
});
test("incomplete, changed and cyclic history refuses partial results", async () => {
  for (const page of [
    { historyEpoch: "other", complete: true },
    { historyEpoch: "epoch", complete: false },
    { historyEpoch: "epoch", complete: false, nextCursor: "page" },
  ]) {
    await expect(
      recoverActionHistory([], "page", "epoch", async () => ({
        syncVersion: 1,
        messages: [],
        truncated: false,
        ...page,
      })),
    ).rejects.toThrow();
  }
});
export const blockingQuestion: AgentInteractionRequest = {
  version: 1,
  id: "request-1",
  provider: "codex",
  kind: "question",
  origin: "interactive-native",
  sessionId: "session",
  state: "pending",
  revision: 1,
  createdAt: Date.parse("2026-11-09"),
  updatedAt: Date.parse("2026-11-09"),
  presentation: { title: "Blocking question", questions: [] },
};
test("live blocking interaction has one stable card before and after resolution and tool replay", () => {
  const rows = [message("assistant")];
  const waiting = coordinatorActionCards(rows, new Set(), [blockingQuestion]);
  expect(waiting).toMatchObject([{ id: "request-1", anchorId: "assistant", done: false }]);
  const resolved = { ...blockingQuestion, state: "resolved" as const };
  expect(coordinatorActionCards(rows, new Set(), [resolved])).toMatchObject([
    { id: "request-1", anchorId: "assistant", done: true },
  ]);
  rows[0]!.parts = [
    {
      type: "tool-invocation",
      content: "",
      toolName: "request_user_input",
      toolUseId: "request-1",
      toolState: "success",
    },
  ];
  expect(coordinatorActionCards(rows, new Set(), [resolved])).toHaveLength(1);
});

test("historical provider mail carriers become PR evidence before prose is stripped", async () => {
  const { renderAgentMailCarrier } = await import("@orkestrator/protocol/agent-mail");
  const content = renderAgentMailCarrier({
    version: 1,
    id: "pr-mail",
    threadId: "thread",
    requestId: "request",
    createdAt: "2026-11-09",
    from: { kind: "system", projectId: "p", source: "workflow", resourceId: "pr" },
    toEnvironmentId: "environment",
    toTabId: "tab",
    toIncarnationId: "i",
    body: "Pull request: https://github.com/org/repo/pull/42",
    bodyBytes: 54,
    trust: "same-project",
    injectDepth: 0,
    threadDepth: 0,
    placement: "injected",
    revision: 1,
    notice: { resource: { kind: "pull-request", id: "pr" }, state: "pr-opened", tone: "attention" },
  });
  const history = await recoverActionHistory([], "page", "epoch", async () => ({
    syncVersion: 1,
    messages: [
      { ...message("carrier"), role: "user", content, parts: [{ type: "text", content }] },
    ],
    historyEpoch: "epoch",
    complete: true,
    truncated: false,
  }));
  expect(coordinatorActionCards(history)).toMatchObject([
    { kind: "pr", title: "#42", done: false },
  ]);
});
