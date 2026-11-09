import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActionsPanel, fitNewestCards } from "./CoordinatorActionsPanel";
import {
  setCoordinatorActionsDockedOpen,
  COORDINATOR_ACTIONS_DOCKED_KEY,
} from "./coordinator-actions-preference";
import {
  coordinatorActionCards,
  visibleCoordinatorCards,
  type CoordinatorActionCard,
} from "./coordinator-action-cards";
import type { NativeMessage } from "@/lib/chat/native-message-types";

let clocks: ReturnType<typeof installControlledTimeout>[] = [];
afterEach(() => {
  cleanup();
  localStorage.removeItem(COORDINATOR_ACTIONS_DOCKED_KEY);
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

test("provider-qualified marks accept OpenCode but reject foreign servers", () => {
  for (const name of [
    "mark_question",
    "orkestrator_mark_question",
    "orkestrator/mark_question",
    "mcp__orkestrator__mark_question",
  ]) {
    expect(
      coordinatorActionCards([
        msg("a", "assistant", [
          {
            type: "tool-invocation",
            content: "",
            toolName: name,
            toolArgs: { title: "Choose" },
            toolState: "success",
          },
        ]),
      ]),
    ).toHaveLength(1);
  }
  for (const name of [
    "mcp__foreign__mark_question",
    "foreign/mark_question",
    "foreign_mark_question",
  ]) {
    expect(
      coordinatorActionCards([
        msg("a", "assistant", [
          {
            type: "tool-invocation",
            content: "",
            toolName: name,
            toolArgs: { title: "Choose" },
            toolState: "success",
          },
        ]),
      ]),
    ).toHaveLength(0);
  }
});

const header = () => screen.getByRole("button", { name: "Collapse actions", hidden: true });
const region = () => document.querySelector<HTMLElement>('section[aria-label="Actions"]')!;

test("wide header folds the docked panel to its icon and the icon reopens it", () => {
  render(<ActionsPanel docked cards={cards} onNavigate={() => {}} />);
  expect(header().getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(header());
  const icon = screen.getByRole("button", { name: "Actions, 1 waiting" });
  expect(icon.getAttribute("aria-expanded")).toBe("false");
  expect(region().getAttribute("aria-hidden")).toBe("true");
  expect(document.activeElement).toBe(icon);
  expect(localStorage.getItem(COORDINATOR_ACTIONS_DOCKED_KEY)).toBe("collapsed");
  // Hover and focus never open a folded docked panel.
  fireEvent.pointerEnter(icon, { pointerType: "mouse" });
  fireEvent.focus(icon);
  expect(icon.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(icon);
  expect(screen.queryByRole("button", { name: /Actions,/ }) === null).toBe(true);
  expect(region().getAttribute("aria-hidden")).toBe("false");
  expect(document.activeElement).toBe(header());
  expect(localStorage.getItem(COORDINATOR_ACTIONS_DOCKED_KEY)).toBeNull();
});

test("wide panel stays open through outside clicks, leave, blur, Escape and card clicks", () => {
  const grace = clock(160);
  let anchor = "";
  render(
    <>
      <button type="button">Elsewhere</button>
      <ActionsPanel
        docked
        cards={cards}
        onNavigate={(id) => {
          anchor = id;
        }}
      />
    </>,
  );
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  fireEvent.pointerEnter(region(), { pointerType: "mouse" });
  fireEvent.pointerLeave(region(), { pointerType: "mouse" });
  fireEvent.focus(header());
  fireEvent.blur(header(), { relatedTarget: elsewhere });
  fireEvent.keyDown(header(), { key: "Escape" });
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.pointerDown(elsewhere);
  fireEvent.click(elsewhere);
  act(() => {
    grace.advance();
  });
  fireEvent.click(screen.getByRole("button", { name: "Which option?" }));
  expect(anchor).toBe("a");
  expect(header().getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByRole("button", { name: /Actions,/ }) === null).toBe(true);
});

test("the docked choice persists and follows other windows", () => {
  localStorage.setItem(COORDINATOR_ACTIONS_DOCKED_KEY, "collapsed");
  render(<ActionsPanel docked cards={cards} onNavigate={() => {}} />);
  expect(
    screen.getByRole("button", { name: "Actions, 1 waiting" }).getAttribute("aria-expanded"),
  ).toBe("false");
  localStorage.removeItem(COORDINATOR_ACTIONS_DOCKED_KEY);
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: COORDINATOR_ACTIONS_DOCKED_KEY }));
  });
  expect(screen.queryByRole("button", { name: /Actions,/ }) === null).toBe(true);
  expect(header().getAttribute("aria-expanded")).toBe("true");
});

