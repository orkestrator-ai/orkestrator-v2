import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { BrowserTab } from "./BrowserTab";

function setBrowserTab(url = "") {
  usePaneLayoutStore.setState({
    activeEnvironmentId: "env-1",
    environments: new Map([
      ["env-1", {
        root: {
          kind: "leaf",
          id: "pane-1",
          tabs: [{ id: "browser-1", type: "browser", browserData: { url } }],
          activeTabId: "browser-1",
        },
        activePaneId: "pane-1",
        containerId: "container-1",
      }],
    ]),
  });
}

describe("BrowserTab", () => {
  beforeEach(() => {
    cleanup();
    delete window.orkestratorGateway;
    setBrowserTab();
  });

  test("starts with backend-specific guidance and no iframe", () => {
    const { container } = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "" }}
        isActive
      />,
    );

    expect(screen.getByText("Preview a backend service")).toBeDefined();
    expect(screen.getByPlaceholderText("localhost:3000")).toBeDefined();
    expect(container.querySelector("iframe")).toBeNull();
  });

  test("normalizes, loads, and persists a submitted backend-local address", async () => {
    const { container } = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "" }}
        isActive
      />,
    );

    fireEvent.change(screen.getByLabelText("Browser address"), { target: { value: "3000" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    await waitFor(() => {
      const environment = usePaneLayoutStore.getState().environments.get("env-1");
      if (!environment || environment.root.kind !== "leaf") throw new Error("expected leaf");
      expect(environment.root.tabs[0]?.browserData?.url).toBe("http://localhost:3000/");
      expect(container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:3000/");
    });
  });

  test("keeps invalid addresses in the bar and explains the constraint", () => {
    render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "" }}
        isActive
      />,
    );

    fireEvent.change(screen.getByLabelText("Browser address"), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(screen.getByRole("alert").textContent).toContain("Use localhost or 127.0.0.1");
    expect((screen.getByLabelText("Browser address") as HTMLInputElement).value).toBe("example.com");
  });
});
