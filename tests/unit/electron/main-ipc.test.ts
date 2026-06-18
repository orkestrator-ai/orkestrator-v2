import { describe, expect, mock, test } from "bun:test";
import { registerMainIpc } from "../../../electron/ipc";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function createHarness(options: { backend?: { invoke: ReturnType<typeof mock> } | null; window?: unknown } = {}) {
  const handlers = new Map<string, Handler>();
  const backend = options.backend === undefined
    ? { invoke: mock(async (_command: string, args: Record<string, unknown>) => ({ ok: true, args })) }
    : options.backend;
  const window = options.window ?? { id: 1 };
  const clipboardImage = {
    isEmpty: mock(() => false),
    getSize: mock(() => ({ width: 16, height: 9 })),
    toDataURL: mock(() => "data:image/png;base64,abc"),
  };
  const nativeImage = { createFromDataURL: mock((dataUrl: string) => ({ dataUrl })) };
  const appApi = { exit: mock(() => undefined) };
  const clipboardApi = {
    readText: mock(() => "copied"),
    writeText: mock(() => undefined),
    readImage: mock(() => clipboardImage),
    writeImage: mock(() => undefined),
  };
  const dialogApi = {
    showOpenDialog: mock(async () => ({ canceled: false, filePaths: ["/tmp/a", "/tmp/b"] })),
  };

  registerMainIpc({
    getBackend: () => backend,
    getMainWindow: () => window as never,
    ipc: {
      handle: (channel, listener) => handlers.set(channel, listener),
    },
    clipboardApi,
    dialogApi: dialogApi as never,
    appApi,
    nativeImageApi: nativeImage,
  });

  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing handler: ${channel}`);
    return Promise.resolve().then(() => handler({}, ...args));
  };

  return { invoke, handlers, backend, window, clipboardApi, clipboardImage, nativeImage, appApi, dialogApi };
}

describe("main IPC registration", () => {
  test("registers backend, clipboard, process, and window handlers", async () => {
    const harness = createHarness();

    await expect(harness.invoke("orkestrator:invoke", "get_projects", { projectId: "project-1" })).resolves.toEqual({
      ok: true,
      args: { projectId: "project-1" },
    });
    expect(harness.backend?.invoke).toHaveBeenCalledWith("get_projects", { projectId: "project-1" });

    await expect(harness.invoke("orkestrator:clipboard:read-text")).resolves.toBe("copied");
    await harness.invoke("orkestrator:clipboard:write-text", "paste");
    expect(harness.clipboardApi.writeText).toHaveBeenCalledWith("paste");

    await expect(harness.invoke("orkestrator:clipboard:read-image")).resolves.toEqual({
      width: 16,
      height: 9,
      dataUrl: "data:image/png;base64,abc",
    });
    await harness.invoke("orkestrator:clipboard:write-image", "data:image/png;base64,def");
    expect(harness.nativeImage.createFromDataURL).toHaveBeenCalledWith("data:image/png;base64,def");
    expect(harness.clipboardApi.writeImage).toHaveBeenCalledWith({ dataUrl: "data:image/png;base64,def" });

    await harness.invoke("orkestrator:process:exit", 7);
    expect(harness.appApi.exit).toHaveBeenCalledWith(7);
    await expect(harness.invoke("orkestrator:window:start-dragging")).resolves.toBeUndefined();
  });

  test("throws for backend commands before the backend is initialized", async () => {
    const harness = createHarness({ backend: null });

    await expect(harness.invoke("orkestrator:invoke", "get_projects", {})).rejects.toThrow("Backend is not initialized");
  });

  test("maps dialog options through the main window and supports canceled dialogs", async () => {
    const harness = createHarness();

    await expect(harness.invoke("orkestrator:dialog:open", { directory: true, multiple: true, title: "Pick", defaultPath: "/tmp" })).resolves.toEqual([
      "/tmp/a",
      "/tmp/b",
    ]);
    expect(harness.dialogApi.showOpenDialog).toHaveBeenCalledWith(harness.window, {
      title: "Pick",
      defaultPath: "/tmp",
      properties: ["openDirectory", "multiSelections"],
    });

    harness.dialogApi.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(harness.invoke("orkestrator:dialog:open", { directory: false })).resolves.toBeNull();
  });

  test("returns null when the clipboard image is empty", async () => {
    const harness = createHarness();
    harness.clipboardImage.isEmpty.mockReturnValueOnce(true);

    await expect(harness.invoke("orkestrator:clipboard:read-image")).resolves.toBeNull();
  });
});
