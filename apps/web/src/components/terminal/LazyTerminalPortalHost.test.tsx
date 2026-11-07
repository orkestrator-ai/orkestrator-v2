import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import type { PaneLeaf, TabInfo } from "@/types/paneLayout";
import * as realTerminalPortalHost from "./TerminalPortalHost";
import { appCommandStore } from "@/test/app-command-store";

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

const ORIGINAL_STATE = appCommandStore(paneLayoutStore).getState();

function setTabs(environmentId: string, tabs: Array<Pick<TabInfo, "id" | "type">>): void {
  const root = {
    kind: "leaf",
    id: "default",
    tabs,
    activeTabId: tabs[0]?.id ?? null,
  } as PaneLeaf;
  const environments = new Map(appCommandStore(paneLayoutStore).getState().environments);
  environments.set(environmentId, { root, activePaneId: "default" } as never);
  act(() => appCommandStore(paneLayoutStore).setState({ environments }));
}

/** Long enough for a lazy import that was started to settle and commit. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("LazyTerminalPortalHost", () => {
  beforeEach(() => {
    appCommandStore(paneLayoutStore).setState({ environments: new Map() });
  });

  afterEach(() => {
    cleanup();
    appCommandStore(paneLayoutStore).setState(ORIGINAL_STATE, true);
  });

  test("does not load the host for an environment with only agent tabs", async () => {
    setTabs("env-1", [{ id: "agent", type: "agent-native" }]);
    render(<LazyTerminalPortalHost containerId={null} environmentId="env-1" />);
    await settle();
    expect(screen.queryByTestId("loaded-host") === null).toBe(true);
  });

  test("ignores a terminal tab in another environment", async () => {
    setTabs("env-other", [{ id: "shell", type: "plain" }]);
    render(<LazyTerminalPortalHost containerId={null} environmentId="env-1" />);
    await settle();
    expect(screen.queryByTestId("loaded-host") === null).toBe(true);
  });

  test("loads the host when the environment gains a terminal tab", async () => {
    render(<LazyTerminalPortalHost containerId={null} environmentId="env-1" />);
    await settle();
    expect(screen.queryByTestId("loaded-host") === null).toBe(true);

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
