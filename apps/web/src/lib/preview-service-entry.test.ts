import { describe, expect, test } from "bun:test";
import {
  FIXTURE_BACKEND_EPOCH,
  FIXTURE_BACKEND_INSTANCE_ID,
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_SERVICE_ID,
  fixturePreviewCapabilities,
  fixturePreviewService,
  fixturePreviewSnapshot,
} from "@orkestrator/protocol/testing/preview-contract-fixtures";

import {
  legacyUrlHostPort,
  legacyUrlServiceMatch,
  sameLegacyUrlServiceBinding,
} from "./preview-service-entry";

// The fixture service is container port 3000 published on host port 49152.
const LEGACY_URL = "http://localhost:49152/app/next?tab=2#top";
const capabilities = fixturePreviewCapabilities();

function service(
  serviceId: string,
  hostPort: number | null,
  overrides: Parameters<typeof fixturePreviewService>[0] = {},
) {
  const snapshot = fixturePreviewService({
    ...overrides,
    definition: { serviceId, label: serviceId, ...overrides.definition },
  });
  snapshot.endpoint = { ...snapshot.endpoint, hostPort, ...overrides.endpoint };
  return snapshot;
}

describe("legacy URL tab to service matching", () => {
  test("an unambiguous current service converts with the URL's path, query and fragment", () => {
    const snapshot = fixturePreviewSnapshot([
      service(FIXTURE_SERVICE_ID, 49152),
      service("svc_fixture_api_0002", 49153),
    ]);
    const match = legacyUrlServiceMatch(LEGACY_URL, FIXTURE_ENVIRONMENT_ID, capabilities, snapshot);
    expect(match?.ref).toEqual({
      backendInstanceId: FIXTURE_BACKEND_INSTANCE_ID,
      environmentId: FIXTURE_ENVIRONMENT_ID,
      serviceId: FIXTURE_SERVICE_ID,
      path: "/app/next?tab=2#top",
    });
    expect(match?.backendEpoch).toBe(FIXTURE_BACKEND_EPOCH);
    expect(match?.endpointGeneration).toBe(1);
    // 127.0.0.1 and an implicit path are the same loopback address.
    expect(
      legacyUrlServiceMatch(
        "http://127.0.0.1:49152",
        FIXTURE_ENVIRONMENT_ID,
        capabilities,
        snapshot,
      )?.ref.path,
    ).toBe("/");
  });

  test("two services claiming the port are ambiguous, even when only one is current", () => {
    const current = service(FIXTURE_SERVICE_ID, 49152);
    const other = service("svc_fixture_api_0002", 49152);
    expect(
      legacyUrlServiceMatch(
        LEGACY_URL,
        FIXTURE_ENVIRONMENT_ID,
        capabilities,
        fixturePreviewSnapshot([current, other]),
      ),
    ).toBeNull();
    const stale = service("svc_fixture_api_0002", 49152, {
      endpoint: { ...current.endpoint, state: "revoked" },
    });
    expect(
      legacyUrlServiceMatch(
        LEGACY_URL,
        FIXTURE_ENVIRONMENT_ID,
        capabilities,
        fixturePreviewSnapshot([current, stale]),
      ),
    ).toBeNull();
  });

  test("never matches across environments, whichever one is active", () => {
    const elsewhere = service(FIXTURE_SERVICE_ID, 49152, {
      definition: { environmentId: "env-fixture-b" },
    });
    // The tab's environment has no service on that port; another one does.
    expect(
      legacyUrlServiceMatch(
        LEGACY_URL,
        FIXTURE_ENVIRONMENT_ID,
        capabilities,
        fixturePreviewSnapshot([elsewhere], { environmentId: null }),
      ),
    ).toBeNull();
    // A snapshot of another environment never answers for this tab.
    expect(
      legacyUrlServiceMatch(
        LEGACY_URL,
        "env-fixture-b",
        capabilities,
        fixturePreviewSnapshot([service(FIXTURE_SERVICE_ID, 49152)]),
      ),
    ).toBeNull();
  });

  test("a stale epoch, backend or binding never matches", () => {
    const current = service(FIXTURE_SERVICE_ID, 49152);
    const at = (
      snapshot: ReturnType<typeof fixturePreviewSnapshot>,
      caps: typeof capabilities | null = capabilities,
    ) => legacyUrlServiceMatch(LEGACY_URL, FIXTURE_ENVIRONMENT_ID, caps, snapshot);

    // The endpoint was resolved by an earlier backend start.
    expect(
      at(
        fixturePreviewSnapshot([
          service(FIXTURE_SERVICE_ID, 49152, {
            endpoint: { ...current.endpoint, backendEpoch: "ep_fixture_epoch_0000" },
          }),
        ]),
      ),
    ).toBeNull();
    // The cached snapshot predates a backend restart.
    expect(
      at(fixturePreviewSnapshot([current]), fixturePreviewCapabilities({ backendEpoch: "ep_2" })),
    ).toBeNull();
    // Another backend identity entirely.
    expect(
      at(fixturePreviewSnapshot([current], { backendInstanceId: "bk_fixture_instance_0002" })),
    ).toBeNull();
    // Being re-resolved, unavailable or disabled: the last host port is history.
    for (const state of ["revoked", "resolving", "unavailable"] as const) {
      expect(
        at(
          fixturePreviewSnapshot([
            service(FIXTURE_SERVICE_ID, 49152, { endpoint: { ...current.endpoint, state } }),
          ]),
        ),
      ).toBeNull();
    }
    expect(
      at(
        fixturePreviewSnapshot([
          service(FIXTURE_SERVICE_ID, 49152, { definition: { enabled: false } }),
        ]),
      ),
    ).toBeNull();
    expect(at(fixturePreviewSnapshot([current]), null)).toBeNull();
    expect(at(null as never)).toBeNull();
  });

  test("a different endpoint generation is a different binding", () => {
    const snapshot = fixturePreviewSnapshot([service(FIXTURE_SERVICE_ID, 49152)]);
    const offered = legacyUrlServiceMatch(
      LEGACY_URL,
      FIXTURE_ENVIRONMENT_ID,
      capabilities,
      snapshot,
    )!;
    const rebound = fixturePreviewSnapshot([
      service(FIXTURE_SERVICE_ID, 49152, {
        endpoint: { ...snapshot.services[0]!.endpoint, endpointGeneration: 2 },
      }),
    ]);
    const later = legacyUrlServiceMatch(LEGACY_URL, FIXTURE_ENVIRONMENT_ID, capabilities, rebound)!;
    expect(sameLegacyUrlServiceBinding(offered, offered)).toBe(true);
    expect(sameLegacyUrlServiceBinding(offered, later)).toBe(false);
  });

  test("only plain loopback HTTP addresses are considered", () => {
    const snapshot = fixturePreviewSnapshot([service(FIXTURE_SERVICE_ID, 49152)]);
    for (const url of [
      "http://example.test:49152/",
      "http://192.168.1.20:49152/",
      "http://0.0.0.0:49152/",
      "https://localhost:49152/",
      "http://user:secret@localhost:49152/",
      "localhost:49152",
      "",
    ]) {
      expect(legacyUrlHostPort(url)).toBeNull();
      expect(legacyUrlServiceMatch(url, FIXTURE_ENVIRONMENT_ID, capabilities, snapshot)).toBeNull();
    }
    expect(legacyUrlHostPort("http://[::1]:49152/")).toBe(49152);
    expect(legacyUrlHostPort("http://localhost/")).toBe(80);
  });
});
