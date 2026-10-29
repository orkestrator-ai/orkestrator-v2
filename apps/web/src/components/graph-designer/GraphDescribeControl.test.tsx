import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GraphDescribeJobView } from "@orkestrator/protocol/graphs/describe";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { dispatchResourceChange } from "@/lib/resource-sync";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useGraphDescribeStore } from "@/stores/graphDescribeStore";
import { useGraphDesignerStore } from "@/stores/graphDesignerStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";
import { GraphDesignerTab } from "./GraphDesignerTab";
import { builtInDetail, listResult } from "./graph-designer.test-fixtures";
import { installReactFlowDomStubs } from "./react-flow.test-support";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

let restoreDom: () => void;
beforeAll(() => {
  restoreDom = installReactFlowDomStubs();
});
afterAll(() => restoreDom());

const ENVIRONMENT_ID = "env-describe";
const TAB_ID = "graphs-describe-tab";
const pipeline = builtInDetail("build-pipeline");
const described = (() => {
  const template = graphTemplateExample("multi-review");
  delete template.layout;
  return { ...template, id: "described-review", name: "Described review" };
})();

function job(overrides: Partial<GraphDescribeJobView> = {}): GraphDescribeJobView {
  return {
    id: "job-1",
    environmentId: ENVIRONMENT_ID,
    projectId: "project-1",
    status: "running",
    progress: "drafting",
    repairs: 0,
    agent: "claude",
    description: "A review panel, a consolidator and a fixer.",
    modifying: false,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    ...overrides,
  };
}

let backendJob: GraphDescribeJobView | null = null;
let started: Record<string, unknown> | null = null;

function installBackend() {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "graph_templates_list":
        return listResult([pipeline.summary]);
      case "graph_describe_status":
        return backendJob;
      case "graph_describe_start":
        started = args;
        backendJob = job({ progress: "starting" });
        return backendJob;
      case "graph_describe_cancel":
        backendJob = job({ status: "cancelled", progress: undefined });
        return backendJob;
      case "graph_describe_dismiss":
        backendJob = null;
        return { dismissed: true };
      case "get_opencode_model_catalog_cache":
        return null;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
}

function seedStores() {
  useGraphDesignerStore.setState({ libraries: new Map(), tabs: new Map() });
  useGraphDescribeStore.setState({ entries: new Map() });
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
}

function renderTab(isActive = true) {
  return render(
    <div style={{ width: 1600, height: 1000, position: "relative" }}>
      <GraphDesignerTab
        tabId={TAB_ID}
        environmentId={ENVIRONMENT_ID}
        data={{}}
        isActive={isActive}
      />
    </div>,
  );
}

function statusCalls(): number {
  return invokeMock.mock.calls.filter(([command]) => command === "graph_describe_status").length;
}

beforeEach(() => {
  backendJob = null;
  started = null;
  installBackend();
  seedStores();
});

afterEach(() => {
  cleanup();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("Describe a graph in the designer", () => {
  test("starts a job from the dialog with the description and the chosen agent", async () => {
    renderTab();
    await screen.findByText(pipeline.summary.name);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Describe a graph" }));
    });
    fireEvent.change(screen.getByLabelText("What should the graph do?"), {
      target: { value: "A review panel, a consolidator and a fixer." },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Describe$/ }));
    });
    expect(started).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      description: "A review panel, a consolidator and a fixer.",
    });
    expect(started).not.toHaveProperty("baseDraft");
    // The dialog now shows the backend job's progress.
    expect((await screen.findByRole("status")).textContent).toContain(
      "Starting the designer agent…",
    );
  });

  test("progress is the backend's: a remounted tab reads the running job back", async () => {
    backendJob = job({ progress: "correcting", repairs: 1 });
    const view = renderTab();
    await waitFor(() =>
      expect(document.querySelector('[data-graph-describe-status="running"]')).not.toBeNull(),
    );
    expect(screen.getByText("Correcting the draft the compiler refused…")).toBeDefined();
    view.unmount();
    // A fresh client (a reload) has no local state at all.
    useGraphDescribeStore.setState({ entries: new Map() });
    const before = statusCalls();
    renderTab();
    await waitFor(() => expect(statusCalls()).toBeGreaterThan(before));
    await screen.findByText("Correcting the draft the compiler refused…");
  });

  test("a finished draft opens unsaved in the designer, and the job is dismissed", async () => {
    backendJob = job();
    renderTab();
    await screen.findByText("Drafting the graph…");
    backendJob = job({
      status: "completed",
      progress: undefined,
      template: described,
      completedAt: "2026-10-29T00:01:00.000Z",
    });
    await act(async () => {
      dispatchResourceChange({
        resource: "graph-describe",
        id: ENVIRONMENT_ID,
        revision: 2,
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    await waitFor(() => {
      const editor = useGraphDesignerStore.getState().tabs.get(TAB_ID)?.editor;
      expect(editor?.isNew).toBe(true);
      expect(editor?.draft.id).toBe("described-review");
      expect(editor?.saved).toBeNull();
    });
    expect(screen.getByText("(new, unsaved)")).toBeDefined();
    await waitFor(() =>
      expect(invokeMock.mock.calls).toContainEqual([
        "graph_describe_dismiss",
        { environmentId: ENVIRONMENT_ID, jobId: "job-1" },
      ]),
    );
    // Nothing was saved: opening the draft never calls graph_template_save.
    expect(invokeMock.mock.calls.map(([command]) => command)).not.toContain("graph_template_save");
  });

  test("an inactive tab waits, and the draft opens when the tab is shown", async () => {
    backendJob = job({ status: "completed", progress: undefined, template: described });
    const view = renderTab(false);
    await waitFor(() => expect(statusCalls()).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useGraphDesignerStore.getState().tabs.get(TAB_ID)?.editor ?? null).toBeNull();
    view.rerender(
      <div style={{ width: 1600, height: 1000, position: "relative" }}>
        <GraphDesignerTab tabId={TAB_ID} environmentId={ENVIRONMENT_ID} data={{}} isActive />
      </div>,
    );
    await waitFor(() =>
      expect(useGraphDesignerStore.getState().tabs.get(TAB_ID)?.editor?.draft.id).toBe(
        "described-review",
      ),
    );
  });

  test("a failed job shows its error and can be dismissed", async () => {
    backendJob = job({ status: "failed", progress: undefined, error: "The session failed" });
    renderTab();
    const failed = await screen.findByRole("button", { name: /Describe failed/ });
    expect(failed.getAttribute("title")).toBe("The session failed");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss the failed request" }));
    });
    await waitFor(() =>
      expect(document.querySelector('[data-graph-describe-status="failed"]') === null).toBe(true),
    );
  });

  test("cancelling from the dialog cancels the backend job", async () => {
    backendJob = job();
    renderTab();
    await act(async () => {
      fireEvent.click(await screen.findByText("Drafting the graph…"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    });
    expect(invokeMock.mock.calls).toContainEqual([
      "graph_describe_cancel",
      { environmentId: ENVIRONMENT_ID },
    ]);
    await waitFor(() =>
      expect(document.querySelector('[data-graph-describe-status="running"]') === null).toBe(true),
    );
  });
});
