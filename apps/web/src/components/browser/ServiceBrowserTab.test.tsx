import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BrowserPreviewState } from "@orkestrator/protocol/browser-preview";
import {
  FIXTURE_BACKEND_INSTANCE_ID,
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_SERVICE_ID,
  fixturePreviewCapabilities,
  fixturePreviewService,
  fixturePreviewSnapshot,
} from "@orkestrator/protocol/testing/preview-contract-fixtures";
import {
  formatPreviewIntentUri,
  formatPreviewServiceUri,
  parsePreviewTabTarget,
  previewError,
} from "@orkestrator/protocol/preview-services";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { resetPreviewServiceSyncForTests } from "@/stores/previewServiceStore";
import { resetWebAnnotationSyncForTests } from "@/lib/web-annotations/sync";
import { FakeWebAnnotationBackend } from "@/test/web-annotation-fakes";
import type { BrowserTabData } from "@/types/paneLayout";
import { BrowserTab } from "./BrowserTab";
import { createPersistedPaneLayoutInput } from "@/lib/pane-layout-persistence";
import { reconcilePersistedLayout } from "@/lib/pane-layout-restore";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
const originalOrkestrator = window.orkestrator;
const originalRaf = window.requestAnimationFrame;
const originalCancelRaf = window.cancelAnimationFrame;
const API_SERVICE_ID = "svc_fixture_api_0002";

function tabUrl(): string {
  const layout = usePaneLayoutStore.getState().environments.get(FIXTURE_ENVIRONMENT_ID)!;
  return (layout.root as { tabs: Array<{ browserData?: { url: string } }> }).tabs[0]!.browserData!
    .url;
}

function seedTab(url: string) {
  usePaneLayoutStore.setState({
    activeEnvironmentId: FIXTURE_ENVIRONMENT_ID,
    hydration: new Map([[FIXTURE_ENVIRONMENT_ID, "done"]]),
    environments: new Map([
      [
        FIXTURE_ENVIRONMENT_ID,
        {
          root: {
            kind: "leaf",
            id: "pane-1",
            tabs: [{ id: "browser-1", type: "browser", browserData: { url } }],
            activeTabId: "browser-1",
          },
          activePaneId: "pane-1",
          containerId: "container-1",
        },
      ],
    ]),
  });
}

function renderTab() {
  const Harness = () => {
    const browserData = usePaneLayoutStore((state) => {
      const layout = state.environments.get(FIXTURE_ENVIRONMENT_ID);
      return (layout?.root as { tabs: Array<{ browserData?: BrowserTabData }> } | undefined)
        ?.tabs[0]?.browserData;
    });
    return (
      <BrowserTab
        tabId="browser-1"
        environmentId={FIXTURE_ENVIRONMENT_ID}
        data={browserData ?? { url: "" }}
        isActive
      />
    );
  };
  return render(<Harness />);
}

interface Backend {
  capabilities: ReturnType<typeof fixturePreviewCapabilities> | null;
  services: ReturnType<typeof fixturePreviewService>[];
  resolution?: unknown;
}

