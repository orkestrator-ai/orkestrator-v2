import { describe, expect, mock, test } from "bun:test";
import {
  connectionPreviewBackend,
  rebindWindowPreviews,
  type PreviewConnectionClient,
} from "../electron/preview-connection-backend";

function client(name: string) {
  const invoke = mock(async (command: string) => ({ backend: name, command }));
  return {
    invoke: invoke as unknown as PreviewConnectionClient["invoke"],
    previewTunnelUrl: () => `ws://${name}/__orkestrator/preview/tunnel`,
    calls: invoke,
  };
}

describe("connection preview backend", () => {
  test("keeps releasing on the issuing backend after the window's connection is gone", async () => {
    const issuing = client("remote");
    let held: PreviewConnectionClient | null = issuing;
    const backend = connectionPreviewBackend(() => held);
    await backend.invoke("create_preview_attachment", {});
    expect(backend.tunnelUrl()).toBe("ws://remote/__orkestrator/preview/tunnel");

    // A switch or window close releases the connection before the old
    // transport's teardown runs.
    held = null;
    await expect(backend.invoke("release_preview_attachment", {})).resolves.toEqual({
      backend: "remote",
      command: "release_preview_attachment",
    });
    expect(issuing.calls).toHaveBeenCalledTimes(2);
  });

  test("follows the connection's current client, such as one with a rotated token", async () => {
    const before = client("before");
    const after = client("after");
    let held: PreviewConnectionClient = before;
    const backend = connectionPreviewBackend(() => held);
    await backend.invoke("renew_preview_attachment", {});
    held = after;
    await backend.invoke("renew_preview_attachment", {});
    expect(before.calls).toHaveBeenCalledTimes(1);
    expect(after.calls).toHaveBeenCalledTimes(1);
  });

  test("rejects, without throwing synchronously, when the connection was never reachable", async () => {
    const backend = connectionPreviewBackend(() => null);
    let promise: Promise<unknown> | null = null;
    expect(() => {
      promise = backend.invoke("release_preview_attachment", {});
    }).not.toThrow();
    await expect(promise!).rejects.toThrow("The preview connection is not available.");
    expect(backend.tunnelUrl()).toBeNull();
  });
});

describe("rebinding a window's previews", () => {
  function runtime(connectionId: string) {
    return {
      connectionId,
      manager: { destroyAll: mock(() => undefined) },
      previewTransport: { disposeAll: mock(async () => undefined) },
    };
  }

  test("keeps the previews while the window stays on their connection", () => {
    const current = runtime("local");
    const context = {
      previewConnectionId: "local",
      browserPreviewManager: current.manager,
      previewTransport: current.previewTransport,
    };
    const create = mock(runtime);
    expect(rebindWindowPreviews(context, "local", create)).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(current.manager.destroyAll).not.toHaveBeenCalled();
    expect(context.browserPreviewManager).toBe(current.manager);
  });

  test("ends the old connection's previews and installs the new connection's", async () => {
    const current = runtime("local");
    const context = {
      previewConnectionId: "local",
      browserPreviewManager: current.manager,
      previewTransport: current.previewTransport,
    };
    const created: Array<ReturnType<typeof runtime>> = [];
    const create = (connectionId: string) => {
      const next = runtime(connectionId);
      created.push(next);
      return next;
    };
    expect(rebindWindowPreviews(context, "remote-1", create)).toBe(true);
    expect(current.manager.destroyAll).toHaveBeenCalledTimes(1);
    expect(current.previewTransport.disposeAll).toHaveBeenCalledTimes(1);
    expect(created.map((item) => item.connectionId)).toEqual(["remote-1"]);
    expect(context).toEqual({
      previewConnectionId: "remote-1",
      browserPreviewManager: created[0]!.manager,
      previewTransport: created[0]!.previewTransport,
    });
  });

  test("logs, never throws, when the old transport fails to close", async () => {
    const current = runtime("remote-1");
    current.previewTransport.disposeAll = mock(async () => {
      throw new Error("tunnel gone");
    });
    const context = {
      previewConnectionId: "remote-1",
      browserPreviewManager: current.manager,
      previewTransport: current.previewTransport,
    };
    const warn = mock((..._args: unknown[]) => undefined);
    rebindWindowPreviews(context, "local", runtime, { warn });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledWith("transport.close-failed", {
      error: expect.objectContaining({ name: "Error" }),
    });
  });
});
