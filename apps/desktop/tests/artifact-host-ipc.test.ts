import { describe, expect, mock, test } from "bun:test";
import { ARTIFACT_HOST_CHANNELS } from "@orkestrator/protocol/artifact-host-ipc";
import {
  artifactContentUrl,
  artifactHostBounds,
  artifactHostId,
  artifactHostOpenInput,
  artifactThemeMessage,
  registerArtifactHostIpc,
  type ArtifactHostController,
} from "../electron/artifact-host-ipc";
import { registerMainIpc } from "../electron/ipc";
import { createArtifactHostApi, type IpcRendererLike } from "../electron/preload-api";

const CONTENT_URL = "http://127.0.0.1:47123/artifact-content/cap_abcdefghijklmnop/document";
const TRUSTED_RENDERER = "http://127.0.0.1:1420";

const validOpen = {
  hostId: "host-1",
  contentUrl: CONTENT_URL,
  artifactId: "art_1",
  revision: 3,
  generation: "gen_0001",
  readinessNonce: "nonce_12345678",
  bounds: { x: 0, y: 0, width: 600, height: 300 },
  visible: true,
};

const validTheme = {
  channel: "orkestrator-artifact",
  v: 1,
  type: "theme",
  artifactId: "art_1",
  revision: 3,
  generation: "gen_0001",
  appearance: "light",
  reducedMotion: true,
  viewport: { width: 600, height: 300 },
  tokens: { "--ork-bg": "#ffffff" },
};

function controller(): ArtifactHostController & Record<string, ReturnType<typeof mock>> {
  return {
    open: mock(async () => ({ ok: true as const })),
    setBounds: mock(() => undefined),
    setVisible: mock(() => undefined),
    postTheme: mock(() => undefined),
    close: mock(() => undefined),
  };
}

describe("artifact host IPC validation", () => {
  test("accepts a well-formed open request and normalizes the content URL", () => {
    expect(artifactHostOpenInput(validOpen, TRUSTED_RENDERER)).toEqual(validOpen);
  });

  for (const [name, value] of [
    ["a non-HTTP scheme", "file:///etc/passwd"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,hi"],
    ["embedded credentials", "http://user:pass@127.0.0.1:47123/doc"],
    ["a fragment", `${CONTENT_URL}#x`],
    ["the application origin", "http://127.0.0.1:1420/api/doc"],
    ["control characters", "http://127.0.0.1:47123/doc\n"],
    ["an oversized URL", `http://127.0.0.1:47123/${"a".repeat(5_000)}`],
    ["a non-string", 42],
  ] as const) {
    test(`rejects a content URL with ${name}`, () => {
      expect(() => artifactContentUrl(value, TRUSTED_RENDERER)).toThrow();
    });
  }

  test("validates host ids, bounds and identity fields strictly", () => {
    expect(artifactHostId("abc_DEF-123")).toBe("abc_DEF-123");
    for (const bad of ["", "a b", "x".repeat(129), "../x", 7, null]) {
      expect(() => artifactHostId(bad)).toThrow();
    }
    expect(() => artifactHostBounds({ x: 0, y: 0, width: Number.NaN, height: 1 })).toThrow();
    expect(() => artifactHostBounds({ x: 0, y: 0, width: -1, height: 1 })).toThrow();
    expect(() => artifactHostBounds({ x: 0, y: 0, width: Infinity, height: 1 })).toThrow();
    expect(() => artifactHostBounds([0, 0, 1, 1])).toThrow();
    expect(() => artifactHostOpenInput({ ...validOpen, visible: "yes" })).toThrow();
    expect(() => artifactHostOpenInput({ ...validOpen, revision: 1.5 })).toThrow();
    expect(() => artifactHostOpenInput({ ...validOpen, readinessNonce: "short" })).toThrow();
    expect(() => artifactHostOpenInput({ ...validOpen, generation: "has space" })).toThrow();
    expect(() => artifactHostOpenInput({ ...validOpen, preload: "/tmp/x.js" })).toThrow();
  });

  test("accepts exactly the theme presentation fields", () => {
    expect(artifactThemeMessage(validTheme)).toEqual(validTheme as never);
    for (const bad of [
      { ...validTheme, type: "ready" },
      { ...validTheme, channel: "other" },
      { ...validTheme, appearance: "sepia" },
      { ...validTheme, reducedMotion: "no" },
      { ...validTheme, command: "send_prompt" },
      { ...validTheme, viewport: { width: Infinity, height: 1 } },
      { ...validTheme, tokens: { "not-a-token": "x" } },
      { ...validTheme, tokens: { "--ok": "x".repeat(200) } },
      { ...validTheme, tokens: { "--ok": "a\u0000b" } },
      {
        ...validTheme,
        tokens: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`--t${i}`, "x"])),
      },
    ]) {
      expect(() => artifactThemeMessage(bad)).toThrow();
    }
  });
});

