import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActionsPanel } from "./CoordinatorActionsPanel";
import {
  coordinatorActionCards,
  visibleCoordinatorCards,
  type CoordinatorActionCard,
} from "./coordinator-action-cards";
import type { NativeMessage } from "@/lib/chat/native-message-types";

let clocks: ReturnType<typeof installControlledTimeout>[] = [];
afterEach(() => {
  cleanup();
  for (const clock of clocks) clock.restore();
  clocks = [];
});
function clock(delay: number) {
  const value = installControlledTimeout(delay, { maxPending: 10 });
  clocks.push(value);
  return value;
}
const cards: CoordinatorActionCard[] = [
  { id: "t", anchorId: "u", index: 0, kind: "topic", title: "New subject", done: false },
  { id: "q", anchorId: "a", index: 1, kind: "question", title: "Which option?", done: false },
  { id: "p", anchorId: "n", index: 2, kind: "pr", title: "#42 Improve search", done: true },
];
test("wide panel shows cards, done state and navigates", () => {
  let anchor = "";
  render(
    <ActionsPanel
      docked
      cards={cards}
      onNavigate={(id) => {
        anchor = id;
      }}
    />,
  );
  const foldedIcon = screen.queryByRole("button", { name: /Actions,/ });
  expect(foldedIcon).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New subject" }));
  expect(anchor).toBe("u");
  expect(screen.getByRole("button", { name: /Done: #42/ })).toBeTruthy();
});
test("narrow hover, pointer travel grace, leave, focus and Escape", () => {
  const grace = clock(160);
  render(<ActionsPanel docked={false} cards={cards} onNavigate={() => {}} />);
  const icon = screen.getByRole("button", { name: "Actions, 1 waiting" });
  expect(icon.getAttribute("aria-expanded")).toBe("false");
  fireEvent.pointerEnter(icon, { pointerType: "mouse" });
  expect(icon.getAttribute("aria-expanded")).toBe("true");
  fireEvent.pointerLeave(icon);
  fireEvent.pointerEnter(screen.getByRole("region", { name: "Actions" }));
  act(() => {
    grace.advance();
  });
  expect(icon.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(icon.getAttribute("aria-expanded")).toBe("false");
  fireEvent.blur(icon);
  fireEvent.focus(icon);
  expect(icon.getAttribute("aria-expanded")).toBe("true");
  fireEvent.pointerLeave(icon);
  fireEvent.blur(icon);
  act(() => {
    grace.advance();
  });
  expect(icon.getAttribute("aria-expanded")).toBe("false");
});
test("touch click toggles", () => {
  render(<ActionsPanel docked={false} cards={[]} onNavigate={() => {}} />);
  const icon = screen.getByRole("button", { name: "Actions, 0 waiting" });
  fireEvent.pointerDown(icon, { pointerType: "touch" });
  fireEvent.click(icon);
  expect(icon.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(icon);
  expect(icon.getAttribute("aria-expanded")).toBe("false");
});
test("scroll cutoff precedes the ten-card limit", () => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    ...cards[0]!,
    id: String(index),
    index,
  }));
  expect(visibleCoordinatorCards(many, 12).map((c) => c.index)).toEqual([
    3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  ]);
  expect(visibleCoordinatorCards(many, 2).map((c) => c.index)).toEqual([0, 1, 2]);
});
const msg = (
  id: string,
  role: NativeMessage["role"],
  parts: NativeMessage["parts"] = [],
): NativeMessage => ({ id, role, content: "", parts, createdAt: "2026-11-09" });
test("marks replay with stable anchors, deduplicate topics and complete questions on a user answer", () => {
  const mark = (name: string, title: string): NativeMessage["parts"][number] => ({
    type: "tool-invocation",
    content: "",
    toolName: `mcp__orkestrator__${name}`,
    toolArgs: { title },
    toolState: "success",
  });
  const messages = [
    msg("u", "user"),
    msg("a", "assistant", [
      mark("mark_topic", "Search"),
      mark("mark_topic", "Duplicate"),
      mark("mark_question", "Which option?"),
    ]),
  ];
  expect(coordinatorActionCards(JSON.parse(JSON.stringify(messages)))).toMatchObject([
    { kind: "topic", anchorId: "u", done: false },
    { kind: "question", anchorId: "a", done: false },
  ]);
  expect(coordinatorActionCards([...messages, msg("u2", "user")])[1]?.done).toBe(true);
});
test("PR updates retain original position and mark merged done", () => {
  const notice = (id: string, state: string): NativeMessage => ({
    ...msg(id, "user"),
    peerMail: {
      messageId: id,
      kind: "notice",
      sender: "System",
      warning: "",
      body: "",
      notice: {
        resource: { kind: "pull-request", id: "env", label: "#42 Search" },
        state,
        tone: "attention",
      },
    },
  });
  expect(
    coordinatorActionCards([notice("n1", "pr-opened"), notice("n2", "pr-merged")]),
  ).toMatchObject([{ anchorId: "n1", index: 0, state: "merged", done: true }]);
});

test("scrolling hides later cards before retiring their animated rows", () => {
  const enter = clock(0);
  const retire = clock(160);
  const view = render(<ActionsPanel docked cards={cards} onNavigate={() => {}} />);
  view.rerender(<ActionsPanel docked cards={cards.slice(0, 1)} onNavigate={() => {}} />);
  act(() => {
    enter.advance();
  });
  const hiddenQuestion = screen.queryByRole("button", { name: "Which option?" });
  expect(hiddenQuestion).toBeNull();
  expect(view.container.querySelectorAll('li[aria-hidden="true"]').length).toBe(2);
  act(() => {
    retire.advance();
  });
  expect(view.container.querySelectorAll("li").length).toBe(1);
});

test("touch leave and focus before click preserve tap-to-open", () => {
  render(<ActionsPanel docked={false} cards={cards} onNavigate={() => {}} />);
  const icon = screen.getByRole("button", { name: "Actions, 1 waiting" });
  fireEvent.pointerDown(icon, { pointerType: "touch" });
  fireEvent.pointerLeave(icon, { pointerType: "touch" });
  fireEvent.focus(icon);
  fireEvent.click(icon);
  expect(icon.getAttribute("aria-expanded")).toBe("true");
});
test("OpenCode questions and assistant-only marks survive transcript replay", () => {
  const messages = [
    msg("a", "assistant", [
      {
        type: "tool-invocation",
        content: "",
        toolName: "question",
        toolUseId: "q",
        toolArgs: { questions: [{ question: "Choose?" }] },
        toolState: "pending",
      },
      {
        type: "tool-invocation",
        content: "",
        toolName: "mark_question",
        toolArgs: { title: "Approve?" },
        toolState: "success",
      },
    ]),
  ];
  expect(coordinatorActionCards(JSON.parse(JSON.stringify(messages)))).toMatchObject([
    { anchorId: "a", title: "Choose?", done: false },
    { anchorId: "a", title: "Approve?", done: false },
  ]);
  messages[0]!.parts[0]!.toolState = "success";
  expect(coordinatorActionCards(messages)[0]?.done).toBe(true);
});
test("workflow handoff uses URL and node identity and skips publication attempts", () => {
  const notice = (
    id: string,
    kind: "multi-review" | "pull-request",
    state: string,
  ): NativeMessage => ({
    ...msg(id, "user"),
    peerMail: {
      messageId: id,
      kind: "notice",
      sender: "System",
      warning: "",
      body: "- Pull request: https://github.com/org/repo/pull/42",
      notice: {
        resource: { kind, id, environmentId: "env", nodeId: "node" },
        state,
        tone: "attention",
      },
    },
  });
  expect(
    coordinatorActionCards([
      notice("start", "multi-review", "pr-started"),
      notice("failed", "multi-review", "pr-failed"),
    ]),
  ).toEqual([]);
  expect(
    coordinatorActionCards([
      notice("open", "multi-review", "pr-opened"),
      notice("merge", "pull-request", "pr-merged"),
    ]),
  ).toMatchObject([{ anchorId: "open", done: true, state: "merged" }]);
});

test("async answers and watched PR terminal state replay across serialization", () => {
  const question = msg("async", "assistant", [
    {
      type: "async-question",
      content: "",
      asyncQuestion: {
        itemId: "async-id",
        questions: [{ id: "choice", title: "Choose a database", options: ["SQLite"] }],
      },
    },
  ]);
  expect(coordinatorActionCards([question], new Set(["async-id"]))[0]).toMatchObject({
    title: "Choose a database",
    done: true,
    anchorId: "async",
  });
  const watched: NativeMessage = {
    ...msg("watch", "user"),
    peerMail: {
      messageId: "watch",
      kind: "notice",
      sender: "System",
      body: "",
      warning: "",
      notice: {
        resource: { kind: "watched-pull-request", id: "repo#42", nodeId: "remote" },
        state: "closed",
        tone: "info",
      },
    },
  };
  expect(coordinatorActionCards(JSON.parse(JSON.stringify([watched])))[0]).toMatchObject({
    anchorId: "watch",
    done: true,
    state: "closed",
  });
});

test("PR cards show number and title, refresh metadata, and retain it on terminal notices", () => {
  const notice = (id: string, state: string, title?: string): NativeMessage => ({
    ...msg(id, "user"),
    peerMail: {
      messageId: id,
      kind: "notice",
      sender: "System",
      warning: "",
      subject: "Multi Review worker completed",
      body: "Pull request: https://github.com/org/repo/pull/42",
      notice: {
        resource: { kind: "pull-request", id: "worker", nodeId: "remote" },
        state,
        tone: "attention",
        ...(title
          ? { pullRequest: { url: "https://github.com/org/repo/pull/42", number: 42, title } }
          : {}),
      },
    },
  });
  const opened = notice("open", "pr-opened");
  expect(coordinatorActionCards([opened])[0]?.title).toBe("#42");
  const updated = notice("checks", "pr-checks-failed", "Improve search");
  const renamed = notice("conflicts", "pr-conflicts", "Improve search and filters");
  const messages = [opened, updated, renamed, notice("merged", "pr-merged")];
  const result = coordinatorActionCards(JSON.parse(JSON.stringify(messages)));
  expect(result).toMatchObject([
    {
      title: "#42 Improve search and filters",
      anchorId: "open",
      index: 0,
      state: "merged",
      done: true,
    },
  ]);
  render(<ActionsPanel docked cards={result} onNavigate={() => {}} />);
  expect(screen.getByRole("button", { name: /#42 Improve search and filters/ })).toBeTruthy();
});
