import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useUIStore } from "@/stores/uiStore";
import { onGraphRunViewRequested, takePendingGraphRunView } from "./graph-run-navigation";
import {
  openCoordinatorWorkTarget,
  type CoordinatorWorkNavigation,
} from "./coordinator-work-navigation";

function seedLayout() {
  usePaneLayoutStore.setState({
    activeEnvironmentId: "env-1",
    hydration: new Map([["env-1", "done"]]),
    environments: new Map([
      [
        "env-1",
        {
          root: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            children: [
              {
                kind: "leaf",
                id: "pane-1",
                tabs: [{ id: "terminal-1", type: "terminal" }],
                activeTabId: "terminal-1",
              },
              {
                kind: "leaf",
                id: "pane-2",
                tabs: [
                  {
                    id: "worker-tab",
                    type: "agent-native",
                    nativeAgentData: { environmentId: "env-1", platform: "claude" },
                  },
                  {
                    id: "review-reviewer",
                    type: "multi-review",
                    multiReviewTabData: {
                      environmentId: "env-1",
                      workflowId: "review-1",
                      reviewerId: "r1",
                    },
                  },
                  {
                    id: "review-main",
                    type: "multi-review",
                    multiReviewTabData: { environmentId: "env-1", workflowId: "review-1" },
                  },
                ],
                activeTabId: "review-reviewer",
              },
            ],
            sizes: [50, 50],
          },
          activePaneId: "pane-1",
          containerId: null,
        },
      ],
    ]),
  } as never);
}

function navigation(): CoordinatorWorkNavigation & {
  [K in keyof CoordinatorWorkNavigation]: ReturnType<typeof mock>;
} {
  return {
    openPullRequest: mock(() => undefined),
    openRemote: mock(() => undefined),
    openBuild: mock(() => undefined),
  };
}

const activeTab = (paneId: string) =>
  usePaneLayoutStore
    .getState()
    .getAllTabs("env-1")
    .find(
      (tab) =>
        usePaneLayoutStore.getState().findPaneWithTab(tab.id, "env-1")?.id === paneId &&
        usePaneLayoutStore.getState().findPaneWithTab(tab.id, "env-1")?.activeTabId === tab.id,
    )?.id;

describe("openCoordinatorWorkTarget", () => {
  beforeEach(() => {
    seedLayout();
    useUIStore.setState({ selectedProjectId: null, selectedEnvironmentId: null });
  });
  afterEach(() => {
    takePendingGraphRunView();
  });

  test("a worker row selects its environment and focuses the delegated tab", () => {
    openCoordinatorWorkTarget(
      { type: "worker-tab", projectId: "project-1", environmentId: "env-1", tabId: "worker-tab" },
      navigation(),
    );
    expect(useUIStore.getState().selectedProjectId).toBe("project-1");
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-1");
    expect(activeTab("pane-2")).toBe("worker-tab");
    expect(usePaneLayoutStore.getState().getActivePaneId("env-1")).toBe("pane-2");
  });

  test("a Multi Review row focuses the review's own tab, not a reviewer's", () => {
    openCoordinatorWorkTarget(
      { type: "review", projectId: "project-1", environmentId: "env-1", workflowId: "review-1" },
      navigation(),
    );
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-1");
    expect(activeTab("pane-2")).toBe("review-main");
  });

  test.each([false, true])(
    "restores a closed review tab after hydration (delayed=%s)",
    (delayed) => {
      const store = usePaneLayoutStore.getState();
      store.removeTab("pane-2", "review-main", "env-1");
      if (delayed) usePaneLayoutStore.setState({ hydration: new Map([["env-1", "pending"]]) });
      openCoordinatorWorkTarget(
        { type: "review", projectId: "project-1", environmentId: "env-1", workflowId: "review-1" },
        navigation(),
      );
      if (delayed) {
        expect(store.getAllTabs("env-1").some((t) => t.id === "multi-review:review-1")).toBe(false);
        usePaneLayoutStore.getState().finishHydration("env-1");
      }
      expect(activeTab("pane-1")).toBe("multi-review:review-1");
      expect(
        store
          .getAllTabs("env-1")
          .filter(
            (t) =>
              t.multiReviewTabData?.workflowId === "review-1" && !t.multiReviewTabData.reviewerId,
          ),
      ).toHaveLength(1);
    },
  );

  test("a build row activates the build tab through the pipeline activation path", () => {
    const nav = navigation();
    openCoordinatorWorkTarget(
      { type: "build", projectId: "project-1", pipelineId: "pipe-1", environmentId: "env-9" },
      nav,
    );
    expect(nav.openBuild).toHaveBeenCalledWith("project-1", "pipe-1", "env-9");
  });

  test("a graph run row selects its environment and asks the run view to open it", () => {
    const seen: unknown[] = [];
    const off = onGraphRunViewRequested((request) => {
      seen.push(request);
      return true;
    });
    try {
      openCoordinatorWorkTarget(
        {
          type: "graph-run",
          projectId: "project-1",
          environmentId: "env-1",
          runId: "run-1",
          title: "Ship it",
        },
        navigation(),
      );
    } finally {
      off();
    }
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-1");
    expect(seen).toEqual([
      {
        runId: "run-1",
        projectId: "project-1",
        environmentId: "env-1",
        mock: false,
        title: "Ship it",
      },
    ]);
  });

  test("a pull request row opens the pull request", () => {
    const nav = navigation();
    openCoordinatorWorkTarget({ type: "pull-request", url: "https://github.com/o/r/pull/4" }, nav);
    expect(nav.openPullRequest).toHaveBeenCalledWith("https://github.com/o/r/pull/4");
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
  });

  test("work on another node opens through that node's workspace", () => {
    const nav = navigation();
    const target = {
      type: "remote" as const,
      nodeId: "node-b",
      projectId: "remote-project",
      environmentId: "remote-env",
      title: "remote worker",
    };
    openCoordinatorWorkTarget(target, nav);
    expect(nav.openRemote).toHaveBeenCalledWith(target);
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
  });
});