function installBackend(backend: Backend, native = true) {
  let stateListener: ((state: BrowserPreviewState) => void) | undefined;
  let focusAddressListener: ((tabId: string) => void) | undefined;
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "get_preview_capabilities":
        if (!backend.capabilities)
          throw new Error("Unknown backend command: get_preview_capabilities");
        return backend.capabilities;
      case "get_preview_services":
        return fixturePreviewSnapshot(backend.services);
      case "resolve_preview_target":
        return backend.resolution;
      case "probe_preview_service":
        return backend.services[0];
      case "start_environment_background":
        return undefined;
      case "register_preview_service":
        return {
          kind: "definition",
          replayed: false,
          definition: fixturePreviewService({
            definition: {
              serviceId: "svc_registered_0003",
              applicationPort: (args.service as { applicationPort: number }).applicationPort,
            },
          }).definition,
        };
      default:
        return undefined;
    }
  });
  const browserPreview = {
    attach: mock(
      async (input: {
        tabId: string;
        url?: string;
        navigationBasis?: number;
        service?: {
          backendInstanceId?: string;
          environmentId?: string;
          serviceId: string;
          path: string;
        };
      }): Promise<BrowserPreviewState> => ({
        tabId: input.tabId,
        url: input.url ?? `http://127.0.0.1:41000${input.service?.path ?? "/"}`,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
        ...(input.service
          ? {
              service: {
                serviceId: input.service.serviceId,
                path: input.service.path,
                displayUrl: `http://localhost:3000${input.service.path}`,
              },
              transport: { mode: "desktop-tunnel" as const, state: "ready" as const },
            }
          : {}),
      }),
    ),
    setVisible: mock(async () => null),
    setBounds: mock(async () => null),
    reload: mock(async () => null),
    resetServiceSiteData: mock(async () => undefined),
  };
  window.orkestrator = {
    invoke: invokeMock,
    listen: (event: string, callback: (payload: unknown) => void) => {
      if (event === "browser-preview-state")
        stateListener = callback as (state: BrowserPreviewState) => void;
      if (event === "browser-preview-focus-address") {
        focusAddressListener = callback as (tabId: string) => void;
        return () => {
          if (focusAddressListener === callback) focusAddressListener = undefined;
        };
      }
      return () => undefined;
    },
    ...(native ? { browserPreview } : {}),
  } as never;
  return {
    browserPreview,
    emitState: (state: BrowserPreviewState) => act(() => stateListener?.(state)),
    /** Main's Cmd/Ctrl+L from inside a native preview view. */
    focusAddress: (tabId: string) => act(() => focusAddressListener?.(tabId)),
  };
}

const serviceUri = (path = "/", serviceId = FIXTURE_SERVICE_ID) =>
  formatPreviewServiceUri({
    backendInstanceId: FIXTURE_BACKEND_INSTANCE_ID,
    environmentId: FIXTURE_ENVIRONMENT_ID,
    serviceId,
    path,
  });

