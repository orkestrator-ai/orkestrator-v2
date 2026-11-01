import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderGoalCarrier, type NativeAgentGoal } from "@orkestrator/protocol/native-agent-goal";
import { createGoalTurnNativeMessage, goalStatusRows } from "@/lib/chat/goal-messages";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { ChatFindActiveContext } from "./chat-find-context";
import { GoalDetailLoaderContext } from "./goal-detail-context";
import { NativeMessage } from "./NativeMessage";

const AT = "2026-10-31T10:00:00.000Z";

function goal(overrides: Partial<NativeAgentGoal> = {}): NativeAgentGoal {
  return {
    goalId: "goal-1",
    objective: "Make the build **green**",
    status: "active",
    providerSessionId: "provider-1",
    iterations: 2,
    maxIterations: 20,
    noProgressStreak: 0,
    setAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function providerRow(content: string): NativeMessageType {
  return {
    id: "provider-row",
    role: "user",
    content,
    parts: [{ type: "text", content }],
    createdAt: AT,
  };
}

function tile(carrier: string) {
  return render(<NativeMessage message={createGoalTurnNativeMessage(providerRow(carrier))!} />);
}

afterEach(() => {
  cleanup();
  useMessagePartExpansionStore.getState().reset();
});

describe("GoalTurnTile", () => {
  test("is a collapsed tile with its iteration and objective, never a user bubble", () => {
    const { container } = tile(renderGoalCarrier(goal()));
    const row = container.querySelector<HTMLElement>("[data-goal-turn-tile]")!;
    expect(row.dataset.expanded).toBe("false");
    expect(row.textContent).toContain("Goal turn 3 of 20");
    expect(row.textContent).toContain("Make the build **green**");
    expect(screen.queryByText("You") === null).toBe(true);
    expect(container.textContent).not.toContain("orkestrator-goal");
    // Nothing a user bubble offers: no copy, no resend.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  test("opens to the objective as plain text and the check", () => {
    const { container } = tile(renderGoalCarrier(goal({ check: "bun test" })));
    fireEvent.click(screen.getByRole("button", { name: /Goal turn 3 of 20/ }));
    expect(container.querySelector<HTMLElement>("[data-goal-turn-tile]")!.dataset.expanded).toBe(
      "true",
    );
    const body = container.querySelector("[data-agent-chat-search-content]")!;
    expect(body.textContent).toBe("Make the build **green**");
    expect(body.querySelector("strong") === null).toBe(true);
    expect(screen.getByText("bun test")).toBeTruthy();
  });

  test("a turn answering a failed check flags it and shows the output as text", () => {
    const { container } = tile(
      renderGoalCarrier(
        goal({
          check: "bun test",
          lastCheck: {
            passed: false,
            exitCode: 2,
            durationMs: 3,
            outputTail: "<img src=x> 1 failing",
            at: AT,
          },
        }),
      ),
    );
    expect(screen.getByText("Check failed, exit 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Goal turn 3 of 20/ }));
    expect(screen.getByText("<img src=x> 1 failing")).toBeTruthy();
    expect(container.querySelector("img") === null).toBe(true);
  });

  test("opens by itself for transcript find", () => {
    const row = createGoalTurnNativeMessage(providerRow(renderGoalCarrier(goal())))!;
    const { container } = render(
      <ChatFindActiveContext.Provider value={true}>
        <NativeMessage message={row} />
      </ChatFindActiveContext.Provider>,
    );
    expect(container.querySelector("[data-agent-chat-search-content]")!.textContent).toBe(
      "Make the build **green**",
    );
  });

  test("a carrier that cannot be read is still a tile, with no raw text", () => {
    const { container } = tile('<orkestrator-goal version="1">\ntruncat');
    expect(container.querySelector("[data-goal-turn-tile]")!.textContent).toContain("Goal turn");
    expect(container.textContent).not.toContain("orkestrator-goal");
    expect(container.textContent).not.toContain("truncat");
  });
});

test("carrier-like text in the middle of a message renders as the user's message", () => {
  const content = `Why does ${renderGoalCarrier(goal())} show up?`;
  const row = createGoalTurnNativeMessage(providerRow(content)) ?? providerRow(content);
  const { container } = render(<NativeMessage message={row} />);
  expect(container.querySelector("[data-goal-turn-tile]") === null).toBe(true);
  expect(screen.getByText("You")).toBeTruthy();
  expect(container.textContent).toContain("Why does");
});

describe("GoalStatusRow", () => {
  const checkAt = "2026-10-31T10:05:00.000Z";
  const withCheck = {
    ...goal(),
    check: "bun test",
    lastCheck: { passed: false, exitCode: 1, durationMs: 4, at: checkAt },
  };
  const { lastCheck: _omit, ...view } = goal();
  const row = (kind: string, source = { ...view } as Parameters<typeof goalStatusRows>[0]) =>
    goalStatusRows(source).find((candidate) => candidate.goalStatus?.kind === kind)!;

  test("set, stopped and ended rows are one quiet line", () => {
    for (const [kind, source, text] of [
      ["set", view, "will end as unverified"],
      [
        "stopped",
        { ...view, status: "paused", statusReason: "user-stopped" },
        "you stopped the turn",
      ],
      ["ended", { ...view, status: "complete", endedAt: AT }, "Complete: the check passed"],
    ] as const) {
      const { container, unmount } = render(
        <NativeMessage message={row(kind, source as Parameters<typeof goalStatusRows>[0])} />,
      );
      const rendered = container.querySelector<HTMLElement>(`[data-goal-status-row="${kind}"]`)!;
      expect(rendered.textContent).toContain(text);
      expect(screen.queryByRole("button") === null).toBe(true);
      unmount();
    }
  });

  test("a check row reads its output only when opened", async () => {
    const load = mock(async () => ({
      goal: { lastCheck: { outputTail: "1 failing", at: checkAt } },
      history: [],
    }));
    render(
      <GoalDetailLoaderContext.Provider value={load as never}>
        <NativeMessage message={row("check", withCheck)} />
      </GoalDetailLoaderContext.Provider>,
    );
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Check failed with exit code 1/ }));
    expect(await screen.findByText("1 failing")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("an older run's row says its output is gone rather than showing a newer one", async () => {
    const load = mock(async () => ({
      goal: { lastCheck: { outputTail: "newer", at: "2026-10-31T12:00:00.000Z" } },
      history: [],
    }));
    const { container } = render(
      <GoalDetailLoaderContext.Provider value={load as never}>
        <NativeMessage message={row("check", withCheck)} />
      </GoalDetailLoaderContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Check failed/ }));
    await waitFor(() =>
      expect(
        container.querySelector("[data-goal-check-output]")!.getAttribute("data-goal-check-output"),
      ).toBe("gone"),
    );
    expect(container.textContent).not.toContain("newer");
  });

  test("a failed read says so", async () => {
    const load = mock(async () => {
      throw new Error("offline");
    });
    render(
      <GoalDetailLoaderContext.Provider value={load as never}>
        <NativeMessage message={row("check", withCheck)} />
      </GoalDetailLoaderContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Check failed/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
  });
});
