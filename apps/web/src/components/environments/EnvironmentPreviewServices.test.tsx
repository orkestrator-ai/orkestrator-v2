import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  FIXTURE_ENVIRONMENT_ID,
  fixturePreviewCapabilities,
  fixturePreviewService,
  fixturePreviewSnapshot,
} from "@orkestrator/protocol/preview-contract-fixtures";
import { previewError } from "@orkestrator/protocol/preview-services";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { resetPreviewServiceSyncForTests } from "@/stores/previewServiceStore";
import { PreviewSettings } from "@/components/settings/PreviewSettings";
import { EnvironmentPreviewServices } from "./EnvironmentPreviewServices";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

function install(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) =>
    handlers[command]?.(args),
  );
}

describe("environment preview services", () => {
  beforeEach(() => resetPreviewServiceSyncForTests());
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("lists services with readiness and offers an automatic mapping for an unpublished port", async () => {
    const api = fixturePreviewService({
      definition: {
        serviceId: "svc_fixture_api_0002",
        label: "api",
        applicationPort: 8000,
        entry: false,
      },
    });
    api.endpoint = {
      ...api.endpoint,
      state: "unavailable",
      hostPort: null,
      failure: previewError("target-unmapped"),
    };
    install({
      get_preview_capabilities: () => fixturePreviewCapabilities(),
      get_preview_services: () => fixturePreviewSnapshot([fixturePreviewService(), api]),
      update_preview_service: () => ({
        kind: "definition",
        replayed: false,
        definition: api.definition,
      }),
    });
    const onAddPortMapping = mock((_port: number) => undefined);
    render(
      <EnvironmentPreviewServices
        environment={{ id: FIXTURE_ENVIRONMENT_ID, environmentType: "containerized" }}
        onAddPortMapping={onAddPortMapping}
      />,
    );
    expect(await screen.findByText("web")).toBeTruthy();
    expect(screen.getByText(/container:3000 → host 49152 · ready/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish port 8000 (auto)" }));
    expect(onAddPortMapping).toHaveBeenCalledWith(8000);

    fireEvent.click(screen.getByRole("button", { name: "Open api from the browser button" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "update_preview_service",
        expect.objectContaining({ serviceId: "svc_fixture_api_0002", patch: { entry: true } }),
      ),
    );
  });

  test("older backends explain that browser tabs use ports directly", async () => {
    install({
      get_preview_capabilities: () => {
        throw new Error("Unknown backend command: get_preview_capabilities");
      },
    });
    render(
      <EnvironmentPreviewServices
        environment={{ id: FIXTURE_ENVIRONMENT_ID, environmentType: "local" }}
      />,
    );
    expect(await screen.findByText(/predates preview services/)).toBeTruthy();
  });
});

describe("preview operator settings", () => {
  beforeEach(() => resetPreviewServiceSyncForTests());
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("the issuance kill switch and the revoke action are separate operations", async () => {
    const settings = {
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
    install({
      get_preview_capabilities: () => fixturePreviewCapabilities(),
      get_preview_settings: () => ({ stored: settings, effective: settings }),
      get_preview_diagnostics: () => ({
        registry: { definitions: 1, available: 1, unavailable: 0 },
        access: { attachments: 2, resources: 3, pendingGrants: 0 },
        resolver: {},
        readiness: {},
        metrics: {
          counters: { "tunnel.open": 4 },
          histograms: {},
          gauges: { "tunnel.sockets": 3 },
        },
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
      }),
      update_preview_settings: () => ({ stored: settings, effective: settings }),
      revoke_preview_access: () => ({ revoked: 2 }),
    });
    render(<PreviewSettings />);
    const toggle = await screen.findByRole("switch", { name: "Issue new preview access" });
    expect(screen.getByText("Private preview publication is disabled.")).toBeTruthy();
    expect(screen.getByText("tunnel.sockets")).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_preview_settings", {
        settings: { transport: false },
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("revoke_preview_access", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Revoke all active preview access" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("revoke_preview_access", {}));
  });
});
