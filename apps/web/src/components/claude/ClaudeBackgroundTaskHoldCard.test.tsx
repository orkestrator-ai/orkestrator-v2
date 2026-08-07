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
      <ClaudeBackgroundTaskHoldCard
        tasks={tasks}
        responseInProgress={false}
        onStopTask={async () => true}
      />,
    );

    expect(screen.getByText("Response ready · 2 background tasks still running")).toBeTruthy();
    expect(screen.getByText(
      "The response is complete and Claude is preserving these tasks across turns. Stop only tasks that no longer need to run.",
    )).toBeTruthy();
    expect(
      screen.getByRole("group", {
        name: "Claude background tasks continuing after the response",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Wait for final review agent")).toBeTruthy();
    expect(screen.getByText("Run the test suite")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop Wait for final review agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop Run the test suite" })).toBeTruthy();
  });

  test("uses singular task wording without changing its live-region announcement", () => {
    const { rerender } = render(
      <ClaudeBackgroundTaskHoldCard
        tasks={[tasks[0]!]}
        responseInProgress={false}
        onStopTask={async () => true}
      />,
    );

    expect(screen.getByText("Response ready · 1 background task still running")).toBeTruthy();
    const announcement = screen.getByRole("status");
    expect(announcement.textContent).toBe(
      "Claude's response is ready, but background tasks are still running.",
    );

    rerender(
      <ClaudeBackgroundTaskHoldCard
        tasks={tasks}
        responseInProgress={false}
        onStopTask={async () => true}
      />,
    );
    expect(screen.getByText("Response ready · 2 background tasks still running")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(announcement.textContent);
  });

  test("uses neutral status copy while Claude is still responding", () => {
    render(
      <ClaudeBackgroundTaskHoldCard
        tasks={[tasks[0]!]}
        responseInProgress
        onStopTask={async () => true}
      />,
    );

    expect(screen.getByText("Response in progress · 1 background task running")).toBeTruthy();
    expect(screen.getByText(
      "Claude is still responding while these tasks run. Stop only tasks that no longer need to run.",
    )).toBeTruthy();
    expect(screen.queryByText(/The response is complete/)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Claude is still responding while background tasks are running.",
    );
    expect(
      screen.getByRole("group", {
        name: "Claude background tasks running during the response",
      }),
    ).toBeTruthy();
  });

  test("does not claim completion when the response ended with an error", () => {
    render(
      <ClaudeBackgroundTaskHoldCard
        tasks={[tasks[0]!]}
        responseInProgress={false}
        responseFailed
        onStopTask={async () => true}
      />,
    );

    expect(screen.getByText("Response ended · 1 background task still running")).toBeTruthy();
    expect(screen.getByText(
      "Claude's response ended with an error while these tasks continue. Stop only tasks that no longer need to run.",
    )).toBeTruthy();
    expect(screen.queryByText(/The response is complete/)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Claude's response ended with an error, but background tasks are still running.",
    );
    expect(
      screen.getByRole("group", {
        name: "Claude background tasks continuing after a response error",
      }),
    ).toBeTruthy();
  });

  // A new turn clears the previous turn's error, so the two flags overlap only
  // in the window before that lands. Describing the live turn is the honest
  // read there: the error the user is being shown belongs to a finished turn.
  test("describes the live turn when a stale error overlaps a new response", () => {
    render(
      <ClaudeBackgroundTaskHoldCard
        tasks={[tasks[0]!]}
        responseInProgress
        responseFailed
        onStopTask={async () => true}
      />,
    );

    expect(screen.getByText("Response in progress · 1 background task running")).toBeTruthy();
    expect(screen.queryByText(/Response ended/)).toBeNull();
    expect(screen.queryByText(/ended with an error/)).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Claude is still responding while background tasks are running.",
    );
    expect(
      screen.getByRole("group", {
        name: "Claude background tasks running during the response",
      }),
    ).toBeTruthy();
  });

  test("disables one task while its stop request is pending", async () => {
    let resolveStop: ((value: boolean) => void) | undefined;
    const onStopTask = mock(
      () => new Promise<boolean>((resolve) => { resolveStop = resolve; }),
    );
    const { rerender } = render(
      <ClaudeBackgroundTaskHoldCard
        tasks={[tasks[0]!]}
        responseInProgress={false}
        onStopTask={onStopTask}
      />,
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

    rerender(
      <ClaudeBackgroundTaskHoldCard
        tasks={[]}
        responseInProgress={false}
        onStopTask={onStopTask}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop Wait for final review agent" }))
        .toBeNull();
    });
    rerender(
      <ClaudeBackgroundTaskHoldCard
        tasks={[tasks[0]!]}
        responseInProgress={false}
        onStopTask={onStopTask}
      />,
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
      <ClaudeBackgroundTaskHoldCard
        tasks={[tasks[0]!]}
        responseInProgress={false}
        onStopTask={onStopTask}
      />,
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
      <ClaudeBackgroundTaskHoldCard
        tasks={[tasks[0]!]}
        responseInProgress={false}
        onStopTask={onStopTask}
      />,
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
      <ClaudeBackgroundTaskHoldCard
        tasks={tasks}
        responseInProgress={false}
        onStopTask={onStopTask}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Stop Wait for final review agent" }),
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    rerender(
      <ClaudeBackgroundTaskHoldCard
        tasks={[tasks[1]!]}
        responseInProgress={false}
        onStopTask={onStopTask}
      />,
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
      <ClaudeBackgroundTaskHoldCard
        tasks={[tasks[0]!]}
        responseInProgress={false}
        onStopTask={onStopTask}
      />,
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
      <ClaudeBackgroundTaskHoldCard
        tasks={tasks}
        responseInProgress={false}
        onStopTask={onStopTask}
      />,
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
      <ClaudeBackgroundTaskHoldCard
        tasks={[tasks[1]!]}
        responseInProgress={false}
        onStopTask={onStopTask}
      />,
    );
    rerender(
      <ClaudeBackgroundTaskHoldCard
        tasks={tasks}
        responseInProgress={false}
        onStopTask={onStopTask}
      />,
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
        responseInProgress={false}
        onStopTask={async () => true}
      />,
    );

    expect(screen.getByText("Background task task-without-label")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Stop Background task task-without-label" }),
    ).toBeTruthy();
  });
});
