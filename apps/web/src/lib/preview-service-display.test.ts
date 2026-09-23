import { describe, expect, test } from "bun:test";
import {
  fixturePreviewCapabilities,
  fixturePreviewDefinition,
  fixturePreviewService,
} from "@orkestrator/protocol/preview-contract-fixtures";
import { emptyPreviewReadiness, previewError } from "@orkestrator/protocol/preview-services";

import {
  diagnoseService,
  parseServiceAddressInput,
  serviceDisplayUrl,
  serviceReadiness,
  serviceSummary,
} from "./preview-service-display";

describe("service address input", () => {
  const definition = fixturePreviewDefinition({ applicationPort: 3000 });

  test("paths and same-port addresses navigate within the service", () => {
    expect(parseServiceAddressInput("/docs?x=1#y", definition)).toEqual({
      kind: "path",
      path: "/docs?x=1#y",
    });
    expect(parseServiceAddressInput("http://localhost:3000/a", definition)).toEqual({
      kind: "path",
      path: "/a",
    });
    expect(parseServiceAddressInput("localhost:3000", definition)).toEqual({
      kind: "path",
      path: "/",
    });
    expect(parseServiceAddressInput("", definition)).toEqual({ kind: "path", path: "/" });
  });

  test("another loopback port asks for a different service; remote hosts are refused", () => {
    expect(parseServiceAddressInput("http://localhost:8080/api", definition)).toEqual({
      kind: "other-port",
      url: "http://localhost:8080/api",
    });
    expect(parseServiceAddressInput("https://example.com/", definition).kind).toBe("invalid");
    expect(parseServiceAddressInput("//evil", definition).kind).toBe("invalid");
    expect(parseServiceAddressInput("ftp://localhost:21/", definition).kind).toBe("invalid");
  });

  test("display URL is the application's own address", () => {
    expect(serviceDisplayUrl(definition, "/x")).toBe("http://localhost:3000/x");
  });
});

describe("service readiness and diagnosis", () => {
  test("summaries follow the proposal's label format", () => {
    expect(serviceSummary(fixturePreviewService())).toBe("web · container:3000 · ready");
  });

  test("401/404 are reachable, not down", () => {
    const service = fixturePreviewService();
    service.endpoint.readiness.http = { state: "ok", statusClass: "4xx" };
    expect(serviceReadiness(service)).toEqual({ label: "ready · 4xx", tone: "ready" });
    expect(diagnoseService(service)).toBeNull();
  });

  test("distinguishes stopped, unmapped, not listening, TLS, and expired access", () => {
    const stopped = fixturePreviewService();
    stopped.endpoint = {
      ...stopped.endpoint,
      state: "unavailable",
      failure: previewError("environment-stopped"),
    };
    expect(diagnoseService(stopped)?.actions).toContain("start-environment");

    const unmapped = fixturePreviewService();
    unmapped.endpoint = {
      ...unmapped.endpoint,
      state: "unavailable",
      failure: previewError("target-unmapped"),
    };
    expect(diagnoseService(unmapped)?.actions).toEqual(["configure-mapping", "retry"]);
    const withRelay = fixturePreviewCapabilities({ relay: { available: true } });
    expect(diagnoseService(unmapped, { capabilities: withRelay })?.actions[0]).toBe("use-relay");

    const silent = fixturePreviewService();
    silent.endpoint.readiness = {
      ...emptyPreviewReadiness(),
      tcp: { state: "failed", failure: "connection-refused" },
    };
    const listening = diagnoseService(silent);
    expect(listening?.title).toContain("Nothing is listening on container port 3000");
    expect(listening?.detail).toContain("0.0.0.0");

    const tls = fixturePreviewService({
      definition: { scheme: "https", tlsServerName: "app.test" },
    });
    tls.endpoint.readiness = {
      ...emptyPreviewReadiness(),
      tcp: { state: "ok" },
      tls: { state: "failed", failure: "tls-failed" },
    };
    expect(diagnoseService(tls)?.detail).toContain("app.test");

    expect(
      diagnoseService(fixturePreviewService(), {
        transport: { mode: "desktop-tunnel", state: "unavailable", failure: "access-expired" },
      })?.actions,
    ).toEqual(["reconnect"]);
    expect(diagnoseService(null)?.actions).toEqual(["choose-service"]);
    expect(diagnoseService(fixturePreviewService(), { backendOnline: false })?.title).toBe(
      "Backend offline",
    );
  });
});
