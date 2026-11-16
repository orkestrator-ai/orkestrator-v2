import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { configureLogger } from "@orkestrator/protocol/logger";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { toast } from "sonner";
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

const { paneLayoutStore } = await import("./paneLayoutStore");
const { appCommandStore } = await import("@/test/app-command-store");

type ToastSpy = ReturnType<typeof spyOn>;
let toastSpies: ToastSpy[] = [];
let logs: LogCapture;

function nativeTab(id: string, platform: string): TabInfo {
  return {
    id,
    type: "agent-native",
    nativeAgentData: { platform, environmentId: "env-old-bridge" },
  } as unknown as TabInfo;
}

function seedTabs(environmentId: string, tabs: TabInfo[]) {
  appCommandStore(paneLayoutStore).setState({
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
  appCommandStore(paneLayoutStore).setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  logs = captureLogs();
  configureLogger({ level: "debug" });
  toastSpies = [
    spyOn(toast, "warning").mockImplementation(() => ""),
    spyOn(toast, "info").mockImplementation(() => ""),
    spyOn(toast, "error").mockImplementation(() => ""),
    spyOn(toast, "success").mockImplementation(() => ""),
    spyOn(toast, "message").mockImplementation(() => ""),
  ];
});

afterEach(() => {
  for (const spy of toastSpies) spy.mockRestore();
  logs.restore();
});

describe("paneLayoutStore native teardown failure notice", () => {
  test("a teardown rejection shows no toast and is logged as pending", async () => {
    teardownTab.mockImplementation(async () => {
      throw new Error("backend teardown unavailable");
    });
    seedTabs("env-old-bridge", [nativeTab("codex-a", "codex"), nativeTab("pi-a", "pi")]);

    const store = appCommandStore(paneLayoutStore).getState();
    store.removeTab("default", "codex-a", "env-old-bridge");
    store.removeTab("default", "pi-a", "env-old-bridge");
    await flushTeardownRejections();

    expect(teardownTab).toHaveBeenCalledTimes(2);
    for (const spy of toastSpies) expect(spy).not.toHaveBeenCalled();
    expect(logs.records()).toContainEqual(
      expect.objectContaining({
        level: "debug",
        area: "web.pane-layout",
        event: "teardown.pending",
        fields: expect.objectContaining({
          environmentId: "env-old-bridge",
          source: "Codex",
          error: expect.objectContaining({ message: "backend teardown unavailable" }),
        }),
      }),
    );
  });
});
