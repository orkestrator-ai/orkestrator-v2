import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReviewValidationRun } from "@orkestrator/protocol/review-workflow";
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
  test("uses the live clock for the validation run and every running command", () => {
    const run = runningValidation();
    const view = render(
      <ReviewValidationStatus run={run} now={Date.parse("2026-09-08T20:00:10.000Z")} />,
    );

    expect(screen.getByText(/Validation: 10\.0s\./)).toBeTruthy();
    expect(screen.getByText("running · 5.0s")).toBeTruthy();

    view.rerender(
      <ReviewValidationStatus run={run} now={Date.parse("2026-09-08T20:00:13.000Z")} />,
    );
    expect(screen.getByText(/Validation: 13\.0s\./)).toBeTruthy();
    expect(screen.getByText("running · 8.0s")).toBeTruthy();
  });

  test("keeps per-command limitations attributed and plan limitations in Notes", () => {
    const run = runningValidation();
    run.results[0]!.limitation = "A prerequisite did not pass.";
    run.results[1]!.limitation = "A prerequisite did not pass.";
    render(<ReviewValidationStatus run={run} now={Date.parse("2026-09-08T20:00:10.000Z")} />);

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
});
