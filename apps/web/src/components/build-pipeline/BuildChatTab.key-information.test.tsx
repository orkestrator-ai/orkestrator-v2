import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { BuildPipelineKeyInformation } from "@orkestrator/protocol/build-pipeline-key-information";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import {
  pipeline,
  renderTab,
  restoreBuildChatTabMocks,
  reviewed,
} from "./build-chat-tab-test-support";

/**
 * The build tab header: the pipeline's progress under the title, then the row
 * of equal icon buttons holding the Key information panel and the graph toggle.
 */

afterAll(restoreBuildChatTabMocks);

const keyInformation: BuildPipelineKeyInformation = {
  framing: "objective",
  statement: "Show the pipeline's status at a glance.",
  context: "The build tab only showed a temporary banner.",
  solution: "A key information panel in the header.",
  workDone: ["Added the panel", "Added the agent tools"],
  decisions: [
    {
      decision: "Where to store the brief",
      options: [
        {
          option: "On the pipeline record",
          pros: ["One source of truth"],
          cons: ["Bigger record"],
        },
        { option: "In a separate file", pros: ["Small record"], cons: ["Second store"] },
      ],
      chosen: "On the pipeline record",
      rationale: "Every client already syncs the record.",
    },
  ],
  notDone: ["Rich text formatting"],
  tests: [
    { name: "bun test key-information", result: "passed" },
    { name: "mise run test:browser", result: "not-run", details: "Not needed here." },
  ],
  issues: [
    {
      round: 0,
      issue: "Missing bound on decisions",
      severity: "P1",
      resolution: "Bounded to twelve decisions.",
      status: "resolved",
    },
  ],
  verifications: [
    {
      round: 0,
      passed: false,
      summary: "One criterion failed.",
      checks: [
        { check: "Header shows the timer", passed: true },
        { check: "Panel lists decisions", passed: false, details: "Pros were missing." },
      ],
    },
  ],
  updatedAt: "2026-11-01T10:00:00.000Z",
  updates: [
    {
      at: "2026-11-01T10:00:00.000Z",
      author: "verify",
      round: 0,
      sections: ["verification"],
    },
  ],
};

function header(): HTMLElement {
  return screen.getByTestId("build-pipeline-header");
}

function openPanel(): HTMLElement {
  fireEvent.click(within(header()).getByRole("button", { name: /Key information/ }));
  return screen.getByRole("dialog", { name: "Key information" });
}

describe("BuildChatTab header", () => {
  beforeEach(() => {
    cleanup();
  });

  test("puts the pipeline's progress after the phase and agent under the title", () => {
    renderTab(reviewed);

    const summary = within(header()).getByTestId("build-pipeline-header-summary");
    const progress = within(summary).getByTestId("pipeline-progress");
    expect(progress.textContent).toMatch(/^\d+ of \d+ steps · /);
    expect(progress.closest("div")?.textContent).toMatch(/Codex·\d+ of \d+ steps/);
  });

  test("lays the header's actions out as one row of equal icon buttons", () => {
    renderTab({ ...pipeline, phase: "building", backendRevision: 95 });

    const buttons = within(
      within(header()).getByTestId("build-pipeline-header-actions"),
    ).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Restart Build Stage",
      "Pause",
      "Cancel",
      "Key information",
      "Pipeline",
    ]);
    for (const button of buttons) {
      expect(button.getAttribute("data-size")).toBe("icon");
      expect(button.textContent?.trim()).toBe("");
    }
  });

  test("the header's Pipeline toggle still collapses the graph", () => {
    renderTab(reviewed);
    const toggle = within(header()).getByRole("button", { name: "Pipeline" });
    const graphId = toggle.getAttribute("aria-controls")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(graphId)?.hidden).toBe(true);
    fireEvent.click(toggle);
  });

  test("shows no review banner above the graph", () => {
    renderTab(reviewed);
    expect(screen.queryByRole("button", { name: /The review reported/ }) === null).toBe(true);
    expect(screen.queryByText(/to read the report/) === null).toBe(true);
  });
});

