import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { PaneLeaf, TabInfo } from "@/types/paneLayout";
import * as realTerminalPortalHost from "./TerminalPortalHost";

const terminalPortalHostSnapshot = { ...realTerminalPortalHost };
mock.module("./TerminalPortalHost", () => ({
  TerminalPortalHost: ({ environmentId }: { environmentId: string }) => (
    <div data-testid="loaded-host">{environmentId}</div>
  ),
}));

const { LazyTerminalPortalHost } = await import("./LazyTerminalPortalHost");

afterAll(() => {
  mock.module("./TerminalPortalHost", () => terminalPortalHostSnapshot);
});

const ORIGINAL_STATE = usePaneLayoutStore.getState();

function setTabs(environmentId: string, tabs: Array<Pick<TabInfo, "id" | "type">>): void {
  const root = {
    kind: "leaf",
    id: "default",
    tabs,
    activeTabId: tabs[0]?.id ?? null,
  } as PaneLeaf;
  const environments = new Map(usePaneLayoutStore.getState().environments);
  environments.set(environmentId, { root, activePaneId: "default" } as never);
  act(() => usePaneLayoutStore.setState({ environments }));
}

/** Long enough for a lazy import that was started to settle and commit. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("LazyTerminalPortalHost", () => {
  beforeEach(() => {
    usePaneLayoutStore.setState({ environments: new Map() });
  });

  afterEach(() => {
    cleanup();
    usePaneLayoutStore.setState(ORIGINAL_STATE, true);
  });

  test("does not load the host for an environment with only agent tabs", async () => {
    setTabs("env-1", [{ id: "agent", type: "agent-native" }]);
    render(<LazyTerminalPortalHost containerId={null} environmentId="env-1" />);
    await settle();
    expect(screen.queryByTestId("loaded-host")).toBeNull();
  });

  test("ignores a terminal tab in another environment", async () => {
    setTabs("env-other", [{ id: "shell", type: "plain" }]);
    render(<LazyTerminalPortalHost containerId={null} environmentId="env-1" />);
    await settle();
    expect(screen.queryByTestId("loaded-host")).toBeNull();
  });

  test("loads the host when the environment gains a terminal tab", async () => {
    render(<LazyTerminalPortalHost containerId={null} environmentId="env-1" />);
    await settle();
    expect(screen.queryByTestId("loaded-host")).toBeNull();

    setTabs("env-1", [{ id: "shell", type: "plain" }]);
    expect((await screen.findByTestId("loaded-host")).textContent).toBe("env-1");
  });

  test("keeps the host mounted after the last terminal tab closes, so it can dispose terminals", async () => {
    setTabs("env-1", [{ id: "shell", type: "plain" }]);
    render(<LazyTerminalPortalHost containerId={null} environmentId="env-1" />);
    await screen.findByTestId("loaded-host");

    setTabs("env-1", []);
    await settle();
    expect(screen.queryByTestId("loaded-host")).not.toBeNull();
  });
});
