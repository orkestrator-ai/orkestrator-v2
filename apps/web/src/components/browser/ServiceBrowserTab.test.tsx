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
} from "@orkestrator/protocol/preview-contract-fixtures";
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
import { BrowserTab } from "./BrowserTab";

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
    const url = usePaneLayoutStore((state) => {
      const layout = state.environments.get(FIXTURE_ENVIRONMENT_ID);
      return (
        (layout?.root as { tabs: Array<{ browserData?: { url: string } }> } | undefined)?.tabs[0]
          ?.browserData?.url ?? ""
      );
    });
    return (
      <BrowserTab
        tabId="browser-1"
        environmentId={FIXTURE_ENVIRONMENT_ID}
        data={{ url }}
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
        service?: {
          backendInstanceId?: string;
          environmentId?: string;
          serviceId: string;
          path: string;
        };
      }) => ({
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
    cancelAnnotation: mock(async () => undefined),
    resetServiceSiteData: mock(async () => undefined),
  };
  window.orkestrator = {
    invoke: invokeMock,
    listen: (event: string, callback: (payload: unknown) => void) => {
      if (event === "browser-preview-state")
        stateListener = callback as (state: BrowserPreviewState) => void;
      return () => undefined;
    },
    ...(native ? { browserPreview } : {}),
  } as never;
  return {
    browserPreview,
    emitState: (state: BrowserPreviewState) => act(() => stateListener?.(state)),
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

  test("an unregistered container port offers registration, never a host-port guess", async () => {
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
        source: "container-terminal",
        url: "http://0.0.0.0:4000/",
      }),
    );
    renderTab();
    const register = await screen.findByRole("button", { name: "Register port 4000" });
    expect(screen.queryByRole("button", { name: "Open as a backend host port" }) === null).toBe(
      true,
    );
    expect(screen.getByText(/0\.0\.0\.0, which is its bind address/)).toBeTruthy();
    fireEvent.click(register);
    fireEvent.click(await screen.findByRole("button", { name: "Register" }));
    await waitFor(() =>
      expect(parsePreviewTabTarget(tabUrl())).toMatchObject({
        kind: "service",
        ref: { serviceId: "svc_registered_0003" },
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