describe("BuildChatTab key information", () => {
  beforeEach(() => {
    cleanup();
  });

  test("says nothing has been recorded before the stages write it", () => {
    renderTab(pipeline);
    const panel = openPanel();
    expect(within(panel).getByText(/Nothing has been recorded yet/)).toBeTruthy();
  });

  test("shows every section the stages recorded", () => {
    renderTab({ ...reviewed, keyInformation, backendRevision: 90 } satisfies BuildPipeline);
    const panel = openPanel();

    const section = (name: string) => within(panel).getByRole("region", { name });
    // The framing names the first section.
    expect(within(panel).queryByRole("region", { name: "Problem" }) === null).toBe(true);
    expect(within(section("Objective")).getByText(keyInformation.statement!)).toBeTruthy();
    expect(within(section("Context")).getByText(keyInformation.context!)).toBeTruthy();
    expect(within(section("Solution")).getByText(keyInformation.solution!)).toBeTruthy();
    expect(within(section("What was done")).getByText("Added the agent tools")).toBeTruthy();

    const decisions = section("Decisions");
    expect(within(decisions).getByText("Where to store the brief")).toBeTruthy();
    expect(within(decisions).getByText("+ One source of truth")).toBeTruthy();
    expect(within(decisions).getByText("− Second store")).toBeTruthy();
    expect(within(decisions).getByText("Chosen")).toBeTruthy();
    expect(within(decisions).getByText("Every client already syncs the record.")).toBeTruthy();

    expect(
      within(section("Not done or needs further work")).getByText("Rich text formatting"),
    ).toBeTruthy();
    const tests = section("Tests");
    expect(within(tests).getByText("bun test key-information")).toBeTruthy();
    expect(within(tests).getByLabelText("Not run")).toBeTruthy();

    const issues = section("Review issues");
    expect(within(issues).getByText("Missing bound on decisions")).toBeTruthy();
    expect(within(issues).getByText("Resolved")).toBeTruthy();
    expect(within(issues).getByText("Bounded to twelve decisions.")).toBeTruthy();

    const verification = section("Verification");
    expect(within(verification).getByText("Round 1: failed")).toBeTruthy();
    expect(within(verification).getByText("Pros were missing.")).toBeTruthy();

    expect(within(panel).getByText(/by Verify · round 1/)).toBeTruthy();
  });

  test("names the first section Problem by default", () => {
    renderTab({
      ...reviewed,
      keyInformation: { ...keyInformation, framing: "problem" },
      backendRevision: 91,
    });
    const panel = openPanel();
    expect(within(panel).getByRole("region", { name: "Problem" })).toBeTruthy();
  });

  test("floats over the tab and closes on Escape, the close button or a click outside", () => {
    renderTab({ ...reviewed, keyInformation, backendRevision: 92 });
    const button = within(header()).getByRole("button", { name: /Key information/ });

    openPanel();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Key information" }) === null).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    const panel = openPanel();
    fireEvent.click(within(panel).getByRole("button", { name: "Close key information" }));
    expect(screen.queryByRole("dialog", { name: "Key information" }) === null).toBe(true);

    openPanel();
    fireEvent.pointerDown(screen.getByTestId("pipeline-inspector"));
    expect(screen.queryByRole("dialog", { name: "Key information" }) === null).toBe(true);
  });

  test("updates in place when the backend pushes a newer brief", () => {
    renderTab({ ...reviewed, backendRevision: 93 });
    openPanel();
    act(() => {
      useBuildPipelineStore
        .getState()
        .replacePipeline({ ...reviewed, keyInformation, backendRevision: 94 });
    });
    const panel = screen.getByRole("dialog", { name: "Key information" });
    expect(within(panel).getByText(keyInformation.statement!)).toBeTruthy();
  });
});
