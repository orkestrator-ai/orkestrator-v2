import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { BrowserPreviewState } from "@orkestrator/protocol/browser-preview";
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
const originalOrkestrator = window.orkestrator;
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

function previewState(overrides: Partial<BrowserPreviewState> = {}): BrowserPreviewState {
  return {
    tabId: "browser-1",
    url: "http://localhost:3000/",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    ...overrides,
  };
}

function installNativePreview(overrides: Record<string, unknown> = {}) {
  let stateListener: ((state: BrowserPreviewState) => void) | undefined;
  let focusAddressListener: ((tabId: string) => void) | undefined;
  const unsubscribe = mock(() => {});
  const state = previewState();
  const browserPreview = {
    attach: mock(async (input: { url: string }) => previewState({ url: input.url })),
    setBounds: mock(async () => state),
    setVisible: mock(async () => state),
    navigate: mock(async (_tabId: string, url: string) => previewState({ url })),
    goBack: mock(async () => previewState()),
    goForward: mock(async () => previewState()),
    reload: mock(async () => previewState()),
    openDevTools: mock(async () => previewState()),
    destroy: mock(async () => {}),
    ...overrides,
  };
  window.orkestrator = {
    listen: (event: string, callback: (payload: unknown) => void) => {
      if (event === "browser-preview-state") {
        stateListener = callback as (state: BrowserPreviewState) => void;
      }
      if (event === "browser-preview-focus-address") {
        focusAddressListener = callback as (tabId: string) => void;
      }
      return () => {
        unsubscribe();
        if (event === "browser-preview-state" && stateListener === callback) {
          stateListener = undefined;
        }
        if (event === "browser-preview-focus-address" && focusAddressListener === callback) {
          focusAddressListener = undefined;
        }
      };
    },
    browserPreview,
  } as never;
  return {
    browserPreview,
    emitState: (next: BrowserPreviewState) => stateListener?.(next),
    focusAddress: (tabId: string) => focusAddressListener?.(tabId),
    unsubscribe,
  };
}

