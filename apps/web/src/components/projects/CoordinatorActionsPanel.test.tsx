import { afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActionsPanel } from "./CoordinatorActionsPanel";
import {
  coordinatorActionCards,
  visibleCoordinatorCards,
  type CoordinatorActionCard,
} from "./coordinator-action-cards";
import type { NativeMessage } from "@/lib/chat/native-message-types";

afterEach(cleanup);
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
test("narrow hover, pointer travel grace, leave, focus and Escape", async () => {
  render(<ActionsPanel docked={false} cards={cards} onNavigate={() => {}} />);
  const icon = screen.getByRole("button", { name: "Actions, 1 waiting" });
  expect(icon.getAttribute("aria-expanded")).toBe("false");
  fireEvent.pointerEnter(icon, { pointerType: "mouse" });
  expect(icon.getAttribute("aria-expanded")).toBe("true");
  fireEvent.pointerLeave(icon);
  fireEvent.pointerEnter(screen.getByRole("region", { name: "Actions" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
  expect(icon.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(icon.getAttribute("aria-expanded")).toBe("false");
  fireEvent.pointerLeave(icon);
  fireEvent.focus(icon);
  expect(icon.getAttribute("aria-expanded")).toBe("true");
  fireEvent.blur(icon);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 180));
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

test("scrolling hides later cards before retiring their animated rows", async () => {
  const view = render(<ActionsPanel docked cards={cards} onNavigate={() => {}} />);
  view.rerender(<ActionsPanel docked cards={cards.slice(0, 1)} onNavigate={() => {}} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const hiddenQuestion = screen.queryByRole("button", { name: "Which option?" });
  expect(hiddenQuestion).toBeNull();
  expect(view.container.querySelectorAll('li[aria-hidden="true"]').length).toBe(2);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 180));
  });
  expect(view.container.querySelectorAll("li").length).toBe(1);
});
