import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { BrowserTab } from "./BrowserTab";

const happyDOM = (window as unknown as Window & {
  happyDOM: {
    abort: () => Promise<void>;
    settings: { disableIframePageLoading: boolean };
  };
}).happyDOM;
const originalDisableIframePageLoading = happyDOM.settings.disableIframePageLoading;
let consoleErrorSpy: ReturnType<typeof spyOn> | undefined;

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
  afterAll(() => {
    happyDOM.settings.disableIframePageLoading = originalDisableIframePageLoading;
  });

  afterEach(async () => {
    cleanup();
    await happyDOM.abort();
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = undefined;
  });

  beforeEach(() => {
    cleanup();
    happyDOM.settings.disableIframePageLoading = true;
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => undefined);
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

  test("keeps remote preview documents in an opaque sandbox", () => {
    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };
    setBrowserTab("http://localhost:3000/");
    const { container } = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/" }}
        isActive
      />,
    );

    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe(
      "https://workstation.tailnet.ts.net/__orkestrator/browser/loopback/3000/",
    );
    const sandbox = iframe?.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(sandbox).not.toContain("allow-popups");
    expect(sandbox).not.toContain("allow-downloads");
  });

  test("moves backward and forward through browser history", () => {
    const { container } = render(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "" }} isActive />,
    );
    const address = screen.getByLabelText("Browser address");
    fireEvent.change(address, { target: { value: "3000" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    fireEvent.change(address, { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:4000/");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:3000/");
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:4000/");
  });

  test("reloads once for each refresh request and does not double-load later navigation", async () => {
    setBrowserTab("http://localhost:3000/");
    const view = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/" }}
        isActive
        refreshRequestId={0}
      />,
    );
    const initialIframe = view.container.querySelector("iframe");
    view.rerender(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/" }}
        isActive
        refreshRequestId={1}
      />,
    );
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBe(initialIframe));

    fireEvent.change(screen.getByLabelText("Browser address"), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => {
      expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:4000/");
    });
    expect(view.container.querySelector("iframe")?.dataset.loadRevision).toBe("2");
  });

  test("rehydrates an externally changed address and resets local history", () => {
    setBrowserTab("http://localhost:3000/");
    const view = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/" }}
        isActive
      />,
    );
    view.rerender(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:4000/external" }}
        isActive
      />,
    );
    expect((screen.getByLabelText("Browser address") as HTMLInputElement).value).toBe(
      "http://localhost:4000/external",
    );
    expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe(
      "http://localhost:4000/external",
    );
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
  });

  test("reloads through the toolbar button without duplicating history", () => {
    setBrowserTab("http://localhost:3000/");
    const { container } = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/" }}
        isActive
      />,
    );

    expect(container.querySelector("iframe")?.dataset.loadRevision).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Reload preview" }));
    expect(container.querySelector("iframe")?.dataset.loadRevision).toBe("1");
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:3000/");
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
  });

  test("resubmitting the current address reloads in place", () => {
    setBrowserTab("http://localhost:3000/");
    const { container } = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(container.querySelector("iframe")?.dataset.loadRevision).toBe("1");
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Forward" }).hasAttribute("disabled")).toBe(true);
  });

  test("explains that web-client sessions cannot host previews", () => {
    window.orkestratorGateway = {
      enabled: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };
    setBrowserTab("http://localhost:3000/");
    const { container } = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/" }}
        isActive
      />,
    );

    expect(container.querySelector("iframe")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByRole("alert").textContent).toContain("desktop app");
  });

  test("clears loading state when the iframe reports a load", () => {
    setBrowserTab("http://localhost:3000/");
    const { container } = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/" }}
        isActive
      />,
    );
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.load(container.querySelector("iframe") as HTMLIFrameElement);
    expect(container.querySelector(".animate-spin")).toBeNull();
  });
});
