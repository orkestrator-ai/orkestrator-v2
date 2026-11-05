import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { resetTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import { loadEnvironmentImage } from "./environment-image-source";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const CONTENT_ORIGIN = "https://artifacts.example-usercontent.net";
const STREAM_URL = `${CONTENT_ORIGIN}/m/${"A".repeat(43)}`;
const PNG_BASE64 = "iVBORw0KGgo=";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
let handlers: Record<string, Handler>;
const OriginalImage = globalThis.Image;
let imageFails = false;
let imagePending = false;

function calls(command: string): Array<Record<string, unknown>> {
  return invokeMock.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => (args ?? {}) as Record<string, unknown>);
}

function setBackend(overrides: Record<string, Handler> = {}, contentOrigin: string | null) {
  handlers = {
    transcript_artifact_capabilities: async () => ({
      backendId: "backend-1",
      authoring: true,
      previewRenderer: { available: true, isolation: "process" },
      liveInteractive: contentOrigin !== null,
      contentOrigin,
      rolloutFlags: { richMarkdown: true, artifactPublication: true, liveInteractive: true },
    }),
    transcript_media_open_stream: async () => ({
      url: STREAM_URL,
      mimeType: "image/png",
      byteLength: 9 * 1024 * 1024,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      streamId: "stream-1",
    }),
    transcript_media_close_stream: async () => null,
    read_environment_file_base64: async () => PNG_BASE64,
    read_container_file_base64: async () => PNG_BASE64,
    ...overrides,
  };
}

const LOCAL = {
  environmentId: "env-1",
  isLocalEnvironment: true,
  worktreePath: "/worktrees/env-1",
  filePath: "assets/big.png",
  mimeType: "image/png",
};

beforeEach(() => {
  imageFails = false;
  imagePending = false;
  globalThis.Image = function () {
    const img = document.createElement("img");
    Object.defineProperty(img, "src", {
      set: () => {
        if (!imagePending)
          queueMicrotask(() => img.dispatchEvent(new Event(imageFails ? "error" : "load")));
      },
    });
    return img;
  } as unknown as typeof Image;
  resetTranscriptArtifactCapabilities();
  setBackend({}, CONTENT_ORIGIN);
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) =>
    handlers[command] ? handlers[command]!(args ?? {}) : Promise.resolve(),
  );
});

afterEach(() => {
  globalThis.Image = OriginalImage;
  resetTranscriptArtifactCapabilities();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("loadEnvironmentImage", () => {
  test("a reachable content origin serves a local image from a stream, revoked on release", async () => {
    const loaded = await loadEnvironmentImage(LOCAL);
    expect(loaded).toMatchObject({ url: STREAM_URL, source: "stream" });
    expect(calls("transcript_media_open_stream")).toEqual([
      { environmentId: "env-1", path: "assets/big.png" },
    ]);
    expect(calls("read_environment_file_base64")).toHaveLength(0);
    loaded.release();
    loaded.release();
    expect(calls("transcript_media_close_stream")).toEqual([{ streamId: "stream-1" }]);
  });

  test("an unreachable stream retries bounded base64 once and revokes the capability", async () => {
    imageFails = true;
    const loaded = await loadEnvironmentImage(LOCAL);
    expect(loaded.source).toBe("inline");
    loaded.release();
    expect(calls("read_environment_file_base64")).toHaveLength(1);
    expect(calls("transcript_media_close_stream")).toEqual([{ streamId: "stream-1" }]);
  });

  test("aborting a pending image load releases the stream without a stale base64 read", async () => {
    imagePending = true;
    const controller = new AbortController();
    const pending = loadEnvironmentImage(LOCAL, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(calls("read_environment_file_base64")).toHaveLength(0);
    expect(calls("transcript_media_close_stream")).toHaveLength(1);
  });

  test("a container image streams with its container id", async () => {
    const loaded = await loadEnvironmentImage({
      environmentId: "env-2",
      containerId: "c0ffee",
      filePath: "out/shot.png",
      mimeType: "image/png",
    });
    expect(loaded.source).toBe("stream");
    expect(calls("transcript_media_open_stream")).toEqual([
      { environmentId: "env-2", path: "out/shot.png", containerId: "c0ffee" },
    ]);
    expect(calls("read_container_file_base64")).toHaveLength(0);
  });

  test("without a content origin the bounded base64 read is used", async () => {
    setBackend({}, null);
    const loaded = await loadEnvironmentImage(LOCAL);
    expect(loaded).toMatchObject({ url: `data:image/png;base64,${PNG_BASE64}`, source: "inline" });
    expect(calls("transcript_media_open_stream")).toHaveLength(0);
    expect(calls("read_environment_file_base64")).toEqual([
      { environmentId: "env-1", filePath: "assets/big.png" },
    ]);
  });

  test("a refused stream (an SVG, an older backend) falls back to base64", async () => {
    setBackend(
      {
        transcript_media_open_stream: async () => {
          throw new Error(JSON.stringify({ code: "unsupported_kind", message: "x" }));
        },
      },
      CONTENT_ORIGIN,
    );
    const loaded = await loadEnvironmentImage({ ...LOCAL, filePath: "logo.svg" });
    expect(loaded.source).toBe("inline");
    expect(calls("read_environment_file_base64")).toHaveLength(1);
  });

  test("bytes that are not an image close the stream and fall back", async () => {
    setBackend(
      {
        transcript_media_open_stream: async () => ({
          url: STREAM_URL,
          mimeType: "video/mp4",
          byteLength: 10,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          streamId: "stream-9",
        }),
      },
      CONTENT_ORIGIN,
    );
    const loaded = await loadEnvironmentImage(LOCAL);
    expect(loaded.source).toBe("inline");
    expect(calls("transcript_media_close_stream")).toEqual([{ streamId: "stream-9" }]);
  });

  test("an image with no owning environment is refused before any read", async () => {
    await expect(loadEnvironmentImage({ ...LOCAL, environmentId: undefined })).rejects.toThrow(
      "The image has no owning environment",
    );
    expect(invokeMock.mock.calls).toHaveLength(0);
  });
});
