import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { invoke } from "@/lib/native/backend";
import { resetTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import { RichTranscriptScopeContext, type RichTranscriptScope } from "@/lib/chat/rich-identity";
import { clearImagePreviewCache } from "@/lib/chat/image-preview-cache";
import { clearMediaResolverInflight } from "@/lib/chat/rich-markdown/media-resolver";
import { FilePreview } from "./FilePreview";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const CONTENT_ORIGIN = "https://artifacts.example-usercontent.net";
const STREAM_URL = `${CONTENT_ORIGIN}/m/${"A".repeat(43)}`;
const MP4_HEADER_BASE64 = btoa("\u0000\u0000\u0000\u0018ftypmp42");
const SCOPE: RichTranscriptScope = {
  backendId: "backend-1",
  environmentId: "env-1",
  logicalSessionKey: "session-1",
  generation: "g1",
};

const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
const realPause = HTMLMediaElement.prototype.pause;
const pause = mock(() => {});

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
let handlers: Record<string, Handler>;

function calls(command: string): Array<Record<string, unknown>> {
  return invokeMock.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => (args ?? {}) as Record<string, unknown>);
}

function structured(code: string, message: string): Error {
  return new Error(JSON.stringify({ code, message, retryClass: "never" }));
}

function capabilities(contentOrigin: string | null) {
  return {
    backendId: "backend-1",
    authoring: true,
    previewRenderer: { available: true, isolation: "process" },
    liveInteractive: contentOrigin !== null,
    contentOrigin,
    rolloutFlags: { richMarkdown: true, artifactPublication: true, liveInteractive: true },
  };
}

function setBackend(
  overrides: Record<string, Handler> = {},
  contentOrigin: string | null = CONTENT_ORIGIN,
) {
  handlers = {
    transcript_artifact_capabilities: async () => capabilities(contentOrigin),
    transcript_media_open_stream: async () => ({
      url: STREAM_URL,
      mimeType: "video/mp4",
      byteLength: 64 * 1024 * 1024,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      streamId: "stream-1",
    }),
    transcript_media_close_stream: async () => null,
    read_file_base64: async () => MP4_HEADER_BASE64,
    ...overrides,
  };
}

function Scoped({ children }: { children: ReactNode }) {
  return <RichTranscriptScopeContext value={SCOPE}>{children}</RichTranscriptScopeContext>;
}

