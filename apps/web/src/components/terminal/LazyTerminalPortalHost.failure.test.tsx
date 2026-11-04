import { lazy } from "react";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import * as realHost from "./TerminalPortalHost";
const snapshot = { ...realHost };
const state = usePaneLayoutStore.getState();
mock.module("./TerminalPortalHost", () => ({
  TerminalPortalHost: lazy(async () => {
    throw new Error("Failed to fetch dynamically imported module");
  }),
}));
const { LazyTerminalPortalHost } = await import("./LazyTerminalPortalHost");
afterAll(() => mock.module("./TerminalPortalHost", () => snapshot));
afterEach(() => {
  cleanup();
  usePaneLayoutStore.setState(state, true);
});
test("failed host import is contained in the inline fallback", async () => {
  usePaneLayoutStore.setState({
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
  expect(screen.getByRole("button", { name: "Reload application" })).toBeTruthy();
  expect(screen.getByText("Shell")).toBeTruthy();
});
