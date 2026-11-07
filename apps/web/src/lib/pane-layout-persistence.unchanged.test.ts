import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { environmentStore } from "@/stores/environmentStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import type { PersistedPaneLayout } from "@/types/paneLayout";
import {
  createPersistedPaneLayoutInput,
  startPaneLayoutPersistence,
} from "./pane-layout-persistence";
import { appCommandStore } from "@/test/app-command-store";

type LayoutInput = ReturnType<typeof createPersistedPaneLayoutInput>;

const waitForTimers = () => new Promise((resolve) => setTimeout(resolve, 20));

function saved(environmentId: string, input: LayoutInput): PersistedPaneLayout {
  return { ...input, environmentId, updatedAt: "2026-01-01T00:00:00.000Z", revision: 1 };
}

function hydrate(environmentId: string, tabId: string) {
  const store = appCommandStore(paneLayoutStore).getState();
  store.initialize(`container-${environmentId}`, environmentId);
  store.addTab("default", { id: tabId, type: "plain" }, environmentId);
  store.beginHydration(environmentId);
  store.finishHydration(environmentId);
}

/** Every serialisation that mentions `marker`, counted from here on. */
function countSerialisations(marker: string) {
  const stringify = spyOn(JSON, "stringify");
  return () =>
    stringify.mock.results.filter(
      (result) =>
        result.type === "return" &&
        typeof result.value === "string" &&
        result.value.includes(marker),
    ).length;
}

describe("pane layout persistence with unchanged environments", () => {
  beforeEach(() => {
    appCommandStore(environmentStore).setState({ environments: [] });
    appCommandStore(paneLayoutStore).setState({
      environments: new Map(),
      hydration: new Map(),
      activeEnvironmentId: null,
    });
  });
  afterEach(() => {
    mock.restore();
  });

  test("a write to one environment does not serialise another's layout", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      saved(environmentId, input),
    );
    hydrate("env-quiet", "quiet-tab-marker");
    hydrate("env-busy", "busy-tab");
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    try {
      const quietSerialisations = countSerialisations("quiet-tab-marker");
      const store = appCommandStore(paneLayoutStore).getState();
      for (let index = 0; index < 5; index += 1) {
        store.addTab("default", { id: `busy-${index}`, type: "plain" }, "env-busy");
      }
      await waitForTimers();

      expect(quietSerialisations()).toBe(0);
      // The environment that did change is still persisted, once, with its
      // latest layout.
      expect(save.mock.calls.map(([environmentId]) => environmentId)).toEqual(["env-busy"]);
      const tabIds = JSON.stringify(save.mock.calls[0]?.[1]);
      expect(tabIds).toContain("busy-4");
    } finally {
      stop();
    }
  });

  test("a write that leaves every environment object in place serialises nothing", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      saved(environmentId, input),
    );
    hydrate("env-1", "first-tab-marker");
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    try {
      const serialisations = countSerialisations("first-tab-marker");
      // A top-level field unrelated to any environment's layout.
      appCommandStore(paneLayoutStore).setState({ activeEnvironmentId: "env-1" });
      appCommandStore(paneLayoutStore).setState({ activeEnvironmentId: null });
      await waitForTimers();

      expect(serialisations()).toBe(0);
      expect(save).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  test("retries a failed save only after that environment changes", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      saved(environmentId, input),
    );
    save.mockImplementationOnce(async () => {
      throw new Error("save unavailable");
    });
    hydrate("env-retry", "original");
    hydrate("env-other", "other");
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    try {
      appCommandStore(paneLayoutStore)
        .getState()
        .addTab("default", { id: "unsaved", type: "plain" }, "env-retry");
      await waitForTimers();
      expect(save).toHaveBeenCalledTimes(1);
      const unchanged = appCommandStore(paneLayoutStore).getState().environments.get("env-retry");
      appCommandStore(paneLayoutStore)
        .getState()
        .addTab("default", { id: "unrelated", type: "plain" }, "env-other");
      await waitForTimers();
      expect(appCommandStore(paneLayoutStore).getState().environments.get("env-retry")).toBe(
        unchanged,
      );
      expect(save.mock.calls.filter(([id]) => id === "env-retry")).toHaveLength(1);
      appCommandStore(paneLayoutStore)
        .getState()
        .addTab("default", { id: "retry-trigger", type: "plain" }, "env-retry");
      await waitForTimers();
      const retries = save.mock.calls.filter(([id]) => id === "env-retry");
      expect(retries).toHaveLength(2);
      expect(JSON.stringify(retries[1]?.[1])).toContain("unsaved");
      expect(JSON.stringify(retries[1]?.[1])).toContain("retry-trigger");
    } finally {
      stop();
    }
  });

  test("completing hydration still primes the cache without echoing the snapshot", async () => {
    const save = mock(async (environmentId: string, input: LayoutInput) =>
      saved(environmentId, input),
    );
    const stop = startPaneLayoutPersistence({ save, debounceMs: 5 });
    try {
      const store = appCommandStore(paneLayoutStore).getState();
      store.initialize("container-env-1", "env-1");
      store.addTab("default", { id: "restored", type: "plain" }, "env-1");
      store.beginHydration("env-1");
      // Hydration finishing without changing the environment object must still
      // be seen as the transition it is.
      store.finishHydration("env-1");
      await waitForTimers();
      expect(save).not.toHaveBeenCalled();

      store.addTab("default", { id: "after-hydration", type: "plain" }, "env-1");
      await waitForTimers();
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});