async function openPreview(reference: { path: string; containerId?: string }, name: string) {
  const view = render(
    <Scoped>
      <FilePreview reference={reference} name={name} />
    </Scoped>,
  );
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Preview file: ${name}`) }));
  // The capability snapshot loads once per connection, when a viewer needs it.
  await waitFor(() => expect(calls("transcript_artifact_capabilities").length).toBeGreaterThan(0));
  await act(async () => {});
  return view;
}

beforeEach(() => {
  resetTranscriptArtifactCapabilities();
  setBackend();
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) =>
    handlers[command] ? handlers[command]!(args ?? {}) : Promise.resolve(),
  );
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = () => "blob:media-test";
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => {};
  pause.mockClear();
  HTMLMediaElement.prototype.pause = pause;
});

afterEach(() => {
  cleanup();
  clearImagePreviewCache();
  clearMediaResolverInflight();
  resetTranscriptArtifactCapabilities();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = realCreateObjectURL;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = realRevokeObjectURL;
  HTMLMediaElement.prototype.pause = realPause;
});

describe("streamed file preview media", () => {
  test("streams a large video only after Load video and revokes it when the viewer closes", async () => {
    const view = await openPreview({ path: "/workspace-storage/big.mp4" }, "big.mp4");
    expect(screen.getByText(/not loaded until you choose Load video/)).toBeTruthy();
    await act(async () => {});
    expect(calls("transcript_media_open_stream")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    expect(calls("transcript_media_open_stream")).toEqual([
      { environmentId: "env-1", path: "/workspace-storage/big.mp4" },
    ]);
    const video = document.querySelector("video")!;
    expect(video.getAttribute("src")).toBe(STREAM_URL);
    expect(video.getAttribute("data-media-source")).toBe("stream");
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.hasAttribute("autoplay")).toBe(false);
    // Above the 8 MiB inline bound, yet playable: no base64 read, no refusal.
    expect(screen.getByRole("dialog").textContent).toContain("64.0 MiB");
    expect(screen.queryByText(/inline playback limit/) === null).toBe(true);
    expect(calls("read_file_base64")).toHaveLength(0);

    view.unmount();
    expect(pause).toHaveBeenCalled();
    await waitFor(() =>
      expect(calls("transcript_media_close_stream")).toEqual([{ streamId: "stream-1" }]),
    );
  });

  test("a container file streams by its workspace-relative path", async () => {
    setBackend({
      transcript_media_open_stream: async () => ({
        url: STREAM_URL,
        mimeType: "audio/ogg",
        byteLength: 1024,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        streamId: "stream-2",
      }),
    });
    await openPreview({ path: "/workspace/out/voice.ogg", containerId: "c0ffee" }, "voice.ogg");
    fireEvent.click(screen.getByRole("button", { name: "Load audio" }));
    await waitFor(() => expect(document.querySelector("audio")).toBeTruthy());
    expect(calls("transcript_media_open_stream")).toEqual([
      { environmentId: "env-1", path: "out/voice.ogg", containerId: "c0ffee" },
    ]);
    expect(document.querySelector("audio")!.getAttribute("src")).toBe(STREAM_URL);
    // A small streamed asset can still be downloaded; bytes are read only on request.
    expect(screen.getByRole("button", { name: "Download original" })).toBeTruthy();
    expect(calls("read_container_file_base64")).toHaveLength(0);
  });

  test("without a content origin the bounded base64 path is used and nothing is streamed", async () => {
    setBackend({}, null);
    await openPreview({ path: "/workspace-storage/clip.mp4" }, "clip.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    expect(calls("transcript_media_open_stream")).toHaveLength(0);
    expect(calls("read_file_base64")).toHaveLength(1);
    expect(document.querySelector("video")!.getAttribute("src")).toBe("blob:media-test");
    expect(document.querySelector("video")!.getAttribute("data-media-source")).toBe("inline");
  });

  test("a backend that cannot open a stream falls back to the bounded base64 path", async () => {
    setBackend({
      transcript_media_open_stream: async () => {
        throw structured("renderer_unavailable", "The artifact content origin is unavailable");
      },
    });
    await openPreview({ path: "/workspace-storage/clip.mp4" }, "clip.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    expect(calls("transcript_media_open_stream")).toHaveLength(1);
    expect(calls("read_file_base64")).toHaveLength(1);
    expect(document.querySelector("video")!.getAttribute("src")).toBe("blob:media-test");
  });

  test("an unreachable stream falls back before metadata and its capability is closed", async () => {
    await openPreview({ path: "/workspace-storage/clip.mp4" }, "clip.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    await waitFor(() =>
      expect(document.querySelector("video")?.getAttribute("src")).toBe(STREAM_URL),
    );
    fireEvent.error(document.querySelector("video")!);
    await waitFor(() =>
      expect(document.querySelector("video")?.getAttribute("src")).toBe("blob:media-test"),
    );
    expect(calls("read_file_base64")).toHaveLength(1);
    await waitFor(() =>
      expect(calls("transcript_media_close_stream")).toEqual([{ streamId: "stream-1" }]),
    );
  });

  test("playback that stops after metadata offers Load again with a fresh stream", async () => {
    await openPreview({ path: "/workspace-storage/clip.mp4" }, "clip.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    const video = document.querySelector("video")!;
    fireEvent.loadedMetadata(video);
    fireEvent.error(video);
    expect(await screen.findByText(/Playback stopped/)).toBeTruthy();
    expect(calls("read_file_base64")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Load again" }));
    await waitFor(() => expect(calls("transcript_media_open_stream")).toHaveLength(2));
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
  });

  test.each([
    ["policy_denied", /Access to this file was denied/, "denied"],
    ["not_found", /The file is unavailable/, "unavailable"],
    ["package_size_exceeded", /larger than the backend's read limit/, "too-large"],
    ["unsupported_kind", /not a playable audio or video type/, "unsupported"],
  ])("a %s stream refusal is shown and not retried through base64", async (code, text, state) => {
    setBackend({
      transcript_media_open_stream: async () => {
        throw structured(code, "refused");
      },
    });
    await openPreview({ path: "/workspace-storage/clip.mp4" }, "clip.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    const status = await screen.findByText(text);
    expect(status.getAttribute("data-media-state")).toBe(state);
    expect(calls("read_file_base64")).toHaveLength(0);
    expect(document.querySelector("video") === null).toBe(true);
  });

  test.each([
    {
      source: "host",
      reference: { path: "/workspace-storage/clip.mp4" },
      message: "The file is outside the environment's workspace",
      target: { environmentId: "env-1", path: "/workspace-storage/clip.mp4" },
    },
    {
      source: "container",
      reference: { path: "/workspace/out/clip.mp4", containerId: "c0ffee" },
      message: "The file is outside the container workspace",
      target: { environmentId: "env-1", path: "out/clip.mp4", containerId: "c0ffee" },
    },
  ])(
    "a $source confinement refusal shows workspace copy without base64 fallback",
    async ({ reference, message, target }) => {
      setBackend({
        transcript_media_open_stream: async () => {
          throw structured("policy_denied", message);
        },
      });
      await openPreview(reference, "clip.mp4");
      fireEvent.click(screen.getByRole("button", { name: "Load video" }));
      const status = await screen.findByText(/The file is outside previewable workspace storage/);
      expect(status.getAttribute("data-media-state")).toBe("outside-workspace");
      expect(calls("transcript_media_open_stream")).toEqual([target]);
      expect(calls("read_file_base64")).toHaveLength(0);
      expect(calls("read_container_file_base64")).toHaveLength(0);
      expect(document.querySelector("video") === null).toBe(true);
      expect(screen.queryByRole("button", { name: "Load video" }) === null).toBe(true);
    },
  );

  test("bytes that sniff as a non-playable type are not played and the stream is closed", async () => {
    setBackend({
      transcript_media_open_stream: async () => ({
        url: STREAM_URL,
        mimeType: "image/png",
        byteLength: 2048,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        streamId: "stream-3",
      }),
    });
    await openPreview({ path: "/workspace-storage/clip.mp4" }, "clip.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    expect(await screen.findByText(/contents do not match its Video type/)).toBeTruthy();
    expect(document.querySelector("video") === null).toBe(true);
    await waitFor(() =>
      expect(calls("transcript_media_close_stream")).toEqual([{ streamId: "stream-3" }]),
    );
  });
});
