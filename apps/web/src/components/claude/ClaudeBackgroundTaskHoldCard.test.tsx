import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ClaudeBackgroundTask } from "@/lib/claude-client";
import { ClaudeBackgroundTaskHoldCard } from "./ClaudeBackgroundTaskHoldCard";

afterEach(cleanup);

const tasks: ClaudeBackgroundTask[] = [
  { id: "wait-loop", description: "Wait for final review agent", status: "running" },
  { id: "build", description: "Run the test suite", status: "paused" },
];

describe("ClaudeBackgroundTaskHoldCard", () => {
  test("explains the hold and offers a targeted stop for every live task", () => {
    render(
      <ClaudeBackgroundTaskHoldCard tasks={tasks} onStopTask={async () => true} />,
    );

    expect(screen.getByText("Response ready · 2 background tasks still running")).toBeTruthy();
    expect(screen.getByText("Wait for final review agent")).toBeTruthy();
    expect(screen.getByText("Run the test suite")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop Wait for final review agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop Run the test suite" })).toBeTruthy();
  });

  test("disables one task while its stop request is pending", async () => {
    let resolveStop: ((value: boolean) => void) | undefined;
    const onStopTask = mock(
      () => new Promise<boolean>((resolve) => { resolveStop = resolve; }),
    );
    const { rerender } = render(
      <ClaudeBackgroundTaskHoldCard tasks={[tasks[0]!]} onStopTask={onStopTask} />,
    );

    const button = screen.getByRole("button", { name: "Stop Wait for final review agent" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onStopTask).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Stopping")).toBeTruthy();

    resolveStop?.(true);
    await waitFor(() => expect(onStopTask).toHaveBeenCalledTimes(1));

    rerender(<ClaudeBackgroundTaskHoldCard tasks={[]} onStopTask={onStopTask} />);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop Wait for final review agent" }))
        .toBeNull();
    });
    rerender(
      <ClaudeBackgroundTaskHoldCard tasks={[tasks[0]!]} onStopTask={onStopTask} />,
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Stop Wait for final review agent" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
  });

  test("makes a failed targeted stop retryable", async () => {
    const onStopTask = mock(async () => false);
    render(
      <ClaudeBackgroundTaskHoldCard tasks={[tasks[0]!]} onStopTask={onStopTask} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Stop Wait for final review agent" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Could not stop “Wait for final review agent”",
      );
    });
    expect(
      screen.getByRole("button", { name: "Stop Wait for final review agent" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  test("makes a rejected targeted stop retryable", async () => {
    const onStopTask = mock(async () => {
      throw new Error("bridge disconnected");
    });
    render(
      <ClaudeBackgroundTaskHoldCard tasks={[tasks[0]!]} onStopTask={onStopTask} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Stop Wait for final review agent" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Could not stop “Wait for final review agent”",
      );
    });
    expect(
      screen.getByRole("button", { name: "Stop Wait for final review agent" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  test("uses a stable fallback label when a task description is blank", () => {
    render(
      <ClaudeBackgroundTaskHoldCard
        tasks={[{ id: "task-without-label", description: "   ", status: "running" }]}
        onStopTask={async () => true}
      />,
    );

    expect(screen.getByText("Background task task-without-label")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Stop Background task task-without-label" }),
    ).toBeTruthy();
  });
});
