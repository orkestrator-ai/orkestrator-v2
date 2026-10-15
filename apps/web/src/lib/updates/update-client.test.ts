import { afterEach, describe, expect, mock, test } from "bun:test";
import type { UpdateOffer, UpdateStatusSnapshot } from "@orkestrator/protocol/updates";
import { useUpdateStore } from "@/stores/updateStore";
import { BUNDLED_APP_VERSION } from "@/lib/app-version";
import {
  localUpdateTransport,
  parseUpdateError,
  updatesApi,
  type UpdateTransport,
} from "./update-client";

const originalOrkestrator = window.orkestrator;
afterEach(() => {
  window.orkestrator = originalOrkestrator;
  useUpdateStore.setState({ targets: new Map(), dialogOpen: false });
});

function snapshot(revision: number): UpdateStatusSnapshot {
  return { revision } as UpdateStatusSnapshot;
}

describe("update errors", () => {
  test("parse the backend's coded errors and an old backend's missing command", () => {
    expect(
      parseUpdateError(new Error("UpdateError:consent-missing: Not approved: network-egress:x")),
    ).toEqual({
      code: "consent-missing",
      message: "Not approved: network-egress:x",
    });
    expect(parseUpdateError(new Error("Unknown backend command: update_get_status"))).toMatchObject(
      {
        code: "unsupported",
      },
    );
    expect(parseUpdateError("boom")).toEqual({ code: "unexpected", message: "boom" });
  });
});

describe("the update API", () => {
  test("sends consent, restart policy, downgrade intent and who the client is", async () => {
    const invoke = mock(async (_command: string, _args?: Record<string, unknown>) => snapshot(1));
    const transport: UpdateTransport = {
      key: "local",
      invoke: invoke as UpdateTransport["invoke"],
      subscribe: async () => () => undefined,
    };
    const api = updatesApi(transport);
    const offer = {
      version: "2.21.0",
      requirementsSha256: "a".repeat(64),
      downgrade: true,
    } as UpdateOffer;
    await api.start(offer, ["storage-migration:schema-4"], "manual");
    expect(invoke.mock.calls[0]).toEqual([
      "update_start",
      {
        targetVersion: "2.21.0",
        requirementsSha256: "a".repeat(64),
        approvedConsentIds: ["storage-migration:schema-4"],
        restartPolicy: "manual",
        allowDowngrade: true,
        client: { kind: "web", version: BUNDLED_APP_VERSION, name: null },
      },
    ]);
    await api.setChannel("beta");
    expect(invoke.mock.calls[1]?.[1]).toMatchObject({ channel: "beta" });
  });

  test("the desktop's local transport always goes to the local backend over IPC", async () => {
    const ipc = mock(async () => snapshot(1));
    const invoke = mock(async () => {
      throw new Error("must not use the active connection");
    });
    window.orkestrator = {
      ...originalOrkestrator,
      invoke,
      updates: { invoke: ipc },
    } as unknown as typeof window.orkestrator;
    await updatesApi(localUpdateTransport()).status();
    expect(ipc).toHaveBeenCalledWith("update_get_status", {});
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("the update store", () => {
  test("applies newer events, defers stale ones to a re-read, and always takes authoritative reads", () => {
    const store = useUpdateStore.getState();
    expect(store.applySnapshot("local", snapshot(5), false)).toBe("applied");
    expect(useUpdateStore.getState().applySnapshot("local", snapshot(5), false)).toBe("stale");
    expect(useUpdateStore.getState().applySnapshot("local", snapshot(4), false)).toBe("stale");
    // A restarted backend counts from zero; the re-read it triggers wins.
    expect(useUpdateStore.getState().applySnapshot("local", snapshot(1), true)).toBe("applied");
    expect(useUpdateStore.getState().targets.get("local")?.snapshot?.revision).toBe(1);
    expect(useUpdateStore.getState().applySnapshot("remote-a", snapshot(9), false)).toBe("applied");
    useUpdateStore.getState().forget("remote-a");
    expect(useUpdateStore.getState().targets.has("remote-a")).toBe(false);
  });
});
