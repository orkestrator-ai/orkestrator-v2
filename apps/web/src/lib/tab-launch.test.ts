import { flushPaneTabActivation } from "./pane-layout-authoritative";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  beginTabLaunch,
  cancelTabLaunchFocus,
  claimTabLaunch,
  focusTabLaunch,
  resetTabLaunches,
  TAB_LAUNCH_CLAIM_MIN_MS,
} from "@/lib/tab-launch";
import { type EnvironmentPaneState, paneLayoutStore } from "@/stores/paneLayoutStore";

import type { TabInfo } from "@/types/paneLayout";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { tabLaunchStore } from "@/stores/tabLaunchStore";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { appCommandStore } from "@/test/app-command-store";

const ENV = "env-launch";

const launches = () => appCommandStore(tabLaunchStore).getState().launches.get(ENV) ?? [];

function paneState(tabs: TabInfo[], activeTabId: string): EnvironmentPaneState {
  return {
    root: { kind: "leaf", id: "default", tabs, activeTabId },
    activePaneId: "default",
    containerId: null,
    backendRevision: 1,
  };
}

function install(tabs: TabInfo[], activeTabId: string) {
  const environments = new Map(appCommandStore(paneLayoutStore).getState().environments);
  environments.set(ENV, paneState(tabs, activeTabId));
  appCommandStore(paneLayoutStore).setState({ environments });
}

const terminal: TabInfo = { id: "terminal", type: "plain" };
const launched: TabInfo = { id: "launched", type: "plain" };

function activeTab(): string | null | undefined {
  const root = appCommandStore(paneLayoutStore).getState().environments.get(ENV)?.root;
  return root?.kind === "leaf" ? root.activeTabId : undefined;
}

describe("tab launches", () => {
  beforeEach(() => {
    resetTabLaunches();
    appCommandStore(paneLayoutStore).setState({ environments: new Map() });
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

  test("expiry withdraws the pending activation without cancelling a newer launch", () => {
    let expire: (() => void) | undefined;
    const original = globalThis.setTimeout;
    spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      if (ms === 15_000) {
        expire = callback;
        return original(() => {}, 0);
      }
      return original(callback, ms);
    }) as typeof setTimeout);
    const launch = beginTabLaunch(ENV, { tabId: "launched", title: "Run", surface: "terminal" });
    launch.settled();
    expire?.();
    expect(launches()).toEqual([]);
    install([terminal, launched], "terminal");
    flushPaneTabActivation(ENV);
    expect(activeTab()).toBe("terminal");
  });

  test.each(["navigation", "new launch"])(
    "reused Resolve respects %s before its answer",
    (choice) => {
      install([terminal, { id: "reused", type: "plain" }], "terminal");
      const launch = beginTabLaunch(ENV, {
        tabId: "resolve-claim",
        title: "Resolve",
        surface: "agent",
      });
      if (choice === "navigation") cancelTabLaunchFocus(ENV);
      else beginTabLaunch(ENV, { tabId: "run", title: "Run", surface: "terminal" });
      launch.settled("reused");
      expect(activeTab()).toBe("terminal");
    },
  );

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

describe("per node scope (plan item 3003)", () => {
  let windowScope: WindowScope;
  let leaf: NodeScope;

  beforeEach(() => {
    resetTabLaunches();
    appCommandStore(paneLayoutStore).setState({ environments: new Map() });
    install([terminal], "terminal");
    windowScope = new WindowScope();
    windowScope.open({
      role: "command",
      client: new FakeNodeClient({ nodeId: "bk_tab-launch-a" as BackendId }),
    });
    leaf = windowScope.open({
      role: "leaf",
      client: new FakeNodeClient({ nodeId: "bk_tab-launch-b" as BackendId }),
    });
  });

  afterEach(() => {
    windowScope.dispose();
    resetTabLaunches();
    mock.restore();
  });

  test("a launch lands in its scope's store only", () => {
    beginTabLaunch(ENV, { tabId: "launched", title: "Push", surface: "agent" }, leaf);

    expect(leaf.store(tabLaunchStore).getState().launches.get(ENV)?.[0]?.tabId).toBe("launched");
    expect(launches()).toEqual([]);

    cancelTabLaunchFocus(ENV, leaf);
    expect(leaf.store(tabLaunchStore).getState().launches.get(ENV)?.[0]?.focused).toBe(false);
    focusTabLaunch(ENV, "launched", leaf);
    expect(leaf.store(tabLaunchStore).getState().launches.get(ENV)?.[0]?.focused).toBe(true);
  });

  test("claims are held per scope", () => {
    expect(claimTabLaunch("run", ENV, leaf)).not.toBeNull();

    expect(claimTabLaunch("run", ENV, leaf)).toBeNull();
    expect(claimTabLaunch("run", ENV)).not.toBeNull();
  });

  test("disposing a scope clears its timers", () => {
    const cleared = spyOn(globalThis, "clearTimeout");
    const launch = beginTabLaunch(ENV, { tabId: "launched", title: "Run", surface: "agent" }, leaf);
    launch.settled("launched");
    claimTabLaunch("run", ENV, leaf)?.();
    const timersBefore = cleared.mock.calls.length;

    leaf.dispose();

    // The arrival grace timer and the claim's double-press timer.
    expect(cleared.mock.calls.length - timersBefore).toBe(2);
  });
});
