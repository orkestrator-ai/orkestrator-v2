import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { BrowserTab } from "./BrowserTab";

const happyDOM = (window as unknown as Window & {
  happyDOM: {
    abort: () => Promise<void>;
    setURL(url: string): void;
    settings: { disableIframePageLoading: boolean };
  };
}).happyDOM;
const originalDisableIframePageLoading = happyDOM.settings.disableIframePageLoading;
const originalHref = window.location.href;
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
    happyDOM.setURL(originalHref);
    delete window.orkestratorGateway;
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

  test("reflows its toolbar against the pane width and clamps horizontal overflow", () => {
    const { container } = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "" }}
        isActive
      />,
    );

    const root = container.firstElementChild as HTMLElement;
    const toolbar = root.firstElementChild as HTMLElement;
    const form = screen.getByRole("textbox", { name: "Browser address" }).closest("form");
    const backendLabel = screen.getByText("Backend");

    expect(root.className).toContain("@container/browser");
    expect(root.className).toContain("overflow-hidden");
    expect(toolbar.className).toContain("flex-wrap");
    expect(toolbar.className).toContain("@md/browser:flex-nowrap");
    expect(form?.className).toContain("basis-full");
    expect(form?.className).toContain("@md/browser:flex-1");
    expect(backendLabel?.className).toContain("@lg/browser:flex");
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

    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toContain("allow-same-origin");
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe?.className).toContain("[color-scheme:dark]");
    expect(iframe?.className).toContain("min-w-0");
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
    expect(iframe?.hasAttribute("referrerpolicy")).toBe(false);
  });

  test("refuses to preview the app's own origin", () => {
    happyDOM.setURL("http://127.0.0.1:5173/");
    const { container } = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "" }}
        isActive
      />,
    );

    fireEvent.change(screen.getByLabelText("Browser address"), { target: { value: "localhost:5173" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(screen.getByRole("alert").textContent).toContain("Orkestrator app itself");
    expect(container.querySelector("iframe")).toBeNull();
  });

  test("stays mounted but hidden while another tab is active", () => {
    setBrowserTab("http://localhost:3000/");
    const { container } = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/" }}
        isActive={false}
      />,
    );

    expect(container.firstElementChild?.className).toContain("hidden");
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:3000/");
  });

  test("renders non-Error resolution failures as text", () => {
    render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "" }}
        isActive
      />,
    );
    Object.defineProperty(window, "orkestratorGateway", {
      configurable: true,
      get() {
        throw "gateway probe failed";
      },
    });

    fireEvent.change(screen.getByLabelText("Browser address"), { target: { value: "3000" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(screen.getByRole("alert").textContent).toBe("gateway probe failed");
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

  test("discards forward history when navigating after moving back", () => {
    const { container } = render(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "" }} isActive />,
    );
    const address = screen.getByLabelText("Browser address");
    for (const port of ["3000", "4000"]) {
      fireEvent.change(address, { target: { value: port } });
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
    }

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.change(address, { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:5000/");
    expect(screen.getByRole("button", { name: "Forward" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:3000/");
  });

  test("preserves history and loading state when local persistence echoes back", () => {
    const view = render(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "" }} isActive />,
    );
    const address = screen.getByLabelText("Browser address");
    for (const port of ["3000", "4000"]) {
      fireEvent.change(address, { target: { value: port } });
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
    }
    expect(view.container.querySelector(".animate-spin")).not.toBeNull();

    view.rerender(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:4000/" }}
        isActive
      />,
    );

    expect(view.container.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:3000/");
  });

  test("clears an invalid-address error after a valid navigation", () => {
    const { container } = render(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "" }} isActive />,
    );
    const address = screen.getByLabelText("Browser address");
    fireEvent.change(address, { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByRole("alert")).toBeDefined();
    expect(address.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(address, { target: { value: "3000" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(address.getAttribute("aria-invalid")).toBe("false");
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("http://localhost:3000/");
  });

  test("clears an invalid-address error after an external address update", () => {
    const view = render(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "" }} isActive />,
    );
    fireEvent.change(screen.getByLabelText("Browser address"), { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByRole("alert")).toBeDefined();

    view.rerender(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:4000/external" }}
        isActive
      />,
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Browser address").getAttribute("aria-invalid")).toBe("false");
    expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe(
      "http://localhost:4000/external",
    );
  });

  test("ignores refresh requests while the address is empty", () => {
    const view = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "" }}
        isActive
        refreshRequestId={0}
      />,
    );
    view.rerender(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "" }}
        isActive
        refreshRequestId={1}
      />,
    );

    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.querySelector(".animate-spin")).toBeNull();
    for (const name of ["Back", "Forward", "Reload preview"]) {
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
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