describe("BrowserTab", () => {
  afterAll(() => {
    happyDOM.settings.disableIframePageLoading = originalDisableIframePageLoading;
  });

  afterEach(async () => {
    cleanup();
    await happyDOM.abort();
    happyDOM.setURL(originalHref);
    window.orkestrator = originalOrkestrator;
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

  test("focuses and selects the address with Cmd+L or Ctrl+L only while active", () => {
    const view = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/docs" }}
        isActive
      />,
    );
    const address = screen.getByRole("textbox", { name: "Browser address" }) as HTMLInputElement;

    const commandEvent = new KeyboardEvent("keydown", {
      key: "l",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(commandEvent);
    expect(commandEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(address);
    expect(address.selectionStart).toBe(0);
    expect(address.selectionEnd).toBe(address.value.length);

    address.blur();
    const controlEvent = new KeyboardEvent("keydown", {
      key: "L",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(controlEvent);
    expect(controlEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(address);

    for (const modifiers of [
      { metaKey: true, altKey: true },
      { ctrlKey: true, shiftKey: true },
    ]) {
      address.blur();
      const ignoredEvent = new KeyboardEvent("keydown", {
        key: "l",
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      window.dispatchEvent(ignoredEvent);
      expect(ignoredEvent.defaultPrevented).toBe(false);
      expect(document.activeElement).not.toBe(address);
    }

    address.blur();
    view.rerender(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/docs" }}
        isActive={false}
      />,
    );
    const inactiveEvent = new KeyboardEvent("keydown", {
      key: "l",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(inactiveEvent);
    expect(inactiveEvent.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(address);
  });

  test("focuses the browser address in the focused pane when two previews are visible", () => {
    usePaneLayoutStore.setState({
      activeEnvironmentId: "env-1",
      environments: new Map([
        ["env-1", {
          root: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            sizes: [50, 50],
            depth: 1,
            children: [
              {
                kind: "leaf",
                id: "pane-left",
                tabs: [{ id: "browser-left", type: "browser", browserData: { url: "http://localhost:3000/" } }],
                activeTabId: "browser-left",
              },
              {
                kind: "leaf",
                id: "pane-right",
                tabs: [{ id: "browser-right", type: "browser", browserData: { url: "http://localhost:4000/" } }],
                activeTabId: "browser-right",
              },
            ],
          },
          activePaneId: "pane-right",
          containerId: "container-1",
        }],
      ]),
    });

    render(
      <>
        <BrowserTab
          tabId="browser-left"
          environmentId="env-1"
          data={{ url: "http://localhost:3000/" }}
          isActive
        />
        <BrowserTab
          tabId="browser-right"
          environmentId="env-1"
          data={{ url: "http://localhost:4000/" }}
          isActive
        />
      </>,
    );
    const addresses = screen.getAllByRole("textbox", { name: "Browser address" });

    fireEvent.keyDown(window, { key: "l", metaKey: true });

    expect(document.activeElement).toBe(addresses[1]!);
  });

  test("focuses the active address bar when Cmd+L comes from its native preview", () => {
    const native = installNativePreview();
    const view = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/docs" }}
        isActive
      />,
    );
    const address = screen.getByRole("textbox", { name: "Browser address" }) as HTMLInputElement;

    native.focusAddress("another-browser");
    expect(document.activeElement).not.toBe(address);
    native.focusAddress("browser-1");
    expect(document.activeElement).toBe(address);
    expect(address.selectionStart).toBe(0);
    expect(address.selectionEnd).toBe(address.value.length);

    address.blur();
    view.rerender(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/docs" }}
        isActive={false}
      />,
    );
    native.focusAddress("browser-1");
    expect(document.activeElement).not.toBe(address);
  });

  test("activates the owning pane when Cmd+L comes from a native preview", () => {
    usePaneLayoutStore.setState({
      activeEnvironmentId: "env-1",
      environments: new Map([
        ["env-1", {
          root: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            sizes: [50, 50],
            depth: 1,
            children: [
              {
                kind: "leaf",
                id: "pane-left",
                tabs: [{ id: "browser-left", type: "browser", browserData: { url: "http://localhost:3000/" } }],
                activeTabId: "browser-left",
              },
              {
                kind: "leaf",
                id: "pane-right",
                tabs: [{ id: "browser-right", type: "browser", browserData: { url: "http://localhost:4000/" } }],
                activeTabId: "browser-right",
              },
            ],
          },
          activePaneId: "pane-right",
          containerId: "container-1",
        }],
      ]),
    });
    const native = installNativePreview();

    render(
      <BrowserTab
        tabId="browser-left"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/" }}
        isActive
      />,
    );
    const address = screen.getByRole("textbox", { name: "Browser address" }) as HTMLInputElement;

    native.focusAddress("browser-left");

    expect(document.activeElement).toBe(address);
    expect(address.selectionStart).toBe(0);
    expect(address.selectionEnd).toBe(address.value.length);
    expect(
      usePaneLayoutStore.getState().environments.get("env-1")?.activePaneId,
    ).toBe("pane-left");
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

  test("uses an isolated native surface and opens DevTools for that preview in Electron", async () => {
    const state = {
      tabId: "browser-1",
      url: "http://localhost:3000/",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
    };
    const attach = mock(async () => state);
    const openDevTools = mock(async () => state);
    const setVisible = mock(async () => state);
    window.orkestrator = {
      listen: () => () => {},
      browserPreview: {
        attach,
        setBounds: async () => state,
        setVisible,
        navigate: async () => state,
        goBack: async () => state,
        goForward: async () => state,
        reload: async () => state,
        openDevTools,
        destroy: async () => {},
      },
    } as never;
    setBrowserTab("http://localhost:3000/");

    const { container } = render(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/" }}
        isActive
      />,
    );

    await waitFor(() => expect(attach).toHaveBeenCalled());
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector('[data-native-browser-preview="browser-1"]')).not.toBeNull();
    const devToolsButton = screen.getByRole("button", { name: "Open preview DevTools" });
    await waitFor(() => expect(devToolsButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(devToolsButton);
    await waitFor(() => expect(openDevTools).toHaveBeenCalledWith("browser-1"));
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

  test("rehydrates native state events, maps gateway URLs, and ignores other tabs and scopes", async () => {
    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };
    const native = installNativePreview({
      attach: mock(async (input: { url: string }) =>
        previewState({
          url: input.url,
          loading: input.url.includes("/docs"),
        })),
    });
    setBrowserTab("http://localhost:3000/");
    const view = render(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "http://localhost:3000/" }} isActive />,
    );
    await waitFor(() => expect(native.browserPreview.attach).toHaveBeenCalled());
    await waitFor(() => expect(view.container.querySelector(".animate-spin")).toBeNull());

    native.emitState(previewState({
      tabId: "browser-other",
      url: "https://workstation.tailnet.ts.net/__orkestrator/browser/loopback/3000/ignored",
      error: "ignored error",
    }));
    native.emitState(previewState({
      url: "https://workstation.tailnet.ts.net/__orkestrator/browser/loopback/4000/wrong-scope",
    }));
    expect((screen.getByLabelText("Browser address") as HTMLInputElement).value).toBe("http://localhost:3000/");
    expect(screen.queryByRole("alert")).toBeNull();

    native.emitState(previewState({ url: "", loading: true, error: "empty URL state" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("empty URL state"));
    expect((screen.getByLabelText("Browser address") as HTMLInputElement).value).toBe("http://localhost:3000/");
    expect(view.container.querySelector(".animate-spin")).not.toBeNull();
    native.emitState(previewState({ url: "not a URL" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect((screen.getByLabelText("Browser address") as HTMLInputElement).value).toBe("http://localhost:3000/");

    native.emitState(previewState({
      url: "https://workstation.tailnet.ts.net/__orkestrator/browser/loopback/3000/docs?q=1#intro",
      loading: true,
      canGoBack: true,
      canGoForward: true,
    }));
    await waitFor(() => {
      expect((screen.getByLabelText("Browser address") as HTMLInputElement).value).toBe(
        "http://localhost:3000/docs?q=1#intro",
      );
      expect(view.container.querySelector(".animate-spin")).not.toBeNull();
    });
    native.emitState(previewState({
      url: "https://workstation.tailnet.ts.net/__orkestrator/browser/loopback/3000/docs?q=1#intro",
      canGoBack: true,
      canGoForward: true,
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Forward" }).hasAttribute("disabled")).toBe(false);
    const environment = usePaneLayoutStore.getState().environments.get("env-1");
    if (!environment || environment.root.kind !== "leaf") throw new Error("expected leaf");
    expect(environment.root.tabs[0]?.browserData?.url).toBe("http://localhost:3000/docs?q=1#intro");

    native.emitState(previewState({
      url: "https://workstation.tailnet.ts.net/__orkestrator/browser/loopback/3000/docs?q=1#intro",
      error: "native load failed",
    }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("native load failed"));
    expect(view.container.querySelector(".animate-spin")).toBeNull();
  });

  test("routes native navigation, history, reload, and refresh actions and reports rejections", async () => {
    const navigate = mock(async (_tabId: string, url: string) => previewState({ url }));
    const rejectedBack = mock(async () => { throw new Error("history failed"); });
    const native = installNativePreview({ navigate, goBack: rejectedBack });
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
    await waitFor(() => expect(native.browserPreview.attach).toHaveBeenCalled());
    native.emitState(previewState({ canGoBack: true, canGoForward: true }));

    fireEvent.change(screen.getByLabelText("Browser address"), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("browser-1", "http://localhost:4000/"));

    native.emitState(previewState({ url: "http://localhost:4000/", canGoBack: true, canGoForward: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("history failed"));
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload preview" }));
    await waitFor(() => {
      expect(rejectedBack).toHaveBeenCalledWith("browser-1");
      expect(native.browserPreview.goForward).toHaveBeenCalledWith("browser-1");
      expect(native.browserPreview.reload).toHaveBeenCalledWith("browser-1");
    });

    view.rerender(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:4000/" }}
        isActive
        refreshRequestId={1}
      />,
    );
    await waitFor(() => expect(native.browserPreview.reload.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  test("reports native navigation, forward, toolbar reload, and refresh reload failures", async () => {
    let attachCount = 0;
    const attach = mock((input: { url: string }) => {
      attachCount += 1;
      if (attachCount === 1) return Promise.resolve(previewState({ url: input.url }));
      return new Promise<BrowserPreviewState>(() => {});
    });
    const navigate = mock(async () => { throw "navigation failed"; });
    const goForward = mock(async () => { throw new Error("forward failed"); });
    const reload = mock()
      .mockRejectedValueOnce(new Error("toolbar reload failed"))
      .mockRejectedValueOnce("refresh reload failed");
    const native = installNativePreview({ attach, navigate, goForward, reload });
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
    await waitFor(() => expect(attach).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Browser address"), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("navigation failed"));
    expect(navigate).toHaveBeenCalledWith("browser-1", "http://localhost:4000/");

    native.emitState(previewState({ url: "http://localhost:4000/", canGoForward: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Forward" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("forward failed"));
    expect(goForward).toHaveBeenCalledWith("browser-1");

    fireEvent.click(screen.getByRole("button", { name: "Reload preview" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("toolbar reload failed"));
    expect(reload).toHaveBeenCalledTimes(1);

    view.rerender(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:4000/" }}
        isActive
        refreshRequestId={1}
      />,
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("refresh reload failed"));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  test("hides the native preview when no valid preview host can be rendered", async () => {
    const native = installNativePreview();
    const view = render(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "" }} isActive />,
    );
    await waitFor(() => expect(native.browserPreview.setVisible).toHaveBeenCalledWith("browser-1", false));
    expect(view.container.querySelector('[data-native-browser-preview="browser-1"]')).toBeNull();

    view.rerender(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "not a preview address" }} isActive />,
    );
    await waitFor(() => expect(native.browserPreview.setVisible.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(view.container.querySelector('[data-native-browser-preview="browser-1"]')).toBeNull();
    expect(native.browserPreview.attach).not.toHaveBeenCalled();
  });

  test("synchronizes native bounds and visibility across resize, scroll, overlays, and activation", async () => {
    const native = installNativePreview();
    setBrowserTab("http://localhost:3000/");
    let view = render(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "http://localhost:3000/" }} isActive />,
    );
    const host = view.container.querySelector('[data-native-browser-preview="browser-1"]') as HTMLDivElement;
    host.getBoundingClientRect = () => ({
      x: 11, y: 22, left: 11, top: 22, right: 344, bottom: 266, width: 333, height: 244,
      toJSON: () => ({}),
    });
    fireEvent(window, new Event("resize"));
    fireEvent.scroll(window);
    await waitFor(() => expect(native.browserPreview.attach).toHaveBeenCalledWith(expect.objectContaining({
      tabId: "browser-1",
      bounds: { x: 11, y: 22, width: 333, height: 244 },
      visible: true,
    })));

    view.unmount();
    native.browserPreview.attach.mockClear();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    view = render(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "http://localhost:3000/" }} isActive />,
    );
    await waitFor(() => expect(native.browserPreview.attach).toHaveBeenCalledWith(expect.objectContaining({ visible: false })));
    view.unmount();
    dialog.remove();

    view = render(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "http://localhost:3000/" }} isActive={false} />,
    );
    await waitFor(() => expect(native.browserPreview.attach).toHaveBeenCalledWith(expect.objectContaining({ visible: false })));
    view.rerender(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "http://localhost:3000/" }} isActive />,
    );
    await waitFor(() => expect(native.browserPreview.attach).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true })));
    view.unmount();
    expect(native.unsubscribe).toHaveBeenCalled();
    expect(native.browserPreview.setVisible).toHaveBeenCalledWith("browser-1", false);
  });

  test("handles attach and DevTools failures and ignores a disposed attach completion", async () => {
    let resolveAttach: ((state: BrowserPreviewState) => void) | undefined;
    const attach = mock(() => new Promise<BrowserPreviewState>((resolve) => { resolveAttach = resolve; }));
    const openDevTools = mock(async () => { throw "DevTools failed"; });
    const native = installNativePreview({ attach, openDevTools });
    setBrowserTab("http://localhost:3000/");
    const view = render(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "http://localhost:3000/" }} isActive />,
    );
    expect(screen.getByRole("button", { name: "Open preview DevTools" }).hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(attach).toHaveBeenCalled());
    resolveAttach?.(previewState());
    await waitFor(() => expect(screen.getByRole("button", { name: "Open preview DevTools" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Open preview DevTools" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("DevTools failed"));

    let resolveDisposed: ((state: BrowserPreviewState) => void) | undefined;
    native.browserPreview.attach = mock(() => new Promise<BrowserPreviewState>((resolve) => { resolveDisposed = resolve; }));
    view.rerender(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "http://localhost:4000/" }} isActive />,
    );
    await waitFor(() => expect(native.browserPreview.attach).toHaveBeenCalled());
    view.unmount();
    resolveDisposed?.(previewState({ error: "late attach error" }));
    await Promise.resolve();
    expect(screen.queryByText("late attach error")).toBeNull();
  });

  test("reports a native attach rejection", async () => {
    installNativePreview({ attach: mock(async () => { throw new Error("attach failed"); }) });
    setBrowserTab("http://localhost:3000/");
    render(<BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "http://localhost:3000/" }} isActive />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("attach failed"));
  });
});
