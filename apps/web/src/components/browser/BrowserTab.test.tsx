import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { parsePreviewTabTarget } from "@orkestrator/protocol/preview-services";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { environmentStore } from "@/stores/environmentStore";
import { nativeComposeStore } from "@/stores/nativeComposeStore";
import type { BrowserPreviewState } from "@orkestrator/protocol/browser-preview";
import { resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import { mockToastError, mockToastSuccess } from "../../../../../tests/mocks/sonner";
import { BrowserTab } from "./BrowserTab";
import { appCommandStore } from "@/test/app-command-store";

const happyDOM = (
  window as unknown as Window & {
    happyDOM: {
      abort: () => Promise<void>;
      setURL(url: string): void;
      settings: { disableIframePageLoading: boolean };
    };
  }
).happyDOM;
const originalDisableIframePageLoading = happyDOM.settings.disableIframePageLoading;
const originalHref = window.location.href;
const originalOrkestrator = window.orkestrator;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;
const originalClientPlatform = window.__orkestratorClientPlatform;
let consoleErrorSpy: ReturnType<typeof spyOn> | undefined;
let nextAnimationFrameId = 0;
const pendingAnimationFrames = new Set<number>();

function setBrowserTab(url = "", includeNativeAgent = false) {
  appCommandStore(paneLayoutStore).setState({
    activeEnvironmentId: "env-1",
    environments: new Map([
      [
        "env-1",
        {
          root: {
            kind: "leaf",
            id: "pane-1",
            tabs: [
              { id: "browser-1", type: "browser", browserData: { url } },
              ...(includeNativeAgent
                ? [
                    {
                      id: "agent-1",
                      type: "agent-native" as const,
                      nativeAgentData: { environmentId: "env-1", platform: "codex" as const },
                    },
                  ]
                : []),
            ],
            activeTabId: "browser-1",
          },
          activePaneId: "pane-1",
          containerId: "container-1",
        },
      ],
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

/**
 * The narrow-pane toolbar contract, asserted by class because happy-dom cannot
 * measure (keep in step with `ServiceBrowserTab.test.tsx`). One row only from
 * `@2xl` (672 px). Below it, so at the 519 px pane of an 800×600 window, the
 * buttons share the first row and the address form takes a full-width second
 * row. On one row the address keeps at least min(10rem, 60%).
 */
function expectBrowserToolbarLayout(toolbar: HTMLElement) {
  const classes = (element: Element | null | undefined) => element?.className.split(/\s+/) ?? [];
  const input = toolbar.querySelector('input[aria-label="Browser address"]');
  const form = input?.closest("form");
  const actions = form?.nextElementSibling;
  expect(classes(toolbar)).toEqual(
    expect.arrayContaining(["flex-wrap", "@2xl/browser:flex-nowrap"]),
  );
  expect(toolbar.className).not.toMatch(/@(md|lg|xl)\/browser:flex-nowrap/);
  expect(form?.parentElement).toBe(toolbar);
  expect(classes(form)).toEqual(
    expect.arrayContaining([
      "order-last",
      "w-full",
      "basis-full",
      "@2xl/browser:order-none",
      "@2xl/browser:basis-0",
      "@2xl/browser:flex-1",
    ]),
  );
  expect(classes(input)).toEqual(expect.arrayContaining(["min-w-[min(10rem,60%)]", "flex-1"]));
  expect(classes(input)).not.toContain("min-w-0");
  // Everything after the form is one right-aligned group on the button row.
  expect(actions?.nextElementSibling ?? null).toBeNull();
  expect(classes(actions)).toEqual(expect.arrayContaining(["ml-auto", "shrink-0"]));
  expect(actions?.querySelector('button[aria-label^="Annotations"]')).not.toBeNull();
}

function installNativePreview(overrides: Record<string, unknown> = {}) {
  let stateListener: ((state: BrowserPreviewState) => void) | undefined;
  let focusAddressListener: ((tabId: string) => void) | undefined;
  const unsubscribe = mock(() => {});
  const state = previewState();
  const browserPreview = {
    attach: mock(async () => state),
    setBounds: mock(async () => state),
    setVisible: mock(async () => state),
    goBack: mock(async () => previewState()),
    goForward: mock(async () => previewState()),
    reload: mock(async () => previewState()),
    openDevTools: mock(async () => previewState()),
    destroy: mock(async () => {}),
    ...overrides,
  };
  window.orkestrator = {
    invoke: mock(async (command: string, args?: Record<string, unknown>) => {
      if (command === "write_container_file") return args?.filePath;
      if (command === "write_local_file") return `/workspace/${String(args?.filePath ?? "")}`;
      return undefined;
    }),
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
    emitState: (next: BrowserPreviewState) => {
      act(() => stateListener?.(next));
    },
    focusAddress: (tabId: string) => {
      act(() => focusAddressListener?.(tabId));
    },
    unsubscribe,
  };
}

describe("BrowserTab", () => {
  beforeAll(() => {
    // Native preview attachment is intentionally deferred to the next frame in
    // production. Drive that boundary with microtasks here so this file does
    // not depend on wall-clock frame delivery while the parallel suite is
    // competing for the event loop.
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      const id = ++nextAnimationFrameId;
      pendingAnimationFrames.add(id);
      queueMicrotask(() => {
        if (!pendingAnimationFrames.delete(id)) return;
        callback(performance.now());
      });
      return id;
    };
    window.cancelAnimationFrame = (id: number) => {
      pendingAnimationFrames.delete(id);
    };
  });

  afterAll(() => {
    pendingAnimationFrames.clear();
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    happyDOM.settings.disableIframePageLoading = originalDisableIframePageLoading;
  });

  afterEach(async () => {
    cleanup();
    await happyDOM.abort();
    happyDOM.setURL(originalHref);
    window.orkestrator = originalOrkestrator;
    window.__orkestratorClientPlatform = originalClientPlatform;
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
    appCommandStore(environmentStore).setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Browser test",
          order: 0,
          setupPhase: "ready",
          containerId: "container-1",
        } as never,
      ],
    });
    appCommandStore(nativeComposeStore).setState({ drafts: new Map() });
    resetWebAnnotationSyncForTests();
    mockToastError.mockClear();
    mockToastSuccess.mockClear();
  });

  test("starts with backend-specific guidance and no iframe", () => {
    const { container } = renderInAppCommandScope(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "" }} isActive />,
    );

    expect(screen.getByText("Preview a backend service")).toBeDefined();
    expect(screen.getByPlaceholderText("localhost:3000")).toBeDefined();
    expect(container.querySelector("iframe") === null).toBe(true);
  });

  test("wraps its address onto its own row in narrow panes and clamps horizontal overflow", () => {
    const { container } = renderInAppCommandScope(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "" }} isActive />,
    );

    const root = container.firstElementChild as HTMLElement;
    const toolbar = root.firstElementChild as HTMLElement;
    expect(root.className).toContain("@container/browser");
    expect(root.className).toContain("overflow-hidden");
    expectBrowserToolbarLayout(toolbar);
  });

  test("focuses and selects the address with Cmd+L or Ctrl+L only while active", () => {
    const view = renderInAppCommandScope(
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
    appCommandStore(paneLayoutStore).setState({
      activeEnvironmentId: "env-1",
      environments: new Map([
        [
          "env-1",
          {
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
                  tabs: [
                    {
                      id: "browser-left",
                      type: "browser",
                      browserData: { url: "http://localhost:3000/" },
                    },
                  ],
                  activeTabId: "browser-left",
                },
                {
                  kind: "leaf",
                  id: "pane-right",
                  tabs: [
                    {
                      id: "browser-right",
                      type: "browser",
                      browserData: { url: "http://localhost:4000/" },
                    },
                  ],
                  activeTabId: "browser-right",
                },
              ],
            },
            activePaneId: "pane-right",
            containerId: "container-1",
          },
        ],
      ]),
    });

    renderInAppCommandScope(
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
    const view = renderInAppCommandScope(
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
    appCommandStore(paneLayoutStore).setState({
      activeEnvironmentId: "env-1",
      environments: new Map([
        [
          "env-1",
          {
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
                  tabs: [
                    {
                      id: "browser-left",
                      type: "browser",
                      browserData: { url: "http://localhost:3000/" },
                    },
                  ],
                  activeTabId: "browser-left",
                },
                {
                  kind: "leaf",
                  id: "pane-right",
                  tabs: [
                    {
                      id: "browser-right",
                      type: "browser",
                      browserData: { url: "http://localhost:4000/" },
                    },
                  ],
                  activeTabId: "browser-right",
                },
              ],
            },
            activePaneId: "pane-right",
            containerId: "container-1",
          },
        ],
      ]),
    });
    const native = installNativePreview();

    renderInAppCommandScope(
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
      appCommandStore(paneLayoutStore).getState().environments.get("env-1")?.activePaneId,
    ).toBe("pane-left");
  });

  test("stays mounted but hidden while another tab is active, and attaches no view", () => {
    setBrowserTab("http://localhost:3000/");
    const native = installNativePreview();
    const { container } = renderInAppCommandScope(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/" }}
        isActive={false}
      />,
    );

    expect(container.firstElementChild?.className).toContain("hidden");
    expect(container.querySelector("iframe") === null).toBe(true);
    expect(native.browserPreview.attach).not.toHaveBeenCalled();
  });

  test("a saved address shows where it opens instead of loading it in the app", () => {
    setBrowserTab("http://localhost:3000/docs");
    const native = installNativePreview();
    const { container } = renderInAppCommandScope(
      <BrowserTab
        tabId="browser-1"
        environmentId="env-1"
        data={{ url: "http://localhost:3000/docs" }}
        isActive
      />,
    );

    expect(screen.getByRole("heading", { name: "http://localhost:3000/docs" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Open in browser" })).toBeDefined();
    expect(container.querySelector("iframe") === null).toBe(true);
    expect(container.querySelector("[data-native-browser-preview]") === null).toBe(true);
    expect(native.browserPreview.attach).not.toHaveBeenCalled();
  });

  test("a submitted address becomes an address-bar intent for this environment", async () => {
    setBrowserTab("");
    renderInAppCommandScope(
      <BrowserTab tabId="browser-1" environmentId="env-1" data={{ url: "" }} isActive />,
    );
    const address = screen.getByRole("textbox", { name: "Browser address" });
    fireEvent.change(address, { target: { value: "localhost:5173/app" } });
    fireEvent.submit(address.closest("form")!);

    await waitFor(() => {
      const leaf = appCommandStore(paneLayoutStore).getState().environments.get("env-1")?.root as {
        tabs: { id: string; browserData?: { url: string } }[];
      };
      expect(parsePreviewTabTarget(leaf.tabs[0]!.browserData!.url)).toEqual({
        kind: "intent",
        environmentId: "env-1",
        source: "address-bar",
        url: "localhost:5173/app",
      });
    });
  });
});
