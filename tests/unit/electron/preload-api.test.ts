import { describe, expect, mock, test } from "bun:test";
import { createOrkestratorElectronApi, type IpcRendererLike } from "../../../electron/preload-api";

function createIpcMock() {
  const listeners = new Map<string, (event: unknown, name: string, payload: unknown) => void>();
  const invoke = mock(async (channel: string, ...args: unknown[]) => ({ channel, args }));
  const on = mock((channel: string, listener: (event: unknown, name: string, payload: unknown) => void) => {
    listeners.set(channel, listener);
  });
  const ipc = { invoke, on } as IpcRendererLike;
  return {
    ipc,
    invoke,
    on,
    emit(channel: string, name: string, payload: unknown) {
      listeners.get(channel)?.({}, name, payload);
    },
  };
}

describe("preload API factory", () => {
  test("routes backend commands through the invoke IPC channel", async () => {
    const { ipc, invoke } = createIpcMock();
    const api = createOrkestratorElectronApi(ipc);

    await expect(api.invoke("get_projects")).resolves.toEqual({ channel: "orkestrator:invoke", args: ["get_projects", {}] });
    await expect(api.invoke("get_environment", { environmentId: "env-1" })).resolves.toEqual({
      channel: "orkestrator:invoke",
      args: ["get_environment", { environmentId: "env-1" }],
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test("subscribes and unsubscribes renderer event callbacks by event name", () => {
    const { ipc, emit, on } = createIpcMock();
    const api = createOrkestratorElectronApi(ipc);
    const firstHandler = mock(() => undefined);
    const secondHandler = mock(() => undefined);

    const unlistenFirst = api.listen("environment-updated", firstHandler);
    api.listen("other-event", secondHandler);

    expect(on).toHaveBeenCalledWith("orkestrator:event", expect.any(Function));
    emit("orkestrator:event", "environment-updated", { id: "env-1" });
    emit("orkestrator:event", "other-event", { id: "other" });

    expect(firstHandler).toHaveBeenCalledWith({ id: "env-1" });
    expect(secondHandler).toHaveBeenCalledWith({ id: "other" });

    unlistenFirst();
    emit("orkestrator:event", "environment-updated", { id: "env-2" });
    expect(firstHandler).toHaveBeenCalledTimes(1);
  });

  test("maps native utility APIs to their IPC channels", async () => {
    const { ipc } = createIpcMock();
    const api = createOrkestratorElectronApi(ipc);

    await expect(api.clipboard.readText()).resolves.toEqual({ channel: "orkestrator:clipboard:read-text", args: [] });
    await expect(api.clipboard.writeText("copy")).resolves.toEqual({ channel: "orkestrator:clipboard:write-text", args: ["copy"] });
    await expect(api.clipboard.readImage()).resolves.toEqual({ channel: "orkestrator:clipboard:read-image", args: [] });
    await expect(api.clipboard.writeImage("data:image/png;base64,abc")).resolves.toEqual({
      channel: "orkestrator:clipboard:write-image",
      args: ["data:image/png;base64,abc"],
    });
    await expect(api.dialog.open({ directory: true })).resolves.toEqual({ channel: "orkestrator:dialog:open", args: [{ directory: true }] });
    await expect(api.webClient.getStatus()).resolves.toEqual({ channel: "orkestrator:web-client:get-status", args: [] });
    await expect(api.webClient.setEnabled(false)).resolves.toEqual({ channel: "orkestrator:web-client:set-enabled", args: [false] });
    await expect(api.process.exit(7)).resolves.toEqual({ channel: "orkestrator:process:exit", args: [7] });
    await expect(api.window.startDragging()).resolves.toEqual({ channel: "orkestrator:window:start-dragging", args: [] });
  });
});
