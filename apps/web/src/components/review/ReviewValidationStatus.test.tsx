import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ReviewValidationOutput,
  ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import { ReviewValidationStatus } from "./ReviewValidationStatus";

afterEach(cleanup);

function runningValidation(): ReviewValidationRun {
  return {
    id: "validation-1",
    status: "running",
    startedAt: "2026-09-08T20:00:00.000Z",
    discoveryDurationMs: 128_000,
    plan: {
      headRef: "a".repeat(40),
      commands: [
        {
          id: "check",
          command: "bun run check",
          cwd: ".",
          dependsOn: [],
          resources: ["next"],
          weight: 2,
          timeoutMs: 1_200_000,
        },
        {
          id: "build",
          command: "bun run build",
          cwd: ".",
          dependsOn: [],
          resources: ["next"],
          weight: 2,
          timeoutMs: 1_200_000,
        },
      ],
      limitations: ["No CI workflows are present."],
    },
    results: [
      {
        id: "check",
        command: "bun run check",
        status: "running",
        exitCode: null,
        stdoutPath: ".orkestrator/check.stdout",
        stderrPath: ".orkestrator/check.stderr",
        stdoutBytes: 0,
        stderrBytes: 0,
        startedAt: "2026-09-08T20:00:05.000Z",
        durationMs: 0,
        limitation: null,
      },
      {
        id: "build",
        command: "bun run build",
        status: "skipped",
        exitCode: null,
        stdoutPath: null,
        stderrPath: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        durationMs: 0,
        limitation: "Build runner was unavailable.",
      },
    ],
  };
}

describe("ReviewValidationStatus", () => {
  test("rehydrates a queued result and later incomplete evidence after an inactive view", () => {
    const run = runningValidation();
    Object.assign(run.results[0]!, {
      status: "queued",
      durationMs: 300,
      queuedMs: 12000,
      executionUpdatedAt: run.startedAt,
    });
    const view = render(<ReviewValidationStatus environmentId="env-1" run={run} />);
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.getByText("waiting for capacity · 0.3s · queued 12.0s")).toBeTruthy();
    view.unmount();
    // The authoritative worker advances while no view is subscribed.
    run.status = "completed";
    run.completedAt = "2026-09-08T20:00:20.000Z";
    Object.assign(run.results[0]!, {
      status: "incomplete",
      limitation: "Host capacity wait expired; validation is incomplete",
    });
    render(<ReviewValidationStatus environmentId="env-1" run={run} />);
    expect(screen.getByText("incomplete · 0.3s · queued 12.0s")).toBeTruthy();
    expect(screen.getByText("Host capacity wait expired; validation is incomplete")).toBeTruthy();
    expect(screen.queryByText("failed") === null).toBe(true);
  });

  test("uses the live clock for the validation run and every running command", () => {
    const run = runningValidation();
    const view = render(
      <ReviewValidationStatus
        environmentId="env-1"
        run={run}
        now={Date.parse("2026-09-08T20:00:10.000Z")}
      />,
    );

    expect(screen.getByText(/Validation: 10\.0s\./)).toBeTruthy();
    expect(screen.getByText("running · 5.0s")).toBeTruthy();

    view.rerender(
      <ReviewValidationStatus
        environmentId="env-1"
        run={run}
        now={Date.parse("2026-09-08T20:00:13.000Z")}
      />,
    );
    expect(screen.getByText(/Validation: 13\.0s\./)).toBeTruthy();
    expect(screen.getByText("running · 8.0s")).toBeTruthy();
  });

  test("keeps per-command limitations attributed and plan limitations in Notes", () => {
    const run = runningValidation();
    run.results[0]!.limitation = "A prerequisite did not pass.";
    run.results[1]!.limitation = "A prerequisite did not pass.";
    render(
      <ReviewValidationStatus
        environmentId="env-1"
        run={run}
        now={Date.parse("2026-09-08T20:00:10.000Z")}
      />,
    );

    expect(screen.getByText("bun run check").closest("li")?.textContent).toContain(
      "A prerequisite did not pass.",
    );
    expect(screen.getByText("bun run build").closest("li")?.textContent).toContain(
      "A prerequisite did not pass.",
    );
    expect(screen.getAllByText("A prerequisite did not pass.")).toHaveLength(2);
    const notes = screen.getByText("Notes").closest("details")!;
    expect(notes.hasAttribute("open")).toBe(false);
    expect(notes.querySelector(".text-amber-500") === null).toBe(true);
    fireEvent.click(screen.getByText("Notes"));
    expect(screen.getByText("No CI workflows are present.")).toBeTruthy();
  });

  test("opens a modal and loads the selected command's captured output", async () => {
    const run = runningValidation();
    const loadOutput = mock(async () => ({
      resultId: "check",
      status: "passed" as const,
      stdout: {
        contentBase64: btoa("1 pass\n"),
        totalBytes: 7,
        startOffset: 0,
      },
      stderr: {
        contentBase64: btoa("warning\n"),
        totalBytes: 8,
        startOffset: 0,
      },
    }));
    run.results[0]!.status = "passed";
    run.results[0]!.exitCode = 0;

    render(<ReviewValidationStatus environmentId="env-1" run={run} loadOutput={loadOutput} />);
    fireEvent.click(screen.getByRole("button", { name: "View terminal output for bun run check" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Terminal output")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/1 pass/)).toBeTruthy());
    expect(screen.getByText(/warning/)).toBeTruthy();
    expect(loadOutput).toHaveBeenCalledWith("env-1", "validation-1", "check");
  });

  test("waits for a slow running read to settle before scheduling the next poll", async () => {
    const run = runningValidation();
    let resolveFirst!: (output: ReviewValidationOutput) => void;
    const first = new Promise<ReviewValidationOutput>((resolve) => {
      resolveFirst = resolve;
    });
    const loadOutput = mock(() => first);
    const output: ReviewValidationOutput = {
      resultId: "check",
      status: "running",
      stdout: {
        contentBase64: btoa("still running\n"),
        totalBytes: 14,
        startOffset: 0,
      },
      stderr: null,
    };

    jest.useFakeTimers();
    try {
      render(<ReviewValidationStatus environmentId="env-1" run={run} loadOutput={loadOutput} />);
      fireEvent.click(
        screen.getByRole("button", { name: "View terminal output for bun run check" }),
      );
      await act(async () => Promise.resolve());

      expect(loadOutput).toHaveBeenCalledTimes(1);
      act(() => jest.advanceTimersByTime(10_000));
      expect(loadOutput).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveFirst(output);
        await first;
        await Promise.resolve();
      });
      expect(screen.getByText(/still running/)).toBeTruthy();

      act(() => jest.advanceTimersByTime(1_999));
      expect(loadOutput).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(loadOutput).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("opens skipped steps without trying to read a missing artifact", () => {
    const run = runningValidation();
    const loadOutput = mock(async () => {
      throw new Error("should not load");
    });
    render(<ReviewValidationStatus environmentId="env-1" run={run} loadOutput={loadOutput} />);

    fireEvent.click(screen.getByRole("button", { name: "View terminal output for bun run build" }));

    expect(screen.getByText("This step was skipped, so it has no terminal output.")).toBeTruthy();
    expect(loadOutput).not.toHaveBeenCalled();
  });
});
