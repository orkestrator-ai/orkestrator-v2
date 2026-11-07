import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
const state = appCommandStore(paneLayoutStore).getState();
import * as realLoaders from "@/lib/lazy-view-loaders";
import { appCommandStore } from "@/test/app-command-store";
const snapshot = { ...realLoaders };
const rejectImport = mock(async () => {
  throw new Error("Failed to fetch dynamically imported module");
});
mock.module("@/lib/lazy-view-loaders", () => ({
  ...snapshot,
  loadTerminalPortalHost: rejectImport,
}));
const { LazyTerminalPortalHost } = await import("./LazyTerminalPortalHost");
afterAll(() => mock.module("@/lib/lazy-view-loaders", () => snapshot));
afterEach(() => {
  cleanup();
  appCommandStore(paneLayoutStore).setState(state, true);
});
test("failed host import is contained in the inline fallback", async () => {
  appCommandStore(paneLayoutStore).setState({
    environments: new Map([
      [
        "env",
        {
          root: {
            kind: "leaf",
            id: "pane",
            tabs: [{ id: "shell", type: "plain" }],
            activeTabId: "shell",
          },
          activePaneId: "pane",
        } as never,
      ],
    ]),
  });
  render(
    <main>
      <nav>Shell</nav>
      <LazyTerminalPortalHost environmentId="env" containerId={null} />
    </main>,
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("This part of the app failed to load")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry view" }) === null).toBe(true);
  expect(rejectImport).toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Reload application" })).toBeTruthy();
  expect(screen.getByText("Shell")).toBeTruthy();
});
