import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fixturePreviewCapabilities } from "@orkestrator/protocol/testing/preview-contract-fixtures";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";
import {
  resetPreviewServiceSyncForTests,
  usePreviewServiceStore,
} from "@/stores/previewServiceStore";
import { AccountMachineProvider } from "./account-machine";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { PreviewSettings } from "./PreviewSettings";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

const storedSettings = {
  version: 1,
  transport: true,
  relay: false,
  publication: {
    enabled: false,
    domain: null,
    certFile: null,
    keyFile: null,
    upstreamCaFile: null,
    listenAddress: null,
    port: null,
    publicPort: null,
  },
};

const diagnostics = {
  registry: { definitions: 0, available: 0, unavailable: 0 },
  access: { attachments: 0, resources: 0, pendingGrants: 0 },
  resolver: {},
  readiness: {},
  metrics: { counters: {}, histograms: {}, gauges: {} },
  settings: { transport: true, relay: false, publicationEnabled: false },
  publication: {
    enabled: false,
    available: false,
    reason: "Private preview publication is disabled.",
    domain: null,
    listening: null,
    certificate: null,
  },
  relay: { available: false },
};

function install(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) =>
    handlers[command]?.(args),
  );
}

describe("preview settings loading", () => {
  beforeEach(() => resetPreviewServiceSyncForTests());
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("a capabilities failure shows the error with a retry instead of spinning", async () => {
    let failing = true;
    install({
      get_preview_capabilities: () => {
        if (failing) throw new Error("Unauthorized");
        return fixturePreviewCapabilities();
      },
      get_preview_settings: () => ({ stored: storedSettings, effective: storedSettings }),
      get_preview_diagnostics: () => diagnostics,
    });
    render(<PreviewSettings />);
    expect(
      await screen.findByText(/Could not load preview settings: Preview services are unavailable/),
    ).toBeTruthy();
    expectDomAbsent(screen.queryByText("Loading preview settings…"), "loading spinner");

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("switch", { name: "Issue new preview access" })).toBeTruthy();
    expectDomAbsent(screen.queryByRole("alert"), "load error after retry");
  });

  test("a settings failure shows the error with a retry instead of spinning", async () => {
    let failing = true;
    install({
      get_preview_capabilities: () => fixturePreviewCapabilities(),
      get_preview_settings: () => {
        if (failing) throw new Error("Settings are unavailable");
        return { stored: storedSettings, effective: storedSettings };
      },
      get_preview_diagnostics: () => diagnostics,
    });
    render(<PreviewSettings />);
    expect(
      await screen.findByText(/Could not load preview settings: Settings are unavailable/),
    ).toBeTruthy();
    expectDomAbsent(screen.queryByText("Loading preview settings…"), "loading spinner");

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("switch", { name: "Issue new preview access" })).toBeTruthy();
  });

  test("another machine is read through the command node and kept out of the window's store", async () => {
    const initialPortal = portalStore.getState();
    portalStore.store.setState({ ...initialPortal, selfId: "command" as never });
    const answers: Record<string, unknown> = {
      get_preview_capabilities: fixturePreviewCapabilities(),
      get_preview_settings: { stored: storedSettings, effective: storedSettings },
      get_preview_diagnostics: diagnostics,
    };
    install({
      invoke_on_node: (args) => ({ outcome: "ok", result: answers[args.command as string] }),
    });
    try {
      render(
        <AccountMachineProvider value={{ machine: "leaf", name: "Leaf" }}>
          <PreviewSettings />
        </AccountMachineProvider>,
      );
      expect(await screen.findByRole("switch", { name: "Issue new preview access" })).toBeTruthy();
      const routed = invokeMock.mock.calls
        .filter(([command]) => command === "invoke_on_node")
        .map(([, args]) => [
          (args as { nodeId: string }).nodeId,
          (args as { command: string }).command,
        ]);
      expect(routed).toEqual([
        ["leaf", "get_preview_capabilities"],
        ["leaf", "get_preview_settings"],
        ["leaf", "get_preview_diagnostics"],
      ]);
      expect(
        invokeMock.mock.calls.some(([command]) => command === "get_preview_capabilities"),
      ).toBe(false);
      expect(usePreviewServiceStore.getState().capabilities).toBeNull();
    } finally {
      portalStore.store.setState(initialPortal);
    }
  });
});

test("a command node selected in a leaf window loads its capabilities without changing the leaf store", async () => {
  resetPreviewServiceSyncForTests();
  const leafCapabilities = fixturePreviewCapabilities({ backendInstanceId: "leaf-instance" });
  usePreviewServiceStore.setState({ capabilities: leafCapabilities, status: "unsupported" });
  window.orkestratorWorkspaceTarget = { nodeId: "leaf", nodeName: "Leaf", path: "direct" };
  const portal = mock(async (command: string) => {
    if (command === "get_preview_capabilities")
      return fixturePreviewCapabilities({ backendInstanceId: "command-instance" });
    if (command === "get_preview_settings")
      return { stored: storedSettings, effective: storedSettings };
    if (command === "get_preview_diagnostics") return diagnostics;
    throw new Error(`Unexpected portal command: ${command}`);
  });
  window.orkestratorPortal = { invoke: portal, listen: () => () => {} } as never;
  invokeMock.mockClear();
  try {
    render(
      <AccountMachineProvider value={{ machine: null, name: "Command" }}>
        <PreviewSettings />
      </AccountMachineProvider>,
    );
    await screen.findByRole("switch", { name: "Issue new preview access" });
    expect(portal).toHaveBeenCalledWith("get_preview_capabilities", {});
    expect(invokeMock).not.toHaveBeenCalled();
    expect(usePreviewServiceStore.getState().capabilities).toBe(leafCapabilities);
    expect(usePreviewServiceStore.getState().status).toBe("unsupported");
  } finally {
    cleanup();
    delete window.orkestratorPortal;
    delete window.orkestratorWorkspaceTarget;
    resetPreviewServiceSyncForTests();
  }
});
