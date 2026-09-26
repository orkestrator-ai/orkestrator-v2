import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ReviewValidationOutput,
  ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";
import {
  ReviewValidationStatus,
  VALIDATION_OUTPUT_POLL_INTERVAL_MS,
} from "./ReviewValidationStatus";

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
});

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
  test("renders the stop control and disables it while stopping", () => {
    const run = runningValidation();
    const onStop = mock(() => undefined);
    const view = render(<ReviewValidationStatus environmentId="env-1" run={run} onStop={onStop} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop tests and continue" }));
    expect(onStop).toHaveBeenCalledTimes(1);

    view.rerender(
      <ReviewValidationStatus environmentId="env-1" run={run} onStop={onStop} stopping />,
    );
    expect(screen.getByText("Stopping")).toBeTruthy();
    const stopping = screen.getByRole("button", { name: "Stopping tests…" });
    expect((stopping as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(stopping);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("does not render the stop control for a settled run", () => {
    const run = runningValidation();
    run.status = "cancelled";
    run.completedAt = "2026-09-08T20:00:10.000Z";
    render(
      <ReviewValidationStatus
        environmentId="env-1"
        run={run}
        onStop={mock(() => undefined)}
        stopping
      />,
    );

    expect(screen.queryByRole("button", { name: "Stopping tests…" }) === null).toBe(true);
  });

  test("rehydrates a queued result and later incomplete evidence after an inactive view", () => {
    const run = runningValidation();
    Object.assign(run.results[0]!, {
      status: "queued",
      durationMs: 300,
      queuedMs: 12000,
      queueReason: "Waiting for worker slots; 6/8 slots reserved; needs 4 slots.",
      executionUpdatedAt: run.startedAt,
    });
    const view = render(<ReviewValidationStatus environmentId="env-1" run={run} />);
    expect(screen.getAllByText("Queued")).toHaveLength(2);
    const queuedRow = screen
      .getByRole("button", {
        name: "View terminal output for bun run check",
      })
      .closest("tr")!;
    expect(queuedRow.textContent).toContain("waiting for capacity");
    expect(queuedRow.textContent).toContain("6/8 slots reserved");
    expect(queuedRow.querySelector("[data-slot='validation-elapsed']")?.textContent).toBe("0.3s");
    expect(queuedRow.querySelector("[data-slot='validation-queued']")?.textContent).toBe("12.0s");
    expect(queuedRow.textContent).not.toContain("queued");
    view.unmount();
    // The authoritative worker advances while no view is subscribed.
    run.status = "completed";
    run.completedAt = "2026-09-08T20:00:20.000Z";
    Object.assign(run.results[0]!, {
      status: "incomplete",
      limitation: "Host capacity wait expired; validation is incomplete",
    });
    render(<ReviewValidationStatus environmentId="env-1" run={run} />);
    const incompleteRow = screen
      .getByRole("button", {
        name: "View terminal output for bun run check",
      })
      .closest("tr")!;
    expect(incompleteRow.textContent).toContain("incomplete");
    expect(incompleteRow.textContent).not.toContain("6/8 slots reserved");
    expect(incompleteRow.querySelector("[data-slot='validation-elapsed']")?.textContent).toBe(
      "0.3s",
    );
    expect(incompleteRow.querySelector("[data-slot='validation-queued']")?.textContent).toBe(
      "12.0s",
    );
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
    const runningRow = () =>
      screen.getByRole("button", { name: "View terminal output for bun run check" }).closest("tr")!;
    expect(runningRow().textContent).toContain("running");
    expect(runningRow().querySelector("[data-slot='validation-elapsed']")?.textContent).toBe(
      "5.0s",
    );

    view.rerender(
      <ReviewValidationStatus
        environmentId="env-1"
        run={run}
        now={Date.parse("2026-09-08T20:00:13.000Z")}
      />,
    );
    expect(screen.getByText(/Validation: 13\.0s\./)).toBeTruthy();
    expect(runningRow().textContent).toContain("running");
    expect(runningRow().querySelector("[data-slot='validation-elapsed']")?.textContent).toBe(
      "8.0s",
    );
  });

  test("keeps run and queue times in shared columns when some rows omit them", () => {
    const run = runningValidation();
    Object.assign(run.results[0]!, {
      status: "passed",
      exitCode: 0,
      durationMs: 46_200,
      queuedMs: 1_200,
    });
    Object.assign(run.results[1]!, {
      status: "passed",
      exitCode: 0,
      durationMs: 2_300,
      limitation: null,
    });
    render(<ReviewValidationStatus environmentId="env-1" run={run} />);

    expect(screen.getByRole("table", { name: "Validation commands" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Command",
      "Status",
      "Duration",
      "Queued",
      "Output",
    ]);
    const check = screen
      .getByRole("button", { name: "View terminal output for bun run check" })
      .closest("tr")!;
    const build = screen
      .getByRole("button", { name: "View terminal output for bun run build" })
      .closest("tr")!;
    expect(check.querySelector("[data-slot='validation-elapsed']")?.textContent).toBe("46.2s");
    expect(check.querySelector("[data-slot='validation-queued']")?.textContent).toBe("1.2s");
    expect(build.querySelector("[data-slot='validation-elapsed']")?.textContent).toBe("2.3s");
    expect(build.querySelector("[data-slot='validation-queued']")?.textContent).toBe("");
    expect(build.textContent?.includes("queued")).toBe(false);
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

    const checkRow = screen.getByText("bun run check").closest("tr")!;
    const buildRow = screen.getByText("bun run build").closest("tr")!;
    expect(checkRow.textContent).toContain("A prerequisite did not pass.");
    expect(buildRow.textContent).toContain("A prerequisite did not pass.");
    for (const [row, command] of [
      [checkRow, "bun run check"],
      [buildRow, "bun run build"],
    ] as const) {
      const limitation = row.querySelector("[data-slot='validation-limitation']");
      expect(limitation?.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["mt-1", "break-words"]),
      );
      expect(limitation?.parentElement).toBe(row.cells[0]);
      expect(limitation?.parentElement?.querySelector("code")?.textContent).toBe(command);
    }
    expect(screen.getAllByText("A prerequisite did not pass.")).toHaveLength(2);
    const notes = screen.getByText("Notes").closest("details")!;
    expect(notes.hasAttribute("open")).toBe(false);
    expect(notes.querySelector(".text-amber-500") === null).toBe(true);
    fireEvent.click(screen.getByText("Notes"));
    expect(screen.getByText("No CI workflows are present.")).toBeTruthy();
  });

  test("opens terminal output from the row body", () => {
    const run = runningValidation();
    render(<ReviewValidationStatus environmentId="env-1" run={run} />);

    fireEvent.click(screen.getByText("bun run check"));

    expect(screen.getByRole("dialog", { name: "Terminal output" })).toBeTruthy();
  });

  test("makes every output row focusable and activatable with Enter or Space", () => {
    const run = runningValidation();
    render(<ReviewValidationStatus environmentId="env-1" run={run} />);

    const checkRow = screen.getByRole("button", {
      name: "View terminal output for bun run check",
    });
    const buildRow = screen.getByRole("button", {
      name: "View terminal output for bun run build",
    });
    expect(checkRow.tagName).toBe("TR");
    expect(checkRow.tabIndex).toBe(0);

    fireEvent.keyDown(checkRow, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Terminal output" })).toBeTruthy();
    expect(
      screen.getByText("bun run check", { selector: "[data-slot='dialog-description']" }),
    ).toBeTruthy();

    expect(fireEvent.keyDown(buildRow, { key: " " })).toBe(false);
    expect(screen.getByText("This step was skipped, so it has no terminal output.")).toBeTruthy();
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
    const header = screen.getByRole("dialog").querySelector("[data-slot='dialog-header']");
    expect(header?.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "m-0",
        "sm:m-0",
        "px-14",
        "sm:px-14",
        "text-center",
        "sm:text-center",
      ]),
    );
    expect(screen.getByText("Terminal output").className).toContain("justify-center");
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

    const { clock } = installFakeReadCoordinator();
    render(<ReviewValidationStatus environmentId="env-1" run={run} loadOutput={loadOutput} />);
    fireEvent.click(screen.getByRole("button", { name: "View terminal output for bun run check" }));
    await act(async () => Promise.resolve());

    expect(loadOutput).toHaveBeenCalledTimes(1);
    await act(async () => {
      await clock.advance(10_000);
    });
    expect(loadOutput).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(output);
      await first;
      await Promise.resolve();
    });
    expect(screen.getByText(/still running/)).toBeTruthy();

    await act(async () => {
      await clock.advance(VALIDATION_OUTPUT_POLL_INTERVAL_MS);
    });
    expect(loadOutput).toHaveBeenCalledTimes(2);
  });

  test("streams appended output by offset, recovers a rotated log, and settles on completion", async () => {
    const { clock, document: fakeDocument } = installFakeReadCoordinator();
    const run = runningValidation();
    const anchor = (value: string) => value.padEnd(32, "0");
    const answers: ReviewValidationOutput[] = [
      {
        resultId: "check",
        status: "running",
        stdout: {
          contentBase64: btoa("one\n"),
          totalBytes: 4,
          startOffset: 0,
          anchor: anchor("a"),
          mode: "tail",
        },
        stderr: null,
      },
      {
        resultId: "check",
        status: "running",
        stdout: {
          contentBase64: btoa("two\n"),
          totalBytes: 8,
          startOffset: 4,
          anchor: anchor("b"),
          mode: "append",
        },
        stderr: null,
      },
      {
        resultId: "check",
        status: "running",
        stdout: {
          contentBase64: "",
          totalBytes: 8,
          startOffset: 8,
          anchor: anchor("b"),
          mode: "append",
        },
        stderr: null,
      },
      // Rotated: the backend no longer recognises the held tail.
      {
        resultId: "check",
        status: "running",
        stdout: {
          contentBase64: btoa("fresh\n"),
          totalBytes: 6,
          startOffset: 0,
          anchor: anchor("c"),
          mode: "tail",
        },
        stderr: null,
      },
    ];
    const known: unknown[] = [];
    const loadOutput = mock(
      async (_env: string, _run: string, _result: string, knownPosition?: unknown) => {
        known.push(knownPosition);
        return answers.shift() ?? answers.at(-1)!;
      },
    );
    render(<ReviewValidationStatus environmentId="env-1" run={run} loadOutput={loadOutput} />);
    fireEvent.click(screen.getByRole("button", { name: "View terminal output for bun run check" }));
    await waitFor(() => expect(screen.getByText(/one/)).toBeTruthy());
    expect(known[0]).toBeUndefined();

    await act(async () => {
      await clock.advance(VALIDATION_OUTPUT_POLL_INTERVAL_MS);
    });
    await waitFor(() => expect(screen.getByText(/one\s+two/)).toBeTruthy());
    expect(known[1]).toEqual({ stdout: { totalBytes: 4, anchor: anchor("a") } });
    const shown = screen.getByText(/one\s+two/);

    // Nothing new: no re-render of the text node.
    await act(async () => {
      await clock.advance(VALIDATION_OUTPUT_POLL_INTERVAL_MS);
    });
    expect(known[2]).toEqual({ stdout: { totalBytes: 8, anchor: anchor("b") } });
    expect(screen.getByText(/one\s+two/)).toBe(shown);

    // Hidden: no reads. Visible again: one reconcile read, which rotates.
    act(() => fakeDocument.setVisibility("hidden"));
    await act(async () => {
      await clock.advance(VALIDATION_OUTPUT_POLL_INTERVAL_MS * 5);
    });
    expect(loadOutput).toHaveBeenCalledTimes(3);
    act(() => fakeDocument.setVisibility("visible"));
    await act(async () => {
      await clock.advance(1_000);
    });
    expect(loadOutput).toHaveBeenCalledTimes(4);
    await waitFor(() => expect(screen.getByText(/fresh/)).toBeTruthy());
    expect(screen.queryByText(/two/)).toBeNull();
  });

  test("shows a clickable environment state changed note with the drifted files", () => {
    const run = runningValidation();
    run.environmentChanges = ["playwright-report/index.html", "test-results/.last-run.json"];
    render(
      <ReviewValidationStatus
        environmentId="env-1"
        run={run}
        now={Date.parse("2026-09-08T20:00:10.000Z")}
      />,
    );

    const note = screen.getByText("environment state changed").closest("details")!;
    expect(note.hasAttribute("open")).toBe(false);
    expect(screen.queryByText("Repository changed") === null).toBe(true);
    fireEvent.click(screen.getByText("environment state changed"));
    expect(note.hasAttribute("open")).toBe(true);
    expect(screen.getByText("playwright-report/index.html")).toBeTruthy();
    expect(screen.getByText("test-results/.last-run.json")).toBeTruthy();
    expect(screen.getByLabelText("Files changed since the snapshot")).toBeTruthy();
  });

  test("hides the environment state note when no files drifted", () => {
    const run = runningValidation();
    render(
      <ReviewValidationStatus
        environmentId="env-1"
        run={run}
        now={Date.parse("2026-09-08T20:00:10.000Z")}
      />,
    );
    expect(screen.queryByText("environment state changed") === null).toBe(true);
  });

  test("hides the environment state note when environmentChanges is an empty array", () => {
    const run = runningValidation();
    run.environmentChanges = [];
    render(
      <ReviewValidationStatus
        environmentId="env-1"
        run={run}
        now={Date.parse("2026-09-08T20:00:10.000Z")}
      />,
    );
    expect(screen.queryByText("environment state changed") === null).toBe(true);
  });

  test("shows how many drifted files were omitted from the note", () => {
    const run = runningValidation();
    run.environmentChanges = ["alpha.txt"];
    run.environmentChangesOmitted = 3;
    render(
      <ReviewValidationStatus
        environmentId="env-1"
        run={run}
        now={Date.parse("2026-09-08T20:00:10.000Z")}
      />,
    );
    fireEvent.click(screen.getByText("environment state changed"));
    expect(screen.getByText("alpha.txt")).toBeTruthy();
    expect(screen.getByText("and 3 more")).toBeTruthy();
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
