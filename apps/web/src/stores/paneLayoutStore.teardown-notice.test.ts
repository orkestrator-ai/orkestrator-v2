import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { toast } from "sonner";
import { TAB_TEARDOWN_BRIDGE_UPGRADE_REQUIRED_MARKER } from "@orkestrator/protocol/tab-teardown";
import type { TabInfo } from "@/types/paneLayout";

const teardownTab = mock(async (_input: unknown): Promise<unknown> => ({ completed: true }));

const realBackend = await import("@/lib/backend");
const realBackendSnapshot = { ...realBackend };

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  teardownTab,
}));

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const { usePaneLayoutStore } = await import("./paneLayoutStore");
const { tabTeardownBridgeUpgradeToastId } = await import("@/lib/tab-teardown-notice");

type ToastSpy = ReturnType<typeof spyOn>;
let toastSpies: ToastSpy[] = [];
let warningSpy: ToastSpy;
let consoleDebugSpy: ToastSpy;

function nativeTab(id: string, platform: string): TabInfo {
  return {
    id,
    type: "agent-native",
    nativeAgentData: { platform, environmentId: "env-old-bridge" },
  } as unknown as TabInfo;
}

function seedTabs(environmentId: string, tabs: TabInfo[]) {
  usePaneLayoutStore.setState({
    activeEnvironmentId: environmentId,
    environments: new Map([
      [
        environmentId,
        {
          containerId: null,
          activePaneId: "default",
          root: { kind: "leaf", id: "default", tabs, activeTabId: tabs[0]!.id },
        },
      ],
    ]),
  });
}

async function flushTeardownRejections() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  teardownTab.mockReset();
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  consoleDebugSpy = spyOn(console, "debug").mockImplementation(() => {});
  warningSpy = spyOn(toast, "warning").mockImplementation(() => "");
  toastSpies = [
    warningSpy,
    spyOn(toast, "info").mockImplementation(() => ""),
    spyOn(toast, "error").mockImplementation(() => ""),
    spyOn(toast, "success").mockImplementation(() => ""),
    spyOn(toast, "message").mockImplementation(() => ""),
  ];
});

afterEach(() => {
  for (const spy of toastSpies) spy.mockRestore();
  consoleDebugSpy.mockRestore();
});

describe("paneLayoutStore native teardown failure notice", () => {
  test("a bridge-upgrade-required rejection shows one deduplicated restart notice", async () => {
    teardownTab.mockImplementation(async () => {
      throw new Error(
        `Error invoking remote method: ${TAB_TEARDOWN_BRIDGE_UPGRADE_REQUIRED_MARKER} claude bridge predates close`,
      );
    });
    seedTabs("env-old-bridge", [nativeTab("claude-a", "claude"), nativeTab("claude-b", "claude")]);

    const store = usePaneLayoutStore.getState();
    store.removeTab("default", "claude-a", "env-old-bridge");
    store.removeTab("default", "claude-b", "env-old-bridge");
    await flushTeardownRejections();

    expect(teardownTab).toHaveBeenCalledTimes(2);
    expect(warningSpy).toHaveBeenCalledTimes(2);
    const expectedId = tabTeardownBridgeUpgradeToastId("env-old-bridge");
    expect(expectedId).toBe("tab-teardown-bridge-upgrade:env-old-bridge");
    const ids = warningSpy.mock.calls.map((call: unknown[]) => (call[1] as { id?: string }).id);
    // Same id on every call: sonner replaces the existing toast instead of stacking.
    expect(new Set(ids)).toEqual(new Set([expectedId]));
    const [title, options] = warningSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(title).toBe("Restart the environment to finish closing this tab");
    expect(options.description).toContain("conversation was kept");
    expect(options.description).toContain("retried");
    expect(typeof options.duration).toBe("number");
    expect(Number.isFinite(options.duration as number)).toBe(true);
    expect(options.action).toBeUndefined();
    expect(options.cancel).toBeUndefined();
  });

  test("an unrelated teardown rejection shows no toast", async () => {
    teardownTab.mockImplementation(async () => {
      throw new Error("backend teardown unavailable");
    });
    seedTabs("env-old-bridge", [nativeTab("codex-a", "codex"), nativeTab("pi-a", "pi")]);

    const store = usePaneLayoutStore.getState();
    store.removeTab("default", "codex-a", "env-old-bridge");
    store.removeTab("default", "pi-a", "env-old-bridge");
    await flushTeardownRejections();

    expect(teardownTab).toHaveBeenCalledTimes(2);
    for (const spy of toastSpies) expect(spy).not.toHaveBeenCalled();
    expect(consoleDebugSpy).toHaveBeenCalled();
  });
});