test("narrow overlay folds on an outside click or tap and from its header", () => {
  render(
    <>
      <button type="button">Elsewhere</button>
      <ActionsPanel docked={false} cards={cards} onNavigate={() => {}} />
    </>,
  );
  const icon = screen.getByRole("button", { name: "Actions, 1 waiting" });
  fireEvent.pointerEnter(icon, { pointerType: "mouse" });
  expect(icon.getAttribute("aria-expanded")).toBe("true");
  fireEvent.pointerDown(region());
  fireEvent.pointerDown(icon);
  expect(icon.getAttribute("aria-expanded")).toBe("true");
  fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }), {
    pointerType: "touch",
  });
  expect(icon.getAttribute("aria-expanded")).toBe("false");
  fireEvent.focus(icon);
  expect(icon.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(header());
  expect(icon.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(icon);
  // Still inside: the header's fold holds until pointer and focus leave.
  fireEvent.focus(icon);
  expect(icon.getAttribute("aria-expanded")).toBe("false");
  expect(localStorage.getItem(COORDINATOR_ACTIONS_DOCKED_KEY)).toBeNull();
});

test("resizing across the breakpoint keeps each mode's own state", () => {
  const view = render(<ActionsPanel docked cards={cards} onNavigate={() => {}} />);
  fireEvent.click(header());
  view.rerender(<ActionsPanel docked={false} cards={cards} onNavigate={() => {}} />);
  const icon = screen.getByRole("button", { name: "Actions, 1 waiting" });
  expect(icon.getAttribute("aria-expanded")).toBe("false");
  fireEvent.pointerEnter(icon, { pointerType: "mouse" });
  expect(icon.getAttribute("aria-expanded")).toBe("true");
  // The narrow overlay's open state is not carried to the wide pane.
  view.rerender(<ActionsPanel docked cards={cards} onNavigate={() => {}} />);
  expect(
    screen.getByRole("button", { name: "Actions, 1 waiting" }).getAttribute("aria-expanded"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Actions, 1 waiting" }));
  view.rerender(<ActionsPanel docked={false} cards={cards} onNavigate={() => {}} />);
  expect(
    screen.getByRole("button", { name: "Actions, 1 waiting" }).getAttribute("aria-expanded"),
  ).toBe("false");
  view.rerender(<ActionsPanel docked cards={cards} onNavigate={() => {}} />);
  expect(header().getAttribute("aria-expanded")).toBe("true");
});

test("fitting keeps the newest whole cards", () => {
  expect(fitNewestCards([40, 40, 40], 4, 200)).toBe(3);
  expect(fitNewestCards([40, 40, 40], 4, 84)).toBe(2);
  expect(fitNewestCards([40, 40, 40], 4, 83)).toBe(1);
  expect(fitNewestCards([10, 10, 60], 4, 50)).toBe(0);
});

test("a short pane hides the oldest cards instead of scrolling and keeps the waiting count", () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.tagName === "LI" ? 40 : this.tagName === "H2" ? 20 : 0;
    },
  });
  try {
    const view = render(
      <div data-floating-notice-stack="">
        <ActionsPanel docked cards={cards} onNavigate={() => {}} availableHeight={110} />
      </div>,
    );
    expect(screen.queryByRole("button", { name: "New subject" }) === null).toBe(true);
    expect(screen.getByRole("button", { name: "Which option?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Done: #42/ })).toBeTruthy();
    expect(screen.getByText("1 waiting")).toBeTruthy();
    expect(view.container.querySelector(".overflow-y-auto") === null).toBe(true);
    view.rerender(
      <div data-floating-notice-stack="">
        <ActionsPanel docked cards={cards} onNavigate={() => {}} availableHeight={300} />
      </div>,
    );
    expect(screen.getByRole("button", { name: "New subject" })).toBeTruthy();
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
  }
});

test("wide round trips clear narrow pointer state and pending grace", () => {
  const grace = clock(160);
  const view = render(<ActionsPanel docked={false} cards={cards} onNavigate={() => {}} />);
  const icon = screen.getByRole("button", { name: /Actions,/ });
  fireEvent.pointerEnter(icon, { pointerType: "mouse" });
  fireEvent.blur(icon);
  view.rerender(<ActionsPanel docked cards={cards} onNavigate={() => {}} />);
  fireEvent.pointerLeave(region(), { pointerType: "mouse" });
  view.rerender(<ActionsPanel docked={false} cards={cards} onNavigate={() => {}} />);
  const returnedIcon = screen.getByRole("button", { name: /Actions,/ });
  fireEvent.focus(returnedIcon);
  expect(region().getAttribute("aria-hidden")).toBe("false");
  fireEvent.blur(returnedIcon);
  act(() => grace.advance());
  expect(region().getAttribute("aria-hidden")).toBe("true");
});

for (const dismiss of ["header", "Escape"]) {
  test(`wide round trips clear narrow ${dismiss} suppression`, () => {
    const view = render(<ActionsPanel docked={false} cards={cards} onNavigate={() => {}} />);
    fireEvent.focus(screen.getByRole("button", { name: /Actions,/ }));
    if (dismiss === "header") fireEvent.click(header());
    else fireEvent.keyDown(region(), { key: "Escape" });
    view.rerender(<ActionsPanel docked cards={cards} onNavigate={() => {}} />);
    view.rerender(<ActionsPanel docked={false} cards={cards} onNavigate={() => {}} />);
    fireEvent.focus(screen.getByRole("button", { name: /Actions,/ }));
    expect(region().getAttribute("aria-hidden")).toBe("false");
  });
}

for (const cause of ["storage", "resize"]) {
  test(`${cause} collapse moves focus out of hidden cards`, () => {
    const view = render(
      <ActionsPanel docked={cause === "storage"} cards={cards} onNavigate={() => {}} />,
    );
    if (cause === "resize") {
      localStorage.setItem(COORDINATOR_ACTIONS_DOCKED_KEY, "collapsed");
      fireEvent.focus(screen.getByRole("button", { name: /Actions,/ }));
    }
    act(() => screen.getByRole("button", { name: "Which option?" }).focus());
    if (cause === "storage") {
      localStorage.setItem(COORDINATOR_ACTIONS_DOCKED_KEY, "collapsed");
      act(() =>
        window.dispatchEvent(new StorageEvent("storage", { key: COORDINATOR_ACTIONS_DOCKED_KEY })),
      );
    } else view.rerender(<ActionsPanel docked cards={cards} onNavigate={() => {}} />);
    expect(region().getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement === screen.getByRole("button", { name: /Actions,/ })).toBe(true);
  });
}

test("unavailable storage defaults open and failed writes retain the local choice", () => {
  const read = spyOn(localStorage, "getItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  const write = spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  const remove = spyOn(localStorage, "removeItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  try {
    render(<ActionsPanel docked cards={cards} onNavigate={() => {}} />);
    expect(region().getAttribute("aria-hidden")).toBe("false");
    fireEvent.click(header());
    expect(region().getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Actions,/ }));
    expect(region().getAttribute("aria-hidden")).toBe("false");
  } finally {
    read.mockRestore();
    write.mockRestore();
    remove.mockRestore();
    act(() => setCoordinatorActionsDockedOpen(true));
  }
});

