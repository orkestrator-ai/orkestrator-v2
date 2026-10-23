import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { clearImagePreviewCache } from "@/lib/chat/image-preview-cache";
import { INLINE_MEDIA_PLAYBACK_MAX_BYTES } from "@/lib/chat/media-presentation";
import { clearMediaResolverInflight } from "@/lib/chat/rich-markdown/media-resolver";
import { FilePreview } from "./FilePreview";
import { MarkdownImage, MediaScopeContext } from "./MediaBlock";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A PNG signature plus an IHDR declaring `width` × `height`. */
function pngHeaderBase64(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytesToBase64(bytes);
}

const MP4_HEADER_BASE64 = btoa("\u0000\u0000\u0000\u0018ftypmp42");

/** Base64 that decodes to more than the inline playback bound (only the length matters). */
function oversizedBase64(): string {
  const characters = Math.ceil(((INLINE_MEDIA_PLAYBACK_MAX_BYTES + 1024) * 4) / 3 / 4) * 4;
  return MP4_HEADER_BASE64.slice(0, 20) + "A".repeat(characters - 20);
}

function readCalls(): unknown[][] {
  return invokeMock.mock.calls.filter(
    ([command]) => command === "read_file_base64" || command === "read_container_file_base64",
  );
}

type ObserverGlobal = { IntersectionObserver?: unknown };
const realIntersectionObserver = (globalThis as ObserverGlobal).IntersectionObserver;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
const createObjectURL = mock((_blob: Blob) => "blob:media-test");

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  // Load immediately: these tests are about states, not the viewport.
  delete (globalThis as ObserverGlobal).IntersectionObserver;
  createObjectURL.mockClear();
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => {};
});

afterEach(() => {
  cleanup();
  clearImagePreviewCache();
  clearMediaResolverInflight();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  (globalThis as ObserverGlobal).IntersectionObserver = realIntersectionObserver;
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = realCreateObjectURL;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = realRevokeObjectURL;
});

function readResolves(base64: string) {
  invokeMock.mockImplementation((command: string) =>
    command === "read_file_base64" ? Promise.resolve(base64) : Promise.resolve(),
  );
}

function readRejects(message: string) {
  invokeMock.mockImplementation((command: string) =>
    command === "read_file_base64" ? Promise.reject(new Error(message)) : Promise.resolve(),
  );
}

