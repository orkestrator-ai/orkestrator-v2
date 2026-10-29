import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  TERMINAL_BROWSER_TAB_REQUEST_EVENT,
  type TerminalBrowserTabRequest,
} from "@/lib/terminal-links";
import { invoke } from "@/lib/native/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePreviewServiceStore } from "@/stores/previewServiceStore";
import type { Environment } from "@/types";
import type { PreviewCapabilities } from "@orkestrator/protocol/preview-services";
import { PreviewLinkSourceContext } from "./link-source-context";
import { MarkdownLink } from "./MessageMarkdown";

describe("agent loopback links", () => {
  const requests: TerminalBrowserTabRequest[] = [];
  const openExternal = mock(async (_url: string) => undefined);
  const record = (event: Event) =>
    requests.push((event as CustomEvent<TerminalBrowserTabRequest>).detail);
  const previousOrkestrator = window.orkestrator;
  const previousGateway = window.orkestratorGateway;
  const invokeMock = invoke as unknown as ReturnType<typeof mock>;
  const openService = mock(async () => undefined);

  beforeEach(() => {
    requests.length = 0;
    openService.mockClear();
    openExternal.mockClear();
    window.orkestrator = { shell: { openExternal } } as unknown as typeof window.orkestrator;
    window.addEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, record);
  });
  afterEach(() => {
    cleanup();
    window.removeEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, record);
    window.orkestrator = previousOrkestrator;
    window.orkestratorGateway = previousGateway;
    useEnvironmentStore.setState({ environments: [] });
    usePreviewServiceStore.setState({ status: "idle", capabilities: null });
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  function renderLink(href: string, source = true) {
    const link = <MarkdownLink href={href}>dev server</MarkdownLink>;
    render(
      source ? (
        <PreviewLinkSourceContext.Provider value={{ environmentId: "env-a", tabId: "agent-1" }}>
          {link}
        </PreviewLinkSourceContext.Provider>
      ) : (
        link
      ),
    );
    return screen.getByText("dev server");
  }

  test("⌘⇧-click opens a preview tab resolved in the agent's environment", () => {
    const link = renderLink("http://localhost:5173/app");
    expect(link.getAttribute("title")).toBe("⌘⇧-click (Ctrl+Shift-click) opens a preview tab");
    fireEvent.click(link, { metaKey: true, shiftKey: true });
    expect(requests).toEqual([
      {
        environmentId: "env-a",
        sourceTabId: "agent-1",
        url: "http://localhost:5173/app",
        origin: "agent",
      },
    ]);
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("a plain click keeps opening the system browser", () => {
    fireEvent.click(renderLink("http://localhost:5173/"));
    expect(requests).toEqual([]);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  for (const kind of ["service", "unregistered", "ambiguous"] as const) {
    test(`a remote plain click resolves ${kind} in the agent's environment`, async () => {
      window.orkestratorGateway = {
        enabled: true,
        desktop: true,
        baseUrl: "https://remote.tailnet.ts.net",
      };
      window.orkestrator = {
        ...window.orkestrator,
        browserPreview: { openServiceExternally: openService },
      } as unknown as typeof window.orkestrator;
      useEnvironmentStore.setState({
        environments: [{ id: "env-a", environmentType: "local" }] as unknown as Environment[],
      });
      usePreviewServiceStore.setState({
        status: "ready",
        capabilities: {
          backendInstanceId: "backend-instance-1",
          access: { available: true },
          surfaces: { desktopTunnel: { available: true }, browserTopLevel: { available: false } },
        } as PreviewCapabilities,
      });
      invokeMock.mockImplementation(async (command: string) =>
        command === "resolve_preview_target"
          ? {
              kind,
              service: { definition: { serviceId: "service-0000001" } },
              path: "/app",
            }
          : undefined,
      );
      fireEvent.click(renderLink("http://localhost:5173/app"));
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("resolve_preview_target", {
          intent: {
            url: "http://localhost:5173/app",
            environmentId: "env-a",
            source: "agent-link",
          },
        }),
      );
      if (kind === "service") {
        await waitFor(() =>
          expect(openService).toHaveBeenCalledWith({
            backendInstanceId: "backend-instance-1",
            environmentId: "env-a",
            serviceId: "service-0000001",
            path: "/app",
          }),
        );
        expect(requests).toEqual([]);
      } else {
        await waitFor(() =>
          expect(requests).toEqual([
            {
              environmentId: "env-a",
              sourceTabId: "agent-1",
              url: "http://localhost:5173/app",
              origin: "agent",
            },
          ]),
        );
        expect(openService).not.toHaveBeenCalled();
      }
      expect(openExternal).not.toHaveBeenCalled();
    });
  }

  test("non-loopback links and links outside an environment's agent tab are unchanged", () => {
    const remote = renderLink("https://example.com/");
    expect(remote.getAttribute("title")).toBeNull();
    fireEvent.click(remote, { metaKey: true, shiftKey: true });
    cleanup();
    const coordinator = renderLink("http://localhost:5173/", false);
    expect(coordinator.getAttribute("title")).toBeNull();
    fireEvent.click(coordinator, { ctrlKey: true, shiftKey: true });
    expect(requests).toEqual([]);
    expect(openExternal).toHaveBeenCalledTimes(2);
  });
});
