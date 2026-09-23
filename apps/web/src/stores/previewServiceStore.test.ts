import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  FIXTURE_BACKEND_EPOCH,
  FIXTURE_BACKEND_INSTANCE_ID,
  FIXTURE_ENVIRONMENT_ID,
  fixturePreviewCapabilities,
  fixturePreviewSnapshot,
} from "@orkestrator/protocol/preview-contract-fixtures";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { resetPreviewServiceSyncForTests, usePreviewServiceStore } from "./previewServiceStore";

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

  test("an unknown command marks an old backend; other failures are errors", async () => {
    install({});
    expect(await usePreviewServiceStore.getState().loadCapabilities()).toBeNull();
    expect(usePreviewServiceStore.getState().status).toBe("unsupported");

    resetPreviewServiceSyncForTests();
    install({
      get_preview_capabilities: () => {
        throw new Error("Unauthorized");
      },
    });
    expect(await usePreviewServiceStore.getState().loadCapabilities()).toBeNull();
    expect(usePreviewServiceStore.getState().status).toBe("error");
  });

  test("refreshes conditionally and keeps the cached snapshot when not modified", async () => {
    const invoke = install({
      get_preview_capabilities: () => fixturePreviewCapabilities(),
      get_preview_services: (args) =>
        args.knownRevision === 3
          ? fixturePreviewSnapshot([], { notModified: true, registryRevision: 3 })
          : fixturePreviewSnapshot(),
    });
    const store = usePreviewServiceStore.getState();
    const first = await store.refreshEnvironment(FIXTURE_ENVIRONMENT_ID);
    expect(first?.services).toHaveLength(1);
    const second = await usePreviewServiceStore
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
    await usePreviewServiceStore.getState().refreshEnvironment(FIXTURE_ENVIRONMENT_ID);
    const calls = () =>
      invoke.mock.calls.filter(([command]) => command === "get_preview_services").length;
    const before = calls();
    usePreviewServiceStore.getState().handleChanged({
      backendInstanceId: FIXTURE_BACKEND_INSTANCE_ID,
      backendEpoch: FIXTURE_BACKEND_EPOCH,
      registryRevision: 3,
      environmentIds: [FIXTURE_ENVIRONMENT_ID, "never-viewed"],
      revokedServiceIds: [],
    });
    expect(calls()).toBe(before);
    revision = 5;
    usePreviewServiceStore.getState().handleChanged({
      backendInstanceId: FIXTURE_BACKEND_INSTANCE_ID,
      backendEpoch: FIXTURE_BACKEND_EPOCH,
      registryRevision: 5,
      environmentIds: [FIXTURE_ENVIRONMENT_ID],
      revokedServiceIds: [],
    });
    await Bun.sleep(5);
    expect(calls()).toBe(before + 1);
    expect(
      usePreviewServiceStore.getState().environments[FIXTURE_ENVIRONMENT_ID]?.snapshot
        ?.registryRevision,
    ).toBe(5);
  });

  test("a new backend identity discards cached snapshots from the old one", async () => {
    let identity = FIXTURE_BACKEND_INSTANCE_ID;
    install({
      get_preview_capabilities: () => fixturePreviewCapabilities({ backendInstanceId: identity }),
      get_preview_services: () =>
        fixturePreviewSnapshot(undefined, { backendInstanceId: identity }),
    });
    await usePreviewServiceStore.getState().refreshEnvironment(FIXTURE_ENVIRONMENT_ID);
    identity = "bk_other_backend_01";
    await usePreviewServiceStore.getState().loadCapabilities({ force: true });
    expect(usePreviewServiceStore.getState().environments).toEqual({});
    expect(usePreviewServiceStore.getState().capabilities?.backendInstanceId).toBe(
      "bk_other_backend_01",
    );
  });
});
