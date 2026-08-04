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

  test("uses singular task wording without changing its live-region announcement", () => {
    const { rerender } = render(
      <ClaudeBackgroundTaskHoldCard tasks={[tasks[0]!]} onStopTask={async () => true} />,
    );

    expect(screen.getByText("Response ready · 1 background task still running")).toBeTruthy();
    const announcement = screen.getByRole("status");
    expect(announcement.textContent).toBe(
      "Claude's response is ready, but background tasks are still running.",
    );

    rerender(
      <ClaudeBackgroundTaskHoldCard tasks={tasks} onStopTask={async () => true} />,
    );
    expect(screen.getByText("Response ready · 2 background tasks still running")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(announcement.textContent);
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
    await waitFor(() => {
      expect(onStopTask).toHaveBeenCalledTimes(1);
      expect(button.hasAttribute("disabled")).toBe(true);
    });

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

  test("clears a failed stop error when that task leaves the authoritative list", async () => {
    const onStopTask = mock(async () => false);
    const { rerender } = render(
      <ClaudeBackgroundTaskHoldCard tasks={tasks} onStopTask={onStopTask} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Stop Wait for final review agent" }),
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    rerender(
      <ClaudeBackgroundTaskHoldCard tasks={[tasks[1]!]} onStopTask={onStopTask} />,
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  test("clears the previous error as soon as another stop attempt starts", async () => {
    let resolveRetry: ((value: boolean) => void) | undefined;
    let attempt = 0;
    const onStopTask = mock(() => {
      attempt += 1;
      if (attempt === 1) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => { resolveRetry = resolve; });
    });
    render(
      <ClaudeBackgroundTaskHoldCard tasks={[tasks[0]!]} onStopTask={onStopTask} />,
    );

    const button = screen.getByRole("button", { name: "Stop Wait for final review agent" });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    fireEvent.click(button);
    await waitFor(() => {
      expect(onStopTask).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(button.hasAttribute("disabled")).toBe(true);
    });

    resolveRetry?.(true);
  });

  test("tracks concurrent stops independently and prunes only tasks that disappear", async () => {
    const resolvers = new Map<string, (value: boolean) => void>();
    const onStopTask = mock(
      (taskId: string) => new Promise<boolean>((resolve) => {
        resolvers.set(taskId, resolve);
      }),
    );
    const { rerender } = render(
      <ClaudeBackgroundTaskHoldCard tasks={tasks} onStopTask={onStopTask} />,
    );

    const waitButton = screen.getByRole("button", {
      name: "Stop Wait for final review agent",
    });
    const buildButton = screen.getByRole("button", { name: "Stop Run the test suite" });
    fireEvent.click(waitButton);
    fireEvent.click(buildButton);

    await waitFor(() => {
      expect(onStopTask).toHaveBeenCalledTimes(2);
      expect(waitButton.hasAttribute("disabled")).toBe(true);
      expect(buildButton.hasAttribute("disabled")).toBe(true);
    });

    rerender(
      <ClaudeBackgroundTaskHoldCard tasks={[tasks[1]!]} onStopTask={onStopTask} />,
    );
    rerender(
      <ClaudeBackgroundTaskHoldCard tasks={tasks} onStopTask={onStopTask} />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Stop Wait for final review agent" })
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(
        screen.getByRole("button", { name: "Stop Run the test suite" })
          .hasAttribute("disabled"),
      ).toBe(true);
    });

    resolvers.get("wait-loop")?.(true);
    resolvers.get("build")?.(true);
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
