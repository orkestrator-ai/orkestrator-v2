import { afterAll, beforeEach, mock, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { BuildPipelineKeyInformation } from "@orkestrator/protocol/build-pipeline-key-information";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { PaneLeaf, TabInfo } from "@/types/paneLayout";
import * as realPersistence from "@/lib/build-pipeline-persistence";
const persistenceSnapshot = { ...realPersistence };
const hydrate = mock(async (_id: string): Promise<BuildPipeline | null> => null);
mock.module("@/lib/build-pipeline-persistence", () => ({
  ...persistenceSnapshot,
  hydrateBuildPipeline: hydrate,
}));
afterAll(() => mock.module("@/lib/build-pipeline-persistence", () => persistenceSnapshot));
const { PipelineKeyInformationTab } = await import("./PipelineKeyInformationTab");
import { keyInformation } from "./key-information-test-fixture";

/**
 * The key information tab: the brief the header panel shows, laid out for a
 * full pane with a summary strip, a tests table and issues grouped by round.
 */

const ENVIRONMENT_ID = "env-1";
const PIPELINE_ID = "pipeline-1";

const pipeline = {
  id: PIPELINE_ID,
  taskId: "task-1",
  projectId: "project-1",
  environmentId: ENVIRONMENT_ID,
  environmentType: "local",
  agentType: "codex",
  phase: "verifying",
  sessions: [],
  currentSessionIndex: 0,
  iteration: 0,
  maxIterations: 3,
  createdAt: "2026-11-01T09:00:00.000Z",
  taskTitle: "Make the brief readable",
  taskSnapshot: { title: "Make the brief readable", description: "" },
  backendRevision: 1,
  controller: "backend",
} as unknown as BuildPipeline;

const twoRounds: BuildPipelineKeyInformation = {
  ...keyInformation,
  tests: [
    { name: "bun test passes-first", result: "passed" },
    { name: "bun test failing-suite", result: "failed", details: "One assertion failed." },
    { name: "mise run test:browser", result: "not-run", details: "Not needed here." },
  ],
  issues: [
    ...keyInformation.issues,
    {
      round: 1,
      issue: "Tab title is too long",
      resolution: "",
      status: "open",
    },
  ],
  verifications: [
    ...keyInformation.verifications,
    { round: 1, passed: true, summary: "Every criterion passes.", checks: [] },
  ],
};

const buildTab: TabInfo = {
  id: "build",
  type: "claude-build",
  buildTabData: { environmentId: ENVIRONMENT_ID, pipelineId: PIPELINE_ID, taskId: "task-1" },
};
const briefTab: TabInfo = {
  id: "brief",
  type: "key-information",
  keyInformationTabData: { environmentId: ENVIRONMENT_ID, pipelineId: PIPELINE_ID },
};

function seed(next: BuildPipeline, tabs: TabInfo[] = [buildTab, briefTab]) {
  useBuildPipelineStore.setState({
    pipelines: new Map([[next.id, next]]),
    buildEnvironmentIds: new Set([next.environmentId]),
  });
  usePaneLayoutStore.setState({
    environments: new Map([
      [
        ENVIRONMENT_ID,
        {
          root: { kind: "leaf", id: "pane-1", tabs, activeTabId: "brief" },
          activePaneId: "pane-1",
          containerId: null,
        },
      ],
    ]),
  });
}

function renderTab(next: BuildPipeline, tabs?: TabInfo[]) {
  seed(next, tabs);
  render(
    <PipelineKeyInformationTab data={{ environmentId: ENVIRONMENT_ID, pipelineId: PIPELINE_ID }} />,
  );
  return screen.getByTestId("pipeline-key-information-tab");
}

const section = (tab: HTMLElement, name: string) => within(tab).getByRole("region", { name });

describe("PipelineKeyInformationTab", () => {
  beforeEach(() => {
    cleanup();
  });

  function renderCold() {
    useBuildPipelineStore.setState({ pipelines: new Map() });
    render(
      <PipelineKeyInformationTab
        data={{ environmentId: ENVIRONMENT_ID, pipelineId: PIPELINE_ID }}
      />,
    );
  }

  test("fetches an uncached pipeline and displays its brief", async () => {
    let finish!: () => void;
    hydrate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => {
            seed(pipeline);
            resolve(pipeline);
          };
        }),
    );
    renderCold();
    expect(screen.getByRole("status").textContent).toBe("Loading key information…");
    await act(async () => finish());
    expect(screen.getByRole("heading", { name: pipeline.taskTitle })).toBeTruthy();
  });

  test("shows a fetch error and retries successfully", async () => {
    hydrate.mockImplementationOnce(async () => {
      throw new Error("backend unavailable");
    });
    renderCold();
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toBe("Could not load key information.");
    hydrate.mockImplementationOnce(async () => {
      seed(pipeline);
      return pipeline;
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(screen.getByRole("heading", { name: pipeline.taskTitle })).toBeTruthy();
  });

  test("shows a missing pipeline after a completed empty read", async () => {
    hydrate.mockResolvedValueOnce(null);
    renderCold();
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toBe("This pipeline is no longer available.");
    expect(screen.queryByText("Loading key information…")).toBeNull();
  });

  test("explains that nothing is recorded yet", () => {
    const tab = renderTab(pipeline);
    expect(within(tab).getByText("Nothing has been recorded yet")).toBeTruthy();
    expect(within(tab).getByRole("heading", { name: "Make the brief readable" })).toBeTruthy();
  });

  test("shows every recorded section with the latest update in the header", () => {
    const tab = renderTab({ ...pipeline, keyInformation, backendRevision: 2 });

    expect(within(section(tab, "Objective")).getByText(keyInformation.statement!)).toBeTruthy();
    expect(within(section(tab, "Context")).getByText(keyInformation.context!)).toBeTruthy();
    expect(within(section(tab, "Solution")).getByText(keyInformation.solution!)).toBeTruthy();
    expect(within(section(tab, "What was done")).getByText("Added the agent tools")).toBeTruthy();

    const decisions = section(tab, "Decisions");
    expect(within(decisions).getByText("Where to store the brief")).toBeTruthy();
    expect(within(decisions).getByText("One source of truth")).toBeTruthy();
    expect(within(decisions).getAllByLabelText("Con")).toHaveLength(2);
    expect(within(decisions).getByText("Chosen")).toBeTruthy();
    expect(within(decisions).getByText("Every client already syncs the record.")).toBeTruthy();

    expect(
      within(section(tab, "Not done or needs further work")).getByText("Rich text formatting"),
    ).toBeTruthy();
    expect(
      within(section(tab, "Review issues")).getByText("Bounded to twelve decisions."),
    ).toBeTruthy();
    expect(within(section(tab, "Verification")).getByText("Round 1: failed")).toBeTruthy();
    expect(
      within(section(tab, "Update history")).getByText(/Verify · round 1 · verification/),
    ).toBeTruthy();
    expect(within(tab).getByText(/Key information · Updated .* by Verify · round 1/)).toBeTruthy();
  });

  test("summarises tests, issues and the latest verification", () => {
    const tab = renderTab({ ...pipeline, keyInformation: twoRounds, backendRevision: 3 });
    const summary = within(tab).getByRole("group", { name: "Summary" });

    expect(
      within(summary).getByRole("button", { name: /Tests\s*1\/3 passed\s*1 failed/ }),
    ).toBeTruthy();
    expect(
      within(summary).getByRole("button", { name: /Review issues\s*1 open\s*2 reported/ }),
    ).toBeTruthy();
    expect(
      within(summary).getByRole("button", { name: /Verification\s*Passed\s*Round 2/ }),
    ).toBeTruthy();
    expect(within(summary).getByRole("button", { name: /Decisions\s*1/ })).toBeTruthy();
  });

  test("lists failing tests first and groups issues and verifications newest round first", () => {
    const tab = renderTab({ ...pipeline, keyInformation: twoRounds, backendRevision: 4 });

    const rows = within(section(tab, "Tests")).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByText(/^bun test|^mise run/).textContent)).toEqual([
      "bun test failing-suite",
      "mise run test:browser",
      "bun test passes-first",
    ]);

    const issues = section(tab, "Review issues");
    const rounds = within(issues)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(rounds).toEqual(["Round 2", "Round 1"]);

    const verification = section(tab, "Verification");
    const verdicts = within(verification)
      .getAllByText(/^Round \d: /)
      .map((node) => node.textContent);
    expect(verdicts).toEqual(["Round 2: passed", "Round 1: failed"]);
    expect(within(verification).getByText("Latest")).toBeTruthy();
  });

  test("Open pipeline focuses the pipeline's build tab", () => {
    const tab = renderTab({ ...pipeline, keyInformation, backendRevision: 5 });

    fireEvent.click(within(tab).getByRole("button", { name: "Open pipeline" }));

    const leaf = usePaneLayoutStore.getState().environments.get(ENVIRONMENT_ID)!.root as PaneLeaf;
    expect(leaf.activeTabId).toBe("build");
  });

  test("offers no Open pipeline when the build tab is closed", () => {
    const tab = renderTab({ ...pipeline, keyInformation, backendRevision: 6 }, [briefTab]);
    expect(within(tab).queryByRole("button", { name: "Open pipeline" }) === null).toBe(true);
  });

  test("updates in place when the backend pushes a newer brief", () => {
    const tab = renderTab({ ...pipeline, backendRevision: 7 });
    act(() => {
      // The store's own snapshot validation is covered elsewhere; this
      // fixture is minimal, so swap the record directly.
      useBuildPipelineStore.setState({
        pipelines: new Map([[PIPELINE_ID, { ...pipeline, keyInformation, backendRevision: 8 }]]),
      });
    });
    expect(within(tab).getByText(keyInformation.statement!)).toBeTruthy();
  });
});