describe("Markdown image placeholders", () => {
  test("an offscreen image keeps a bounded placeholder and reads nothing", () => {
    class NeverIntersects {
      observe() {}
      disconnect() {}
    }
    (globalThis as ObserverGlobal).IntersectionObserver = NeverIntersects;
    render(<MarkdownImage src="/workspace-storage/shot.png" alt="Shot" />);
    const button = screen.getByRole("button", { name: "Open image: Shot" });
    expect(button.getAttribute("data-media-state")).toBe("pending");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("Loading image…");
    expect(button.style.aspectRatio).toBe("4 / 3");
    expect(button.style.width).toBe("10rem");
    expect(readCalls()).toHaveLength(0);
  });

  test("reserves the header's intrinsic size before the browser decodes", async () => {
    readResolves(pngHeaderBase64(640, 360));
    const { container } = render(<MarkdownImage src="/workspace-storage/wide.png" alt="Wide" />);
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    const image = container.querySelector("img")!;
    expect(image.getAttribute("width")).toBe("640");
    expect(image.getAttribute("height")).toBe("360");
    expect(image.style.aspectRatio).toBe("640 / 360");
    // Known dimensions replace the generic placeholder box.
    const button = screen.getByRole("button", { name: "Open image: Wide" });
    expect(button.style.aspectRatio).toBe("");
    expect(readCalls()).toEqual([
      ["read_file_base64", { filePath: "/workspace-storage/wide.png" }],
    ]);
  });

  test("a remote image without known dimensions keeps the bounded box until it loads", () => {
    const { container } = render(<MarkdownImage src="https://example.com/a.png" alt="Remote" />);
    const button = screen.getByRole("button", { name: "Open image: Remote" });
    expect(button.style.aspectRatio).toBe("4 / 3");
    fireEvent.load(container.querySelector("img")!);
    expect(button.style.aspectRatio).toBe("");
  });

  test("a path outside the workspace is its own state with no file actions", async () => {
    readRejects("Invalid file path: file is outside Orkestrator workspace storage");
    render(<MarkdownImage src="/tmp/shot.png" alt="Shot" />);
    const image = await screen.findByRole("img", { name: "Shot (image outside of the workspace)" });
    expect(image.textContent).toContain("Shot · image outside of the workspace");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  test("a container path outside /workspace is reported without a read", () => {
    render(
      <MediaScopeContext.Provider value={{ containerId: "container-1" }}>
        <MarkdownImage src="/tmp/shot.png" alt="Shot" />
      </MediaScopeContext.Provider>,
    );
    expect(screen.getByRole("img", { name: "Shot (image outside of the workspace)" })).toBeTruthy();
    expect(readCalls()).toHaveLength(0);
  });

  test("access denied by the backend is its own state with no file actions", async () => {
    readRejects("EACCES: permission denied, open '/workspace-storage/secret.png'");
    render(<MarkdownImage src="/workspace-storage/secret.png" alt="Secret" />);
    const image = await screen.findByRole("img", { name: "Secret (image access denied)" });
    expect(image.textContent).toContain("Secret · access to this image was denied");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  test("an unavailable image keeps its alt text and can be retried", async () => {
    readRejects("ENOENT: no such file or directory, open '/workspace-storage/gone.png'");
    render(<MarkdownImage src="/workspace-storage/gone.png" alt="Gone" />);
    const image = await screen.findByRole("img", { name: "Gone (image unavailable)" });
    expect(image.textContent).toContain("Gone · image unavailable");
    expect(readCalls()).toHaveLength(1);
    readResolves(pngHeaderBase64(2, 2));
    fireEvent.click(screen.getByRole("button", { name: "Retry loading image: Gone" }));
    await waitFor(() => expect(readCalls()).toHaveLength(2));
    expect(await screen.findByRole("button", { name: "Open image: Gone" })).toBeTruthy();
  });

  test("a file above the backend read limit says it is too large", async () => {
    readRejects("File exceeds 10485760 bytes");
    render(<MarkdownImage src="/workspace-storage/huge.png" alt="Huge" />);
    const image = await screen.findByRole("img", { name: "Huge (image too large)" });
    expect(image.textContent).toContain("image too large to preview");
  });

  test("bytes that are not an image are unsupported and stay downloadable", async () => {
    readResolves(btoa("%PDF-1.7 not an image"));
    render(<MarkdownImage src="/workspace-storage/fake.png" alt="Fake" />);
    const image = await screen.findByRole("img", { name: "Fake (image unsupported)" });
    expect(image.textContent).toContain("not a supported image");
    expect(screen.getByRole("button", { name: "Download original: Fake" })).toBeTruthy();
    expect(document.querySelector("img") === null).toBe(true);
  });

  test("an image header above the decode ceiling is never handed to <img>", async () => {
    readResolves(pngHeaderBase64(10_000, 5_000));
    render(<MarkdownImage src="/workspace-storage/giant.png" alt="Giant" />);
    const image = await screen.findByRole("img", { name: "Giant (image unsupported)" });
    expect(image.textContent).toContain("40-megapixel preview limit");
    expect(document.querySelector("img") === null).toBe(true);
  });

  test("failed decoding keeps the alt text and offers the original", async () => {
    readResolves(pngHeaderBase64(8, 8));
    const { container } = render(
      <MarkdownImage src="/workspace-storage/broken.png" alt="Broken" />,
    );
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    fireEvent.error(container.querySelector("img")!);
    const image = await screen.findByRole("img", { name: "Broken (image could not be decoded)" });
    expect(image.textContent).toContain("Broken · image could not be decoded");
    expect(screen.getByRole("button", { name: "Download original: Broken" })).toBeTruthy();
  });

  test("a remote image that fails keeps a link to its original", () => {
    const { container } = render(<MarkdownImage src="https://example.com/x.png" alt="Remote x" />);
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByRole("img", { name: "Remote x (image unavailable)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open original in browser: Remote x" })).toBeTruthy();
  });

  test("each state has distinct visible text", async () => {
    const texts = new Set<string>();
    const cases: Array<[string, () => void, string]> = [
      [
        "/private/a.png",
        () => readRejects("outside Orkestrator workspace storage"),
        "outside-workspace",
      ],
      ["/workspace-storage/e.png", () => readRejects("EACCES"), "denied"],
      ["/workspace-storage/b.png", () => readRejects("ENOENT"), "unavailable"],
      ["/workspace-storage/c.png", () => readRejects("File exceeds 1 bytes"), "too-large"],
      ["/workspace-storage/d.png", () => readResolves(btoa("plain text")), "unsupported"],
    ];
    for (const [src, arrange, state] of cases) {
      arrange();
      const { container } = render(<MarkdownImage src={src} alt="X" />);
      await waitFor(() =>
        expect(container.querySelector(`[data-media-state="${state}"]`)).toBeTruthy(),
      );
      texts.add(container.textContent ?? "");
      cleanup();
      clearMediaResolverInflight();
    }
    const blocked = render(<MarkdownImage src="" alt="X" />);
    texts.add(blocked.container.textContent ?? "");
    expect(texts.size).toBe(6);
  });
});

describe("file preview states", () => {
  test("video reads nothing until Load video, then plays from a blob", async () => {
    readResolves(MP4_HEADER_BASE64);
    render(<FilePreview reference={{ path: "/workspace-storage/clip.mp4" }} name="clip.mp4" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview file: clip.mp4 (Video)" }));
    expect(screen.getByText(/not loaded until you choose Load video/)).toBeTruthy();
    // Give any eager effect a chance to run: nothing may be read yet.
    await act(async () => {});
    expect(readCalls()).toHaveLength(0);
    expect(document.querySelector("video") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    expect(readCalls()).toHaveLength(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const video = document.querySelector("video")!;
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.hasAttribute("autoplay")).toBe(false);
    // A playback decode failure is reported, and the original stays downloadable.
    fireEvent.error(video);
    expect(await screen.findByText(/This video could not be decoded or played/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download original" })).toBeTruthy();
  });

  test("inline audio above the playback bound is refused before anything is decoded", async () => {
    const fileUrl = `data:audio/mpeg;base64,${oversizedBase64()}`;
    render(<FilePreview reference={{ path: "long.mp3", fileUrl }} name="long.mp3" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview file: long.mp3 (Audio)" }));
    expect(await screen.findByText(/above the 8\.0 MiB inline playback limit/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load audio" }) === null).toBe(true);
    expect(screen.getByRole("button", { name: "Download original" })).toBeTruthy();
    expect(document.querySelector("audio") === null).toBe(true);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test("a video read above the bound after activation is offered as a download only", async () => {
    readResolves(oversizedBase64());
    render(<FilePreview reference={{ path: "/workspace-storage/big.mp4" }} name="big.mp4" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview file: big.mp4 (Video)" }));
    fireEvent.click(screen.getByRole("button", { name: "Load video" }));
    expect(await screen.findByText(/above the 8\.0 MiB inline playback limit/)).toBeTruthy();
    expect(document.querySelector("video") === null).toBe(true);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Download original" })).toBeTruthy();
  });

  test.each([
    [
      "Invalid file path: file is outside Orkestrator workspace storage",
      /The file is outside of the workspace/,
      "outside-workspace",
    ],
    ["EACCES: permission denied", /Access to this file was denied/, "denied"],
    ["ENOENT: no such file or directory", /The file is unavailable/, "unavailable"],
    ["File exceeds 10485760 bytes", /larger than the backend's read limit/, "too-large"],
  ])("a read failure %p is shown as %s", async (message, text, state) => {
    readRejects(message);
    render(<FilePreview reference={{ path: "/workspace-storage/notes.txt" }} name="notes.txt" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview file: notes.txt (Text)" }));
    const status = await screen.findByText(text);
    expect(status.getAttribute("data-media-state")).toBe(state);
    // The filename stays visible.
    expect(screen.getByRole("dialog").textContent).toContain("notes.txt");
  });

  test("an image file previews as <img> with its header dimensions reserved", async () => {
    readResolves(pngHeaderBase64(320, 200));
    render(<FilePreview reference={{ path: "/workspace-storage/icon.ico" }} name="icon.ico" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview file: icon.ico (Image)" }));
    const image = await screen.findByRole("img", { name: "icon.ico" });
    expect(image.getAttribute("width")).toBe("320");
    expect(image.getAttribute("height")).toBe("200");
    expect(image.style.aspectRatio).toBe("320 / 200");
  });
});

test.each(["success", "failure", "pending"])(
  "changing an existing source after %s loads only the new reference",
  async (initial) => {
    let finishA!: (value: string) => void;
    const a = new Promise<string>((resolve) => {
      finishA = resolve;
    });
    invokeMock.mockImplementation((command: string, args: { filePath?: string }) => {
      if (command !== "read_file_base64") return Promise.resolve();
      if (args.filePath?.endsWith("a.png"))
        return initial === "pending"
          ? a
          : initial === "failure"
            ? Promise.reject(new Error("unavailable"))
            : Promise.resolve(pngHeaderBase64(20, 10));
      return Promise.resolve(pngHeaderBase64(40, 30));
    });
    const { rerender, container } = render(
      <MarkdownImage src="/workspace-storage/a.png" alt="Image" />,
    );
    await waitFor(() => expect(readCalls()).toHaveLength(1));
    if (initial === "success")
      await waitFor(() => expect(container.querySelector("img")?.getAttribute("width")).toBe("20"));
    if (initial === "failure")
      await screen.findByRole("img", { name: "Image (image unavailable)" });
    rerender(<MarkdownImage src="/workspace-storage/b.png" alt="Image" />);
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("width")).toBe("40"));
    await act(async () => {
      finishA(pngHeaderBase64(20, 10));
      await a;
    });
    expect(container.querySelector("img")?.getAttribute("width")).toBe("40");
  },
);
