import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  FIXTURE_BACKEND_EPOCH,
  FIXTURE_BACKEND_INSTANCE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixturePreviewCapabilities,
  fixturePreviewSnapshot,
} from "@orkestrator/protocol/testing/preview-contract-fixtures";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { previewServiceStore, resetPreviewServiceSyncForTests } from "./previewServiceStore";
import { appCommandStore } from "@/test/app-command-store";

const originalOrkestrator = window.orkestrator;
const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

function install(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`Unknown backend command: ${command}`);
    return handler(args);
  });
  window.orkestrator = { invoke: invokeMock, listen: () => () => undefined } as never;
  return invokeMock;
}

describe("previewServiceStore", () => {
  beforeEach(() => resetPreviewServiceSyncForTests());
  afterEach(() => {
    window.orkestrator = originalOrkestrator;
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("any capabilities failure, an unknown command included, is an error", async () => {
    install({});
    expect(await appCommandStore(previewServiceStore).getState().loadCapabilities()).toBeNull();
    expect(appCommandStore(previewServiceStore).getState().status).toBe("error");

    resetPreviewServiceSyncForTests();
    install({
      get_preview_capabilities: () => {
        throw new Error("Unauthorized");
      },
    });
    expect(await appCommandStore(previewServiceStore).getState().loadCapabilities()).toBeNull();
    expect(appCommandStore(previewServiceStore).getState().status).toBe("error");
  });

  test("refreshes conditionally and keeps the cached snapshot when not modified", async () => {
    const invoke = install({
      get_preview_capabilities: () => fixturePreviewCapabilities(),
      get_preview_services: (args) =>
        args.knownRevision === 3
          ? fixturePreviewSnapshot([], { notModified: true, registryRevision: 3 })
          : fixturePreviewSnapshot(),
    });
    const store = appCommandStore(previewServiceStore).getState();
    const first = await store.refreshEnvironment(FIXTURE_ENVIRONMENT_ID);
    expect(first?.services).toHaveLength(1);
    const second = await appCommandStore(previewServiceStore)
      .getState()
      .refreshEnvironment(FIXTURE_ENVIRONMENT_ID);
    expect(second?.services).toHaveLength(1);
    expect(
      invoke.mock.calls.filter(([command]) => command === "get_preview_services").at(-1)?.[1],
    ).toMatchObject({
      knownEpoch: FIXTURE_BACKEND_EPOCH,
      knownRevision: 3,
    });
  });

  test("invalidation events refetch only newer revisions of cached environments", async () => {
    let revision = 3;
    const invoke = install({
      get_preview_capabilities: () => fixturePreviewCapabilities(),
      get_preview_services: () => fixturePreviewSnapshot(undefined, { registryRevision: revision }),
    });
    await appCommandStore(previewServiceStore)
      .getState()
      .refreshEnvironment(FIXTURE_ENVIRONMENT_ID);
    const calls = () =>
      invoke.mock.calls.filter(([command]) => command === "get_preview_services").length;
    const before = calls();
    appCommandStore(previewServiceStore)
      .getState()
      .handleChanged({
        backendInstanceId: FIXTURE_BACKEND_INSTANCE_ID,
        backendEpoch: FIXTURE_BACKEND_EPOCH,
        registryRevision: 3,
        environmentIds: [FIXTURE_ENVIRONMENT_ID, "never-viewed"],
        revokedServiceIds: [],
      });
    expect(calls()).toBe(before);
    revision = 5;
    appCommandStore(previewServiceStore)
      .getState()
      .handleChanged({
        backendInstanceId: FIXTURE_BACKEND_INSTANCE_ID,
        backendEpoch: FIXTURE_BACKEND_EPOCH,
        registryRevision: 5,
        environmentIds: [FIXTURE_ENVIRONMENT_ID],
        revokedServiceIds: [],
      });
    await Bun.sleep(5);
    expect(calls()).toBe(before + 1);
    expect(
      appCommandStore(previewServiceStore).getState().environments[FIXTURE_ENVIRONMENT_ID]?.snapshot
        ?.registryRevision,
    ).toBe(5);
  });

  test("same-tick refreshes share one request", async () => {
    const invoke = install({
      get_preview_capabilities: () => fixturePreviewCapabilities(),
      get_preview_services: () => fixturePreviewSnapshot(),
    });
    const store = appCommandStore(previewServiceStore).getState();
    const first = store.refreshEnvironment(FIXTURE_ENVIRONMENT_ID);
    const second = store.refreshEnvironment(FIXTURE_ENVIRONMENT_ID);
    const [a, b] = await Promise.all([first, second]);
    await Bun.sleep(5);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(
      invoke.mock.calls.filter(([command]) => command === "get_preview_services"),
    ).toHaveLength(1);
  });

  test("an older snapshot arriving late does not replace a newer one", async () => {
    let resolveServices: (snapshot: unknown) => void = () => undefined;
    install({
      get_preview_capabilities: () => fixturePreviewCapabilities(),
      get_preview_services: () =>
        new Promise((resolve) => {
          resolveServices = resolve;
        }),
    });
    const pending = appCommandStore(previewServiceStore)
      .getState()
      .refreshEnvironment(FIXTURE_ENVIRONMENT_ID);
    await Bun.sleep(5);
    // A newer snapshot lands while the first request is still in flight.
    const newer = fixturePreviewSnapshot([], { registryRevision: 5 });
    appCommandStore(previewServiceStore).setState({
      environments: {
        [FIXTURE_ENVIRONMENT_ID]: { snapshot: newer, loading: false, error: null },
      },
    });
    resolveServices(fixturePreviewSnapshot(undefined, { registryRevision: 3 }));
    expect(await pending).toBe(newer);
    const stored =
      appCommandStore(previewServiceStore).getState().environments[FIXTURE_ENVIRONMENT_ID];
    expect(stored?.snapshot).toBe(newer);
    expect(stored?.loading).toBe(false);
  });

  test("a new backend identity discards cached snapshots from the old one", async () => {
    let identity = FIXTURE_BACKEND_INSTANCE_ID;
    install({
      get_preview_capabilities: () => fixturePreviewCapabilities({ backendInstanceId: identity }),
      get_preview_services: () =>
        fixturePreviewSnapshot(undefined, { backendInstanceId: identity }),
    });
    await appCommandStore(previewServiceStore)
      .getState()
      .refreshEnvironment(FIXTURE_ENVIRONMENT_ID);
    identity = "bk_other_backend_01";
    await appCommandStore(previewServiceStore).getState().loadCapabilities({ force: true });
    expect(appCommandStore(previewServiceStore).getState().environments).toEqual({});
    expect(appCommandStore(previewServiceStore).getState().capabilities?.backendInstanceId).toBe(
      "bk_other_backend_01",
    );
  });
});
