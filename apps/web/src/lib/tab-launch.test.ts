import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  beginTabLaunch,
  cancelTabLaunchFocus,
  claimTabLaunch,
  focusTabLaunch,
  resetTabLaunches,
  TAB_LAUNCH_CLAIM_MIN_MS,
} from "@/lib/tab-launch";
import { usePaneLayoutStore, type EnvironmentPaneState } from "@/stores/paneLayoutStore";
import { useTabLaunchStore } from "@/stores/tabLaunchStore";
import type { TabInfo } from "@/types/paneLayout";

const ENV = "env-launch";

const launches = () => useTabLaunchStore.getState().launches.get(ENV) ?? [];

function paneState(tabs: TabInfo[], activeTabId: string): EnvironmentPaneState {
  return {
    root: { kind: "leaf", id: "default", tabs, activeTabId },
    activePaneId: "default",
    containerId: null,
    backendRevision: 1,
  };
}

function install(tabs: TabInfo[], activeTabId: string) {
  const environments = new Map(usePaneLayoutStore.getState().environments);
  environments.set(ENV, paneState(tabs, activeTabId));
  usePaneLayoutStore.setState({ environments });
}

const terminal: TabInfo = { id: "terminal", type: "plain" };
const launched: TabInfo = { id: "launched", type: "plain" };

function activeTab(): string | null | undefined {
  const root = usePaneLayoutStore.getState().environments.get(ENV)?.root;
  return root?.kind === "leaf" ? root.activeTabId : undefined;
}

describe("tab launches", () => {
  beforeEach(() => {
    resetTabLaunches();
    usePaneLayoutStore.setState({ environments: new Map() });
    install([terminal], "terminal");
  });

  afterEach(() => {
    resetTabLaunches();
    mock.restore();
  });

  test("a launch has focus at once, before the backend has answered", () => {
    beginTabLaunch(ENV, { tabId: "launched", title: "Push", surface: "agent" });

    expect(launches()).toEqual([
      {
        tabId: "launched",
        title: "Push",
        surface: "agent",
        focused: true,
        arrived: false,
        settled: false,
      },
    ]);
  });

  test("the tab keeps its outlines until the request answers, then the launch ends", () => {
    const launch = beginTabLaunch(ENV, { tabId: "launched", title: "Push", surface: "agent" });

    install([terminal, launched], "terminal");
    expect(launches()[0]).toMatchObject({ arrived: true, settled: false });

    launch.settled("launched");
    expect(launches()).toEqual([]);
  });

  test("a request that answers first waits for its tab", () => {
    const launch = beginTabLaunch(ENV, { tabId: "launched", title: "Run", surface: "terminal" });

    launch.settled("launched");
    expect(launches()[0]).toMatchObject({ arrived: false, settled: true });

    install([terminal, launched], "terminal");
    expect(launches()).toEqual([]);
  });

  test("a reused tab replaces the placeholder and takes the focus it held", () => {
    install([terminal, { id: "reused", type: "plain" }], "terminal");
    const launch = beginTabLaunch(ENV, { tabId: "launched", title: "Resolve", surface: "agent" });
    launch.settled("reused");

    expect(launches()).toEqual([]);
    expect(activeTab()).toBe("reused");
  });

  test("a failed launch leaves nothing behind", () => {
    const launch = beginTabLaunch(ENV, { tabId: "launched", title: "Push", surface: "agent" });

    launch.failed();

    expect(launches()).toEqual([]);
  });

  test("the latest launch holds focus", () => {
    beginTabLaunch(ENV, { tabId: "first", title: "Run", surface: "terminal" });
    beginTabLaunch(ENV, { tabId: "second", title: "Push", surface: "agent" });

    expect(launches().map(({ tabId, focused }) => [tabId, focused])).toEqual([
      ["first", false],
      ["second", true],
    ]);
  });

  test("the launches an environment holds are bounded", () => {
    for (let index = 0; index < 20; index += 1) {
      beginTabLaunch(ENV, { tabId: `tab-${index}`, title: "Run", surface: "terminal" });
    }

    expect(launches().length).toBeLessThanOrEqual(8);
    expect(launches().at(-1)?.tabId).toBe("tab-19");
  });

  test("a launch that answers for a forgotten entry does nothing", () => {
    const launch = beginTabLaunch(ENV, { tabId: "launched", title: "Run", surface: "terminal" });
    resetTabLaunches();

    expect(() => launch.settled("launched")).not.toThrow();
    expect(launches()).toEqual([]);
  });

  describe("when the tab arrives", () => {
    const arrive = () => install([terminal, launched], "terminal");

    test("the tab takes focus", () => {
      beginTabLaunch(ENV, { tabId: "launched", title: "Push", surface: "agent" });

      arrive();

      expect(activeTab()).toBe("launched");
    });

    test("picking another tab during the launch cancels its focus", () => {
      beginTabLaunch(ENV, { tabId: "launched", title: "Push", surface: "agent" });

      cancelTabLaunchFocus(ENV);
      arrive();

      expect(launches()[0]?.focused).toBe(false);
      expect(activeTab()).toBe("terminal");
    });

    test("picking the placeholder takes focus back", () => {
      beginTabLaunch(ENV, { tabId: "launched", title: "Push", surface: "agent" });
      cancelTabLaunchFocus(ENV);

      focusTabLaunch(ENV, "launched");
      arrive();

      expect(launches()[0]?.focused).toBe(true);
      expect(activeTab()).toBe("launched");
    });

    test("a tab nobody launched here does not take focus", () => {
      arrive();

      expect(activeTab()).toBe("terminal");
    });
  });
});

describe("claimTabLaunch", () => {
  beforeEach(resetTabLaunches);

  test("admits one launch per action and environment", () => {
    expect(claimTabLaunch("run", ENV)).not.toBeNull();

    expect(claimTabLaunch("run", ENV)).toBeNull();
    expect(claimTabLaunch("push", ENV)).not.toBeNull();
    expect(claimTabLaunch("run", "another-environment")).not.toBeNull();
  });

  test("a request that answers quickly still covers a double press", async () => {
    const release = claimTabLaunch("run", ENV);

    release?.();
    expect(claimTabLaunch("run", ENV)).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, TAB_LAUNCH_CLAIM_MIN_MS + 50));
    expect(claimTabLaunch("run", ENV)).not.toBeNull();
  });
});