test("notice insertion, resizing and removal re-fit cards and preserve tiny-pane header", async () => {
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const top = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
  const rect = HTMLElement.prototype.getBoundingClientRect;
  const originalResize = globalThis.ResizeObserver;
  let offset = 0;
  let resized = () => {};
  const observed = new Set<Element>();
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resized = callback;
    }
    observe(element: Element) {
      observed.add(element);
    }
    unobserve(element: Element) {
      observed.delete(element);
    }
    disconnect() {
      observed.clear();
    }
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.tagName === "LI" ? 40 : this.tagName === "H2" ? 20 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get() {
      return offset;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { ...rect.call(this), top: this.hasAttribute("data-actions-panel-box") ? offset : 0 };
  };
  try {
    const view = render(
      <div data-floating-notice-stack="">
        <ActionsPanel docked cards={cards} onNavigate={() => {}} availableHeight={150} />
      </div>,
    );
    const stack = view.container.firstElementChild!;
    const notice = document.createElement("div");
    expect(screen.queryByRole("button", { name: "New subject" }) !== null).toBe(true);
    await act(async () => {
      offset = 50;
      stack.prepend(notice);
      await Promise.resolve();
    });
    expect(observed.has(notice)).toBe(true);
    expect(screen.queryByRole("button", { name: "New subject" }) === null).toBe(true);
    act(() => {
      offset = 145;
      resized();
    });
    expect(screen.queryByRole("button", { name: "Which option?" }) === null).toBe(true);
    const box = view.container.querySelector<HTMLElement>("[data-actions-panel-box]")!;
    expect(parseFloat(box.style.maxHeight)).toBeGreaterThanOrEqual(20);
    expect(header().getAttribute("tabindex")).toBe("0");
    await act(async () => {
      offset = 0;
      notice.remove();
      await Promise.resolve();
    });
    expect(observed.has(notice)).toBe(false);
    expect(screen.queryByRole("button", { name: "New subject" }) !== null).toBe(true);
  } finally {
    cleanup();
    if (height) Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
    if (top) Object.defineProperty(HTMLElement.prototype, "offsetTop", top);
    HTMLElement.prototype.getBoundingClientRect = rect;
    globalThis.ResizeObserver = originalResize;
  }
});
