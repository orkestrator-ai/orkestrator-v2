import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useGraphDesignerStore } from "@/stores/graphDesignerStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";
import { GraphDesignerTab } from "./GraphDesignerTab";
import { builtInDetail, fixtureSummary, listResult } from "./graph-designer.test-fixtures";
import { installReactFlowDomStubs } from "./react-flow.test-support";

/** The designer's item 405 entry points: Share, Import bundle and Review. */

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

let restoreDom: () => void;
beforeAll(() => {
  restoreDom = installReactFlowDomStubs();
});
afterAll(() => restoreDom());

const ENVIRONMENT_ID = "env-graphs-sharing";
const TAB_ID = "graphs-sharing-tab";
const PATH = ".orkestrator/graphs/review.graph.json";
const pipeline = builtInDetail("build-pipeline");
const untrusted = fixtureSummary(
  { ...graphTemplateExample("multi-review"), id: "from-repo" },
  { scope: "project", projectId: "project-1", path: PATH },
  { trust: "untrusted" },
);

beforeEach(() => {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string) => {
    switch (command) {
      case "graph_templates_list":
        return listResult([pipeline.summary, untrusted], {
          projectId: "project-1",
          status: "ok",
          directory: ".orkestrator/graphs",
          files: 1,
          truncated: false,
          problems: [],
        });
      case "graph_project_template_review":
        return {
          projectId: "project-1",
          source: {
            projectId: "project-1",
            status: "ok",
            directory: ".orkestrator/graphs",
            files: 1,
            truncated: false,
            problems: [],
          },
          items: [],
        };
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
  useGraphDesignerStore.setState({ libraries: new Map(), tabs: new Map() });
  useEnvironmentStore.setState({
    environments: [{ id: ENVIRONMENT_ID, projectId: "project-1" } as Environment],
  });
  usePaneLayoutStore.setState({
    environments: new Map([
      [
        ENVIRONMENT_ID,
        {
          root: {
            kind: "leaf",
            id: "pane-1",
            tabs: [{ id: TAB_ID, type: "graph-designer", graphDesignerData: {} }],
            activeTabId: TAB_ID,
          },
          activePaneId: "pane-1",
          containerId: null,
        },
      ],
    ]),
  });
});

afterEach(() => {
  cleanup();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("GraphDesignerTab sharing", () => {
  test("counts project templates needing review and opens the review panel", async () => {
    render(
      <div style={{ width: 1600, height: 1000, position: "relative" }}>
        <GraphDesignerTab tabId={TAB_ID} environmentId={ENVIRONMENT_ID} data={{}} isActive />
      </div>,
    );
    const review = await screen.findByRole("button", { name: "Review (1)" });
    await act(async () => {
      fireEvent.click(review);
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Review project templates")).toBeDefined();
    expect(await within(dialog).findByText("Every project template is approved.")).toBeDefined();
    expect(
      invokeMock.mock.calls.some(
        ([command, args]) =>
          command === "graph_project_template_review" &&
          (args as { projectId?: string }).projectId === "project-1",
      ),
    ).toBe(true);
  });

  test("Share needs a template; Import bundle opens the two-step import", async () => {
    render(
      <div style={{ width: 1600, height: 1000, position: "relative" }}>
        <GraphDesignerTab tabId={TAB_ID} environmentId={ENVIRONMENT_ID} data={{}} isActive />
      </div>,
    );
    await screen.findByRole("button", { name: "Review (1)" });
    expect(screen.getByRole("button", { name: /Share/ }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Import bundle/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Import a shared template")).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Check" }).hasAttribute("disabled")).toBe(
      true,
    );
  });
});
