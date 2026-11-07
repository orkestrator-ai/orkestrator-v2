import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import * as backend from "@/lib/backend";
import * as markdown from "./AgentMailMarkdown";
import { Sheet } from "@/components/ui/sheet";
import type { AgentMailConversation } from "@orkestrator/protocol/agent-mail";
const backendSnapshot = { ...backend };
const markdownSnapshot = { ...markdown };
const thread: AgentMailConversation = {
  revision: 1,
  key: "pair",
  total: 1,
  participants: [
    { key: "user", kind: "user", displayName: "You", agent: null, canReceive: false },
    { key: "env\0tab", kind: "agent", displayName: "Agent", agent: "codex", canReceive: false },
  ],
  messages: [
    {
      version: 1,
      threadId: "thread",
      requestId: "request",
      toIncarnationId: "incarnation",
      bodyBytes: 12,
      injectDepth: 0,
      threadDepth: 0,
      revision: 1,
      id: "latest",
      from: { kind: "user" },
      body: "Tall message",
      createdAt: new Date(0).toISOString(),
      toEnvironmentId: "env",
      toTabId: "tab",
      trust: "user",
      placement: "stored",
      userSeenAt: "seen",
    },
  ],
};
mock.module("@/lib/backend", () => ({
  ...backendSnapshot,
  getAgentMailConversation: async () => thread,
}));
// A deferred Markdown commit: the button completes the renderer after its height changes.
mock.module("./AgentMailMarkdown", () => ({
  AgentMailMarkdown: ({ onRendered }: { onRendered?: () => void }) => (
    <button onClick={onRendered}>Finish rendering</button>
  ),
}));
const { AgentMailConversationView } = await import("./AgentMailConversationView");
afterAll(() => {
  mock.module("@/lib/backend", () => backendSnapshot);
  mock.module("./AgentMailMarkdown", () => markdownSnapshot);
});
afterEach(cleanup);
test("follows delayed Markdown height while at bottom and respects scrolling away", async () => {
  const { container } = renderInAppCommandScope(
    <Sheet>
      <AgentMailConversationView a="user" b="env\0tab" onBack={() => {}} />
    </Sheet>,
  );
  const finish = await screen.findByRole("button", { name: "Finish rendering" });
  const scroller = container.querySelector(".overflow-y-auto") as HTMLDivElement;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1400 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
  fireEvent.click(finish);
  expect(scroller.scrollTop).toBe(1400);
  scroller.scrollTop = 100;
  fireEvent.scroll(scroller);
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1800 });
  fireEvent.click(finish);
  expect(scroller.scrollTop).toBe(100);
});
