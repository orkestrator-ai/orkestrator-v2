import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fixturePreviewCapabilities } from "@orkestrator/protocol/preview-contract-fixtures";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { resetPreviewServiceSyncForTests } from "@/stores/previewServiceStore";
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
});