describe("artifact host IPC routing", () => {
  function register(getController: (event: { id: number }) => ArtifactHostController | null) {
    const handlers = new Map<string, (event: { id: number }, ...args: unknown[]) => unknown>();
    registerArtifactHostIpc({
      handle: (channel, listener) => handlers.set(channel, listener),
      getController,
      trustedRendererUrl: TRUSTED_RENDERER,
    });
    return handlers;
  }

  test("routes each call to the sending window's controller", async () => {
    const windowA = controller();
    const windowB = controller();
    const handlers = register((event) => (event.id === 1 ? windowA : windowB));
    await handlers.get(ARTIFACT_HOST_CHANNELS.open)!({ id: 2 }, validOpen);
    expect(windowB.open).toHaveBeenCalledWith(validOpen);
    expect(windowA.open).not.toHaveBeenCalled();
    handlers.get(ARTIFACT_HOST_CHANNELS.setBounds)!({ id: 1 }, "host-1", {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    expect(windowA.setBounds).toHaveBeenCalledWith("host-1", { x: 1, y: 2, width: 3, height: 4 });
    handlers.get(ARTIFACT_HOST_CHANNELS.setVisible)!({ id: 1 }, "host-1", false);
    expect(windowA.setVisible).toHaveBeenCalledWith("host-1", false);
    handlers.get(ARTIFACT_HOST_CHANNELS.postTheme)!({ id: 1 }, "host-1", validTheme);
    expect(windowA.postTheme).toHaveBeenCalledWith("host-1", validTheme);
    handlers.get(ARTIFACT_HOST_CHANNELS.close)!({ id: 1 }, "host-1");
    expect(windowA.close).toHaveBeenCalledWith("host-1");
  });

  test("an invalid or unavailable open resolves ok:false instead of throwing", async () => {
    const handlers = register(() => null);
    await expect(
      handlers.get(ARTIFACT_HOST_CHANNELS.open)!({ id: 1 }, validOpen) as Promise<unknown>,
    ).resolves.toMatchObject({ ok: false });
    const available = controller();
    const withController = register(() => available);
    await expect(
      withController.get(ARTIFACT_HOST_CHANNELS.open)!(
        { id: 1 },
        {
          ...validOpen,
          contentUrl: "file:///etc/passwd",
        },
      ) as Promise<unknown>,
    ).resolves.toMatchObject({ ok: false });
    expect(available.open).not.toHaveBeenCalled();
  });

  test("malformed positioning and theme arguments are rejected before the controller", () => {
    const available = controller();
    const handlers = register(() => available);
    expect(() =>
      handlers.get(ARTIFACT_HOST_CHANNELS.setBounds)!({ id: 1 }, "host-1", { x: 1 }),
    ).toThrow();
    expect(() =>
      handlers.get(ARTIFACT_HOST_CHANNELS.setVisible)!({ id: 1 }, "host-1", 1),
    ).toThrow();
    expect(() =>
      handlers.get(ARTIFACT_HOST_CHANNELS.postTheme)!({ id: 1 }, "host-1", {
        ...validTheme,
        type: "link-request",
      }),
    ).toThrow();
    expect(() => handlers.get(ARTIFACT_HOST_CHANNELS.close)!({ id: 1 }, "bad id")).toThrow();
    expect(available.setBounds).not.toHaveBeenCalled();
    expect(available.postTheme).not.toHaveBeenCalled();
    expect(available.close).not.toHaveBeenCalled();
  });

  test("registerMainIpc registers the channels behind the trusted-sender check", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const available = controller();
    registerMainIpc({
      ipc: {
        handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) =>
          handlers.set(channel, listener),
      },
      trustedRendererUrl: "file:///app/web/index.html",
      getArtifactHosts: () => available,
    } as never);
    for (const channel of [
      ARTIFACT_HOST_CHANNELS.open,
      ARTIFACT_HOST_CHANNELS.setBounds,
      ARTIFACT_HOST_CHANNELS.setVisible,
      ARTIFACT_HOST_CHANNELS.postTheme,
      ARTIFACT_HOST_CHANNELS.close,
    ]) {
      expect(handlers.has(channel)).toBe(true);
    }
    expect(handlers.has(ARTIFACT_HOST_CHANNELS.event)).toBe(false);
    const untrusted = { senderFrame: { url: "http://127.0.0.1:47123/artifact-content/x" } };
    expect(() => handlers.get(ARTIFACT_HOST_CHANNELS.close)!(untrusted, "host-1")).toThrow(
      "Blocked IPC request from an untrusted renderer",
    );
    expect(available.close).not.toHaveBeenCalled();
    const trusted = { senderFrame: { url: "file:///app/web/index.html" } };
    await expect(
      handlers.get(ARTIFACT_HOST_CHANNELS.open)!(trusted, validOpen) as Promise<unknown>,
    ).resolves.toEqual({ ok: true });
  });
});

