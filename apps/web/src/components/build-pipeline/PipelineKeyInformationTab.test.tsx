import { afterAll, beforeEach, mock, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { BuildPipelineKeyInformation } from "@orkestrator/protocol/build-pipeline-key-information";
import { emptyKeyInformation } from "@orkestrator/protocol/build-pipeline-key-information";
import { type BuildPipeline, buildPipelineStore } from "@/stores/buildPipelineStore";
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
import { appCommandStore } from "@/test/app-command-store";

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
  appCommandStore(buildPipelineStore).setState({
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
    appCommandStore(buildPipelineStore).setState({ pipelines: new Map() });
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
    expect(screen.queryByText("Loading key information…") === null).toBe(true);
  });

  describe("notes view", () => {
    const renderNotes = () =>
      render(
        <PipelineKeyInformationTab
          data={{ environmentId: ENVIRONMENT_ID, pipelineId: PIPELINE_ID, view: "notes" }}
        />,
      );

    test("leads with what needs a look, collapsed, updating in place", () => {
      seed({ ...pipeline, keyInformation, backendRevision: 2 });
      renderNotes();
      const tab = screen.getByTestId("pipeline-key-information-tab");

      expect(tab.textContent).toContain("Notes ·");
      const flagged = within(tab).getByRole("region", { name: "Needs a look" });
      expect(within(flagged).queryByText("Rich text formatting") === null).toBe(true);
      fireEvent.click(within(flagged).getByRole("button", { name: /^Needs a look/ }));
      expect(within(flagged).getByText("Rich text formatting")).toBeTruthy();
      expect(within(section(tab, "Solution")).getByText(keyInformation.solution!)).toBeTruthy();
      expect(flagged.compareDocumentPosition(section(tab, "Summary"))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );

      act(() =>
        appCommandStore(buildPipelineStore).setState({
          pipelines: new Map([[PIPELINE_ID, { ...pipeline, backendRevision: 3 }]]),
        }),
      );
      expect(within(tab).queryByRole("region", { name: "Needs a look" }) === null).toBe(true);
      expect(within(tab).getByText("Nothing was flagged for a person to look at.")).toBeTruthy();
    });

    test("names the notes while it loads an uncached pipeline", async () => {
      appCommandStore(buildPipelineStore).setState({ pipelines: new Map() });
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
      renderNotes();
      expect(screen.getByRole("status").textContent).toBe("Loading notes…");
      await act(async () => finish());
      expect(screen.getByText("Nothing was flagged for a person to look at.")).toBeTruthy();
    });

    test("the key information view stays the brief alone", () => {
      const tab = renderTab({ ...pipeline, keyInformation, backendRevision: 2 });
      expect(tab.textContent).toContain("Key information ·");
      expect(within(tab).queryByRole("region", { name: "Needs a look" }) === null).toBe(true);
    });
  });

  test("explains that nothing is recorded yet", () => {
    const tab = renderTab(pipeline);
    expect(within(tab).getByText("Nothing has been recorded yet")).toBeTruthy();
    expect(within(tab).getByRole("heading", { name: "Make the brief readable" })).toBeTruthy();
  });

  test("shows every recorded section with the latest update in the header", () => {
    const tab = renderTab({ ...pipeline, keyInformation, backendRevision: 2 });

    expect(within(section(tab, "Summary")).getByText(keyInformation.summary!)).toBeTruthy();
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

  test.each(["problem", "objective"] as const)(
    "keeps the legacy %s first and lead styled when summary is absent",
    (framing) => {
      const legacy = { ...keyInformation, framing };
      delete legacy.summary;
      const tab = renderTab({ ...pipeline, keyInformation: legacy });
      const title = framing === "objective" ? "Objective" : "Problem";
      const statement = section(tab, title);
      expect(within(tab).getAllByRole("region")[0]).toBe(statement);
      expect(within(tab).queryByRole("region", { name: "Summary" }) === null).toBe(true);
      // The paragraph sits in the prose block that carries the lead styling.
      const prose = within(statement).getByText(legacy.statement!).parentElement!;
      expect(prose.classList.contains("text-[15px]")).toBe(true);
      expect(prose.classList.contains("leading-7")).toBe(true);
      expect(prose.parentElement!.classList.contains("border-blue-400/60")).toBe(true);
      const nav = within(tab).getByRole("navigation", { name: "Key information sections" });
      expect(within(nav).getAllByRole("button")[0]!.textContent).toBe(title);
      expect(within(nav).queryByRole("button", { name: "Summary" }) === null).toBe(true);
      expect(nav.querySelector('[aria-current="location"]')?.textContent).toBe(title);
    },
  );

  test("renders a summary-only brief as the lead section", () => {
    const summary = "The pipeline now explains its progress in plain language.";
    const tab = renderTab({
      ...pipeline,
      keyInformation: { ...emptyKeyInformation(keyInformation.updatedAt), summary },
    });
    const regions = within(tab).getAllByRole("region");
    expect(regions).toHaveLength(1);
    expect(regions[0]).toBe(section(tab, "Summary"));
    // The paragraph sits in the prose block that carries the lead styling.
    const prose = within(regions[0]!).getByText(summary).parentElement!;
    expect(prose.classList.contains("text-[15px]")).toBe(true);
    expect(prose.classList.contains("leading-7")).toBe(true);
    expect(prose.parentElement!.classList.contains("border-blue-400/60")).toBe(true);
    expect(within(tab).queryByText("Nothing has been recorded yet") === null).toBe(true);
    const nav = within(tab).getByRole("navigation", { name: "Key information sections" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Summary"]);
    expect(nav.querySelector('[aria-current="location"]')?.textContent).toBe("Summary");
  });

  test("summarises tests, issues and the latest verification", () => {
    const tab = renderTab({ ...pipeline, keyInformation: twoRounds, backendRevision: 3 });
    const summary = within(tab).getByRole("group", { name: "At a glance" });

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

  test("the section list scrolls the tab smoothly to a section and marks it current", () => {
    const tab = renderTab({ ...pipeline, keyInformation, backendRevision: 9 });
    const scroller = tab.querySelector<HTMLElement>(".overflow-y-auto")!;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 4000 });
    scroller.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    section(tab, "Tests").getBoundingClientRect = () => ({ top: 1600 }) as DOMRect;
    const scrollTo = mock((_options: ScrollToOptions) => undefined);
    scroller.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
    const nav = within(tab).getByRole("navigation", { name: "Key information sections" });

    fireEvent.click(within(nav).getByRole("button", { name: /^Tests/ }));

    expect(scrollTo.mock.calls[0]![0]).toEqual({ top: 1500 - 12, behavior: "smooth" });
    expect(nav.querySelector('[aria-current="location"]')?.textContent).toMatch(/^Tests/);
  });

  test("paired headings retain the selected member while scrolling within their row", async () => {
    const tab = renderTab({ ...pipeline, keyInformation, backendRevision: 10 });
    const scroller = tab.querySelector<HTMLElement>(".overflow-y-auto")!;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 4000 });
    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    Array.from(scroller.querySelectorAll<HTMLElement>("section")).forEach((element, index) => {
      const top = index === 3 ? 600 : index * 300;
      element.getBoundingClientRect = () => ({ top: top - scroller.scrollTop }) as DOMRect;
    });
    scroller.scrollTo = ((options: ScrollToOptions) => {
      scroller.scrollTop = options.top ?? 0;
    }) as HTMLElement["scrollTo"];
    const nav = within(tab).getByRole("navigation", { name: "Key information sections" });
    for (const name of ["Context", "Solution"]) {
      fireEvent.click(within(nav).getByRole("button", { name: new RegExp(`^${name}`) }));
      await act(async () => {
        fireEvent(scroller, new Event("scrollend"));
        scroller.scrollTop += 5;
        fireEvent.scroll(scroller);
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(nav.querySelector('[aria-current="location"]')?.textContent).toMatch(
        new RegExp(`^${name}`),
      );
    }
    await act(async () => {
      scroller.scrollTop = 1210;
      fireEvent.scroll(scroller);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(nav.querySelector('[aria-current="location"]')?.textContent).toMatch(/^What was done/);
    await act(async () => {
      scroller.scrollTop = 610;
      fireEvent.scroll(scroller);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(nav.querySelector('[aria-current="location"]')?.textContent).toMatch(/^Context/);
  });

  test("tab jumps honour reduced motion, clamp at the end and hold the highlight in flight", async () => {
    const original = window.matchMedia;
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    try {
      const tab = renderTab({ ...pipeline, keyInformation, backendRevision: 11 });
      const scroller = tab.querySelector<HTMLElement>(".overflow-y-auto")!;
      Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 4000 });
      scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
      Array.from(scroller.querySelectorAll<HTMLElement>("section")).forEach((element, index) => {
        element.getBoundingClientRect = () =>
          ({ top: index * 500 - scroller.scrollTop }) as DOMRect;
      });
      const scrollTo = mock((_options: ScrollToOptions) => undefined);
      scroller.scrollTo = scrollTo as HTMLElement["scrollTo"];
      const nav = within(tab).getByRole("navigation", { name: "Key information sections" });
      fireEvent.click(within(nav).getByRole("button", { name: /^Update history/ }));
      expect(scrollTo).toHaveBeenCalledWith({ top: 3600, behavior: "auto" });
      await act(async () => {
        scroller.scrollTop = 1010;
        fireEvent.scroll(scroller);
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(nav.querySelector('[aria-current="location"]')?.textContent).toMatch(
        /^Update history/,
      );
      await act(async () => {
        fireEvent(scroller, new Event("scrollend"));
        fireEvent.scroll(scroller);
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(nav.querySelector('[aria-current="location"]')?.textContent).toMatch(/^Context/);
    } finally {
      window.matchMedia = original;
    }
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
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([[PIPELINE_ID, { ...pipeline, keyInformation, backendRevision: 8 }]]),
      });
    });
    expect(within(tab).getByText(keyInformation.statement!)).toBeTruthy();
  });
});
