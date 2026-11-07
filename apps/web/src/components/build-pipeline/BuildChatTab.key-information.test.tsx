import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import {
  TerminalProvider,
  useTerminalContext,
  type CreateTabOptions,
} from "@/contexts/TerminalContext";
import type { BuildPipeline } from "@/stores/buildPipelineStore";
import { BuildChatTab } from "./BuildChatTab";
import { keyInformation } from "./key-information-test-fixture";
import {
  pipeline,
  renderTab,
  restoreBuildChatTabMocks,
  reviewed,
  cleanupBuildChatScope,
  pipelineStore,
  renderInBuildChat,
} from "./build-chat-tab-test-support";

/**
 * The build tab header: the pipeline's progress under the title, then the row
 * of equal icon buttons holding the Key information panel and the graph toggle.
 */

afterAll(restoreBuildChatTabMocks);
afterEach(cleanupBuildChatScope);

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
    expect(within(section("Summary")).getByText(keyInformation.summary!)).toBeTruthy();
    // The framing names the section after the summary.
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

  test("renders code chips throughout the recorded brief", () => {
    renderTab({
      ...reviewed,
      keyInformation: {
        ...keyInformation,
        statement: "Run (`npm test`),`bun test`.",
        context: "See src/a.ts:12 and App.js; Node.js uses example.com/a.ts.",
        solution: "Update Index.js.",
        workDone: ["Changed src/b.ts#L12"],
      },
      backendRevision: 96,
    });
    const panel = openPanel();
    expect(Array.from(panel.querySelectorAll("code"), (code) => code.textContent)).toEqual([
      "npm test",
      "bun test",
      "src/a.ts",
      "App.js",
      "Index.js",
      "src/b.ts",
    ]);
    expect(within(panel).getByRole("region", { name: "Context" }).textContent).toContain(
      "See src/a.ts:12 and App.js; Node.js uses example.com/a.ts.",
    );
    expect(panel.textContent).not.toContain("`");
  });

  test("names the statement's section Problem by default", () => {
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
      pipelineStore()
        .getState()
        .replacePipeline({ ...reviewed, keyInformation, backendRevision: 94 });
    });
    const panel = screen.getByRole("dialog", { name: "Key information" });
    expect(within(panel).getByText(keyInformation.statement!)).toBeTruthy();
  });
});

describe("BuildChatTab key information as a tab", () => {
  let tabOpens = true;
  const createTab = mock((_type: string, _options?: CreateTabOptions) => tabOpens);

  /** Registers `createTab` the way the terminal container does. */
  function TabOpener() {
    const { setCreateTab } = useTerminalContext();
    useEffect(() => {
      setCreateTab(createTab);
      return () => setCreateTab(null);
    }, [setCreateTab]);
    return null;
  }

  function renderWithTabs(next: BuildPipeline) {
    pipelineStore().setState({
      pipelines: new Map([[next.id, next]]),
      buildEnvironmentIds: new Set([next.environmentId]),
    });
    renderInBuildChat(
      <TerminalProvider>
        <TabOpener />
        <BuildChatTab
          data={{
            pipelineId: next.id,
            environmentId: next.environmentId,
            taskId: next.taskId,
            isLocal: true,
          }}
        />
      </TerminalProvider>,
    );
  }

  const expectedTab = (): [string, CreateTabOptions] => [
    "key-information",
    { keyInformation: { environmentId: reviewed.environmentId, pipelineId: reviewed.id } },
  ];

  beforeEach(() => {
    cleanup();
    createTab.mockClear();
    tabOpens = true;
  });

  test("the panel's pop-out button turns the panel into the pipeline's tab", () => {
    renderWithTabs({ ...reviewed, keyInformation, backendRevision: 96 });
    const panel = openPanel();

    fireEvent.click(within(panel).getByRole("button", { name: "Open key information in a tab" }));

    expect(createTab).toHaveBeenCalledTimes(1);
    expect(createTab.mock.calls[0]).toEqual(expectedTab());
    expect(screen.queryByRole("dialog", { name: "Key information" }) === null).toBe(true);
  });

  test("keeps the panel open when the tab cannot be shown", () => {
    tabOpens = false;
    renderWithTabs({ ...reviewed, keyInformation, backendRevision: 97 });
    const panel = openPanel();

    fireEvent.click(within(panel).getByRole("button", { name: "Open key information in a tab" }));

    expect(createTab).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Key information" })).toBeTruthy();
  });

  test("right-clicking the header button opens the tab without showing the panel", () => {
    renderWithTabs({ ...reviewed, keyInformation, backendRevision: 98 });
    const button = within(header()).getByRole("button", { name: /Key information/ });

    const notPrevented = fireEvent.contextMenu(button);

    expect(notPrevented).toBe(false);
    expect(createTab).toHaveBeenCalledTimes(1);
    expect(createTab.mock.calls[0]).toEqual(expectedTab());
    expect(screen.queryByRole("dialog", { name: "Key information" }) === null).toBe(true);
  });

  test("right-clicking while the panel is open replaces the panel with the tab", () => {
    renderWithTabs({ ...reviewed, keyInformation, backendRevision: 99 });
    openPanel();

    fireEvent.contextMenu(within(header()).getByRole("button", { name: /Key information/ }));

    expect(createTab).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Key information" }) === null).toBe(true);
  });

  test("offers no pop-out where no tab can be opened", () => {
    renderTab({ ...reviewed, keyInformation, backendRevision: 100 });
    const button = within(header()).getByRole("button", { name: /Key information/ });
    const panel = openPanel();

    expect(
      within(panel).queryByRole("button", { name: "Open key information in a tab" }) === null,
    ).toBe(true);
    expect(fireEvent.contextMenu(button)).toBe(true);
  });
});