describe("artifact host preload bridge", () => {
  function ipcMock() {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const invoke = mock(async (channel: string, ...args: unknown[]) => ({ channel, args }));
    const on = mock((channel: string, listener: (event: unknown, payload: unknown) => void) => {
      listeners.set(channel, listener);
    });
    return {
      ipc: { invoke, on } as unknown as IpcRendererLike,
      invoke,
      on,
      emit: (channel: string, payload: unknown) => listeners.get(channel)?.({}, payload),
    };
  }

  test("maps every method to its fixed channel", async () => {
    const { ipc, invoke } = ipcMock();
    const api = createArtifactHostApi(ipc);
    expect(Object.keys(api).sort()).toEqual(
      ["close", "onEvent", "open", "postTheme", "setBounds", "setVisible"].sort(),
    );
    await api.open(validOpen);
    await api.setBounds("host-1", validOpen.bounds);
    await api.setVisible("host-1", false);
    await api.postTheme("host-1", validTheme as never);
    await api.close("host-1");
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      ARTIFACT_HOST_CHANNELS.open,
      ARTIFACT_HOST_CHANNELS.setBounds,
      ARTIFACT_HOST_CHANNELS.setVisible,
      ARTIFACT_HOST_CHANNELS.postTheme,
      ARTIFACT_HOST_CHANNELS.close,
    ]);
  });

  test("delivers host events to listeners until they unsubscribe", () => {
    const { ipc, on, emit } = ipcMock();
    const api = createArtifactHostApi(ipc);
    expect(on).not.toHaveBeenCalled();
    const received: unknown[] = [];
    const unsubscribe = api.onEvent((event) => received.push(event));
    api.onEvent(() => undefined);
    expect(on).toHaveBeenCalledTimes(1);
    emit(ARTIFACT_HOST_CHANNELS.event, { hostId: "host-1", type: "ready" });
    emit(ARTIFACT_HOST_CHANNELS.event, { hostId: "host-1", type: "run-tool" });
    emit(ARTIFACT_HOST_CHANNELS.event, "garbage");
    unsubscribe();
    emit(ARTIFACT_HOST_CHANNELS.event, { hostId: "host-1", type: "closed", reason: "requested" });
    expect(received).toEqual([{ hostId: "host-1", type: "ready" }]);
  });
});