describe("service browser tabs", () => {
  beforeAll(() => {
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(performance.now()));
      return 1;
    };
    window.cancelAnimationFrame = () => undefined;
  });
  afterAll(() => {
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancelRaf;
  });
  beforeEach(() => {
    resetPreviewServiceSyncForTests();
    resetWebAnnotationSyncForTests();
    useEnvironmentStore.setState({
      environments: [
        {
          id: FIXTURE_ENVIRONMENT_ID,
          projectId: "p",
          name: "env",
          order: 0,
          environmentType: "containerized",
          containerId: "container-1",
          status: "running",
        } as never,
      ],
    });
  });
  afterEach(() => {
    cleanup();
    window.orkestrator = originalOrkestrator;
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("Show any process confirms with the current revision then probes and refreshes", async () => {
    const waiting = fixturePreviewService({
      definition: {
        targetKind: "worktree",
        provenance: "entry-port",
        userOverride: false,
        definitionRevision: 7,
      },
    });
    waiting.endpoint = {
      ...waiting.endpoint,
      state: "unavailable",
      listener: "unattributed",
      failure: previewError("target-unverified", { retryable: true }),
    };
    installBackend({ capabilities: fixturePreviewCapabilities(), services: [waiting] });
    seedTab(serviceUri("/"));
    renderTab();
    const button = await screen.findByRole("button", { name: "Show any process" });
    invokeMock.mockClear();
    fireEvent.click(button);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "update_preview_service",
        expect.objectContaining({ serviceId: FIXTURE_SERVICE_ID, expectedRevision: 7, patch: {} }),
      ),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("probe_preview_service", {
        serviceId: FIXTURE_SERVICE_ID,
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "get_preview_services",
        expect.objectContaining({ environmentId: FIXTURE_ENVIRONMENT_ID }),
      ),
    );
    const commands = invokeMock.mock.calls.map((call) => call[0]);
    expect(commands.indexOf("update_preview_service")).toBeLessThan(
      commands.indexOf("probe_preview_service"),
    );
    expect(commands.indexOf("probe_preview_service")).toBeLessThan(
      commands.lastIndexOf("get_preview_services"),
    );
  });

  test("attaches the service reference through the desktop tunnel and persists in-page navigation", async () => {
    const { browserPreview, emitState } = installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [fixturePreviewService()],
    });
    seedTab(serviceUri("/start"));
    renderTab();
    await waitFor(() => expect(browserPreview.attach).toHaveBeenCalled());
    const input = browserPreview.attach.mock.calls.at(-1)![0];
    expect(input.url).toBeUndefined();
    expect(input.service).toEqual({
      backendInstanceId: FIXTURE_BACKEND_INSTANCE_ID,
      environmentId: FIXTURE_ENVIRONMENT_ID,
      serviceId: FIXTURE_SERVICE_ID,
      path: "/start",
    });
    expect((screen.getByLabelText("Browser address") as HTMLInputElement).value).toBe(
      "http://localhost:3000/start",
    );

    emitState({
      tabId: "browser-1",
      url: "http://127.0.0.1:41000/next?x=1",
      loading: false,
      canGoBack: true,
      canGoForward: false,
      error: null,
      service: {
        serviceId: FIXTURE_SERVICE_ID,
        path: "/next?x=1",
        displayUrl: "http://localhost:3000/next?x=1",
      },
    });
    await waitFor(() => expect(tabUrl()).toBe(serviceUri("/next?x=1")));
    // The runtime transport URL never reaches the persisted tab.
    expect(tabUrl()).not.toContain("127.0.0.1");
  });

  test("attaches each path with the view navigation it was chosen against", async () => {
    const { browserPreview, emitState } = installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [fixturePreviewService()],
    });
    seedTab(serviceUri("/start"));
    renderTab();
    await waitFor(() => expect(browserPreview.attach).toHaveBeenCalled());
    // Nothing reported yet: older-main behaviour, no basis.
    expect(browserPreview.attach.mock.calls.at(-1)![0]).not.toHaveProperty("navigationBasis");

    // The page navigated itself: its path is followed with that navigation's basis.
    emitState({
      tabId: "browser-1",
      url: "http://127.0.0.1:41000/next",
      loading: false,
      canGoBack: true,
      canGoForward: false,
      error: null,
      service: {
        serviceId: FIXTURE_SERVICE_ID,
        path: "/next",
        displayUrl: "http://localhost:3000/next",
        navigation: 3,
      },
    });
    await waitFor(() =>
      expect(browserPreview.attach.mock.calls.at(-1)![0]).toMatchObject({
        service: { path: "/next" },
        navigationBasis: 3,
      }),
    );

    // A path the user asks for is chosen against the latest navigation seen.
    const address = screen.getByLabelText("Browser address") as HTMLInputElement;
    fireEvent.change(address, { target: { value: "/typed" } });
    fireEvent.submit(address.closest("form")!);
    await waitFor(() =>
      expect(browserPreview.attach.mock.calls.at(-1)![0]).toMatchObject({
        service: { path: "/typed" },
        navigationBasis: 3,
      }),
    );
  });

  function savedLayout() {
    return createPersistedPaneLayoutInput(
      usePaneLayoutStore.getState().environments.get(FIXTURE_ENVIRONMENT_ID)!,
    );
  }

  function applyLayout(input: ReturnType<typeof savedLayout>, revision: number) {
    // Exercise the save/restore boundary: request identity must survive it.
    const restored = reconcilePersistedLayout(
      { ...input, environmentId: FIXTURE_ENVIRONMENT_ID, revision, updatedAt: "2026-10-18" },
      { environmentId: FIXTURE_ENVIRONMENT_ID, containerId: "container-1", isLocal: false },
    )!;
    act(() =>
      usePaneLayoutStore.getState().applyAuthoritativeLayout(FIXTURE_ENVIRONMENT_ID, restored),
    );
  }

  function viewState(path: string, navigation?: number): BrowserPreviewState {
    return {
      tabId: "browser-1",
      url: `http://127.0.0.1:41000${path}`,
      loading: false,
      canGoBack: true,
      canGoForward: false,
      error: null,
      service: {
        serviceId: FIXTURE_SERVICE_ID,
        path,
        displayUrl: `http://localhost:3000${path}`,
        ...(navigation === undefined ? {} : { navigation }),
      },
    };
  }

  test("a newer cross-client request for an earlier path wins while its old acknowledgement stays stale", async () => {
    const { browserPreview, emitState } = installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [fixturePreviewService()],
    });
    seedTab(serviceUri("/start"));
    renderTab();
    await waitFor(() => expect(browserPreview.attach).toHaveBeenCalled());
    let currentPath = "/a";
    let navigation = 3;
    browserPreview.attach.mockImplementation(async (input) => {
      if ((input.navigationBasis ?? 0) >= navigation) currentPath = input.service!.path;
      return viewState(currentPath, navigation);
    });
    emitState(viewState("/a", 3));
    await waitFor(() => expect(tabUrl()).toBe(serviceUri("/a")));
    const oldAcknowledgement = savedLayout();
    currentPath = "/b";
    navigation = 4;
    emitState(viewState("/b", 4));
    await waitFor(() => expect(tabUrl()).toBe(serviceUri("/b")));

    applyLayout(oldAcknowledgement, 1);
    await waitFor(() =>
      expect(browserPreview.attach.mock.calls.at(-1)![0]).toMatchObject({
        service: { path: "/b" },
        navigationBasis: 4,
      }),
    );
    expect(
      browserPreview.attach.mock.calls.some(
        ([input]) => input.service?.path === "/a" && input.navigationBasis === 3,
      ),
    ).toBe(true);
    expect(currentPath).toBe("/b");
    expect(tabUrl()).toBe(serviceUri("/b"));

    const remote = savedLayout();
    if (remote.root.kind !== "leaf") throw new Error("Expected a leaf");
    remote.root.tabs[0]!.browserData = {
      url: serviceUri("/a"),
      navigationRequestId: "another-client-request",
    };
    applyLayout(remote, 2);
    await waitFor(() => expect(currentPath).toBe("/a"));
    expect(browserPreview.attach.mock.calls.at(-1)![0]).toMatchObject({
      service: { path: "/a" },
      navigationBasis: 4,
    });
    expect(tabUrl()).toBe(serviceUri("/a"));
    currentPath = "/c";
    navigation = 5;
    emitState(viewState("/c", 5));
    await waitFor(() => expect(tabUrl()).toBe(serviceUri("/c")));
    applyLayout(oldAcknowledgement, 3);
    await waitFor(() => expect(tabUrl()).toBe(serviceUri("/c")));
    expect(currentPath).toBe("/c");
  });

  test("an evicted local write remains stale after more than 32 persisted navigations", async () => {
    const { browserPreview, emitState } = installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [fixturePreviewService()],
    });
    seedTab(serviceUri("/start"));
    renderTab();
    await waitFor(() => expect(browserPreview.attach).toHaveBeenCalled());
    emitState(viewState("/first", 1));
    const oldest = savedLayout();
    for (let navigation = 2; navigation <= 34; navigation++) {
      emitState(viewState(`/page-${navigation}`, navigation));
    }
    await waitFor(() => expect(tabUrl()).toBe(serviceUri("/page-34")));
    applyLayout(oldest, 1);
    await waitFor(() =>
      expect(browserPreview.attach.mock.calls.at(-1)![0]).toMatchObject({
        service: { path: "/first" },
        navigationBasis: 0,
      }),
    );
  });

  test("a local write made before any navigation event falls back to basis zero on acknowledgement", async () => {
    const { browserPreview, emitState } = installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [fixturePreviewService()],
    });
    seedTab(serviceUri("/start"));
    renderTab();
    await waitFor(() => expect(browserPreview.attach).toHaveBeenCalled());
    const address = screen.getByLabelText("Browser address");
    fireEvent.change(address, { target: { value: "/early" } });
    fireEvent.submit(address.closest("form")!);
    await waitFor(() => expect(tabUrl()).toBe(serviceUri("/early")));
    const early = savedLayout();
    emitState(viewState("/later", 5));
    await waitFor(() => expect(tabUrl()).toBe(serviceUri("/later")));
    applyLayout(early, 1);
    await waitFor(() =>
      expect(browserPreview.attach.mock.calls.at(-1)![0]).toMatchObject({
        service: { path: "/early" },
        navigationBasis: 0,
      }),
    );
  });

  test("counts notes for the logical service route and opens a note's page only on request", async () => {
    installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [fixturePreviewService()],
    });
    const annotations = new FakeWebAnnotationBackend(FIXTURE_ENVIRONMENT_ID);
    const page = {
      service: { kind: "service" as const, serviceId: FIXTURE_SERVICE_ID },
      route: "/start",
      displayUrl: "http://localhost:3000/start",
      title: "Start",
      requiresNavigation: false,
    };
    annotations.seed({ id: "annotation-here", title: "On this page", page });
    annotations.seed({
      id: "annotation-there",
      title: "Elsewhere",
      page: { ...page, route: "/billing", displayUrl: "http://localhost:3000/billing" },
    });
    const previewCommands = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) =>
      command.startsWith("web_annotation")
        ? annotations.handle(command, args)
        : previewCommands(command, args),
    );
    seedTab(serviceUri("/start"));
    renderTab();
    fireEvent.click(
      await screen.findByRole("button", { name: "Annotations, 1 open on this page" }),
    );
    fireEvent.change(await screen.findByRole("combobox", { name: "Pages" }), {
      target: { value: "all" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open note: Elsewhere" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show “Elsewhere” on the page" }));
    const open = await screen.findByRole("button", { name: "Open that page" });
    // Opening a thread never navigated the preview.
    expect(tabUrl()).toBe(serviceUri("/start"));
    fireEvent.click(open);
    await waitFor(() => expect(tabUrl()).toBe(serviceUri("/billing")));
  });

  test("a late state from the previous service's view is not persisted for the new one", async () => {
    const api = fixturePreviewService({
      definition: { serviceId: API_SERVICE_ID, applicationPort: 8000, label: "api", entry: false },
    });
    const { browserPreview, emitState } = installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [fixturePreviewService(), api],
    });
    seedTab(serviceUri("/start"));
    renderTab();
    await waitFor(() => expect(browserPreview.attach).toHaveBeenCalled());
    act(() =>
      usePaneLayoutStore
        .getState()
        .updateTabBrowserUrl(
          "browser-1",
          serviceUri("/", API_SERVICE_ID),
          FIXTURE_ENVIRONMENT_ID,
          [],
          -1,
        ),
    );
    await waitFor(() =>
      expect(browserPreview.attach.mock.calls.at(-1)![0].service?.serviceId).toBe(API_SERVICE_ID),
    );

    emitState({
      tabId: "browser-1",
      url: "http://127.0.0.1:41000/stale",
      loading: false,
      canGoBack: true,
      canGoForward: false,
      error: null,
      service: {
        serviceId: FIXTURE_SERVICE_ID,
        path: "/stale",
        displayUrl: "http://localhost:3000/stale",
      },
    });
    await Bun.sleep(5);
    expect(tabUrl()).toBe(serviceUri("/", API_SERVICE_ID));
    expect((screen.getByLabelText("Browser address") as HTMLInputElement).value).not.toContain(
      "/stale",
    );
  });

  test("compatibility mode follows the service's current host port", async () => {
    const service = fixturePreviewService();
    service.endpoint.hostPort = 49999;
    const { browserPreview } = installBackend({
      capabilities: fixturePreviewCapabilities({
        surfaces: {
          ...fixturePreviewCapabilities().surfaces,
          desktopTunnel: { available: false, reason: "disabled", upstreamSchemes: ["http"] },
        },
      }),
      services: [service],
    });
    seedTab(serviceUri("/a"));
    renderTab();
    await waitFor(() => expect(browserPreview.attach).toHaveBeenCalled());
    expect(browserPreview.attach.mock.calls.at(-1)![0].url).toBe("http://localhost:49999/a");
    expect(screen.getByText("Compatibility mode")).toBeTruthy();
  });

  test("a stopped environment explains itself and offers to start it", async () => {
    const service = fixturePreviewService();
    service.endpoint = {
      ...service.endpoint,
      state: "unavailable",
      hostPort: null,
      failure: previewError("environment-stopped"),
    };
    const { browserPreview } = installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [service],
    });
    seedTab(serviceUri());
    renderTab();
    const start = await screen.findByRole("button", { name: "Start environment" });
    expect(browserPreview.attach).not.toHaveBeenCalled();
    fireEvent.click(start);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("start_environment_background", {
        environmentId: FIXTURE_ENVIRONMENT_ID,
      }),
    );
  });

  test("the address bar navigates by path within the service", async () => {
    installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [fixturePreviewService()],
    });
    seedTab(serviceUri());
    renderTab();
    const input = (await screen.findByLabelText("Browser address")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("http://localhost:3000/"));
    fireEvent.change(input, { target: { value: "/settings?tab=2" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(tabUrl()).toBe(serviceUri("/settings?tab=2")));
  });

  test("Cmd/Ctrl+L from the app or from inside the native view focuses and selects the address", async () => {
    const { focusAddress } = installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [fixturePreviewService()],
    });
    seedTab(serviceUri());
    renderTab();
    const input = (await screen.findByLabelText("Browser address")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("http://localhost:3000/"));
    const selected = () =>
      document.activeElement === input &&
      input.selectionStart === 0 &&
      input.selectionEnd === input.value.length;

    fireEvent.keyDown(window, { key: "l", metaKey: true });
    expect(selected()).toBe(true);
    input.blur();
    fireEvent.keyDown(window, { key: "L", ctrlKey: true, shiftKey: true });
    expect(document.activeElement).not.toBe(input);

    focusAddress("another-tab");
    expect(document.activeElement).not.toBe(input);
    focusAddress("browser-1");
    expect(selected()).toBe(true);
  });

  test("closing the service dialog returns focus to the menu trigger it was opened from", async () => {
    installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [fixturePreviewService()],
    });
    seedTab(serviceUri());
    renderTab();
    await screen.findByLabelText("Browser address");
    for (const [trigger, item, title] of [
      [/^Preview service /, /Register a service/, "Register preview service"],
      [/^Preview options$/, /Edit service/, "Edit preview service"],
    ] as const) {
      const button = await screen.findByRole("button", { name: trigger });
      button.focus();
      fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole("menuitem", { name: item }));
      const dialog = await screen.findByRole("dialog", { name: title });
      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
      await waitFor(() => expect(document.activeElement).toBe(button));
    }
  });

  test("web clients get the top-level preview instead of an embedded frame", async () => {
    installBackend(
      {
        capabilities: fixturePreviewCapabilities({
          surfaces: {
            ...fixturePreviewCapabilities().surfaces,
            browserTopLevel: { available: true, upstreamSchemes: ["http", "https"] },
          },
        }),
        services: [fixturePreviewService()],
      },
      false,
    );
    seedTab(serviceUri());
    renderTab();
    expect(await screen.findByRole("button", { name: /Open web/ })).toBeTruthy();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  test("a container terminal intent binds to the matching service in its environment", async () => {
    const api = fixturePreviewService({
      definition: { serviceId: API_SERVICE_ID, applicationPort: 8000, label: "api", entry: false },
    });
    installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [fixturePreviewService(), api],
      resolution: { kind: "service", service: api, path: "/health" },
    });
    seedTab(
      formatPreviewIntentUri({
        environmentId: FIXTURE_ENVIRONMENT_ID,
        source: "container-terminal",
        url: "http://localhost:8000/health",
      }),
    );
    renderTab();
    await waitFor(() => expect(tabUrl()).toBe(serviceUri("/health", API_SERVICE_ID)));
    expect(invokeMock).toHaveBeenCalledWith("resolve_preview_target", {
      intent: {
        url: "http://localhost:8000/health",
        source: "container-terminal",
        environmentId: FIXTURE_ENVIRONMENT_ID,
      },
    });
  });

  test.each(["container-terminal", "agent-link"] as const)(
    "an unregistered container %s offers registration without a host fallback",
    async (source) => {
      installBackend({
        capabilities: fixturePreviewCapabilities(),
        services: [fixturePreviewService()],
        resolution: {
          kind: "unregistered",
          path: "/",
          bindHint: true,
          suggestion: { targetKind: "container", applicationPort: 4000, scheme: "http" },
        },
      });
      seedTab(
        formatPreviewIntentUri({
          environmentId: FIXTURE_ENVIRONMENT_ID,
          source,
          url: "http://0.0.0.0:4000/",
        }),
      );
      renderTab();
      const register = await screen.findByRole("button", { name: "Register port 4000" });
      expect(
        screen.queryByRole("button", { name: "Open as a temporary backend host port" }) === null,
      ).toBe(true);
      expect(screen.getByText(/0\.0\.0\.0, which is its bind address/)).toBeTruthy();
      expect(screen.getByText(/inside this environment's container/)).toBeTruthy();
      fireEvent.click(register);
      fireEvent.click(await screen.findByRole("button", { name: "Register" }));
      await waitFor(() =>
        expect(parsePreviewTabTarget(tabUrl())).toMatchObject({
          kind: "service",
          ref: { serviceId: "svc_registered_0003" },
        }),
      );
    },
  );

  test("an unregistered host terminal port offers a temporary backend host port and opens the original URL", async () => {
    useEnvironmentStore.setState((state) => ({
      environments: state.environments.map((environment) => ({
        ...environment,
        environmentType: "local",
        containerId: null,
      })),
    }));
    const { browserPreview } = installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [],
      resolution: {
        kind: "unregistered",
        path: "/health?check=1#status",
        bindHint: false,
        suggestion: { targetKind: "worktree", applicationPort: 4000, scheme: "http" },
      },
    });
    const url = "http://localhost:4000/health?check=1#status";
    const intentUri = formatPreviewIntentUri({
      environmentId: FIXTURE_ENVIRONMENT_ID,
      source: "worktree-terminal",
      url,
    });
    seedTab(intentUri);
    renderTab();

    const open = await screen.findByRole("button", {
      name: "Open as a temporary backend host port",
    });
    expect(tabUrl()).toBe(intentUri);
    expect(browserPreview.attach).not.toHaveBeenCalled();
    fireEvent.click(open);
    await waitFor(() => expect(tabUrl()).toBe(url));
    expect(invokeMock).toHaveBeenCalledWith("resolve_preview_target", {
      intent: { url, source: "worktree-terminal", environmentId: FIXTURE_ENVIRONMENT_ID },
    });
  });

  test("a dev server on the next free port is offered as a move of its service, never moved on its own", async () => {
    useEnvironmentStore.setState((state) => ({
      environments: state.environments.map((environment) => ({
        ...environment,
        environmentType: "local",
        containerId: null,
      })),
    }));
    const app = fixturePreviewService({
      definition: { label: "app", targetKind: "worktree", applicationPort: 3000 },
    });
    installBackend({
      capabilities: fixturePreviewCapabilities(),
      services: [app],
      resolution: {
        kind: "unregistered",
        path: "/",
        bindHint: false,
        suggestion: { targetKind: "worktree", applicationPort: 3001, scheme: "http" },
      },
    });
    seedTab(
      formatPreviewIntentUri({
        environmentId: FIXTURE_ENVIRONMENT_ID,
        source: "worktree-terminal",
        url: "http://localhost:3001/",
      }),
    );
    renderTab();

    const move = await screen.findByRole("button", { name: "Move app from port 3000 to 3001" });
    expect(invokeMock).not.toHaveBeenCalledWith("update_preview_service", expect.anything());
    fireEvent.click(move);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "update_preview_service",
        expect.objectContaining({
          serviceId: app.definition.serviceId,
          expectedRevision: app.definition.definitionRevision,
          patch: { applicationPort: 3001 },
        }),
      ),
    );
    await waitFor(() =>
      expect(parsePreviewTabTarget(tabUrl())).toMatchObject({
        kind: "service",
        ref: { serviceId: app.definition.serviceId },
      }),
    );
  });

  test("older backends keep the original link behaviour", async () => {
    installBackend({ capabilities: null, services: [] });
    seedTab(
      formatPreviewIntentUri({
        environmentId: FIXTURE_ENVIRONMENT_ID,
        source: "container-terminal",
        url: "http://localhost:3000/",
      }),
    );
    renderTab();
    await waitFor(() => expect(tabUrl()).toBe("http://localhost:3000/"));
  });

  test("a tab saved against another backend asks for a new service", async () => {
    const { browserPreview } = installBackend({
      capabilities: fixturePreviewCapabilities({ backendInstanceId: "bk_other_backend_01" }),
      services: [fixturePreviewService()],
    });
    seedTab(serviceUri());
    renderTab();
    expect(await screen.findByText("Different backend")).toBeTruthy();
    expect(browserPreview.attach).not.toHaveBeenCalled();
  });
});
