import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";

import { canLoadImagePreview, FilePart } from "./NativeMessage.file-parts";

const CONTAINER = "container-1";

describe("canLoadImagePreview inside a container", () => {
  test("accepts what the container reader will resolve under /workspace", () => {
    expect(canLoadImagePreview("/workspace/assets/shot.png", undefined, CONTAINER)).toBe(true);
    expect(canLoadImagePreview("assets/shot.png", undefined, CONTAINER)).toBe(true);
  });

  test("rejects paths the container reader refuses", () => {
    // Mirrors `getSafeContainerRelativePath`: anything absolute outside
    // /workspace, a home-relative path, a Windows path, or a traversal.
    expect(canLoadImagePreview("/tmp/shot.png", undefined, CONTAINER)).toBe(false);
    expect(canLoadImagePreview("~/shot.png", undefined, CONTAINER)).toBe(false);
    expect(canLoadImagePreview("C:\\Users\\Ada\\shot.png", undefined, CONTAINER)).toBe(false);
    expect(canLoadImagePreview("/workspace/../etc/shot.png", undefined, CONTAINER)).toBe(false);
    expect(canLoadImagePreview("/workspace/", undefined, CONTAINER)).toBe(false);
  });

  test("resolves a file URL before applying containment", () => {
    expect(
      canLoadImagePreview("file:///workspace/a.png", "file:///workspace/a.png", CONTAINER),
    ).toBe(true);
    expect(canLoadImagePreview("file:///tmp/a.png", "file:///tmp/a.png", CONTAINER)).toBe(false);
  });
});

describe("canLoadImagePreview on the host", () => {
  test("requires an absolute path, because a relative one has no root to resolve against", () => {
    expect(canLoadImagePreview("/home/ada/work/shot.png", undefined, undefined)).toBe(true);
    expect(canLoadImagePreview("C:\\Users\\Ada\\shot.png", undefined, undefined)).toBe(true);
    expect(canLoadImagePreview("screens/shot.png", undefined, undefined)).toBe(false);
    expect(canLoadImagePreview("~/shot.png", undefined, undefined)).toBe(false);
  });

  test("is only a pre-filter: an absolute path outside the readable roots still passes", () => {
    // The renderer does not know the workspace and temp roots the backend
    // confines `read_file_base64` to, so this cannot be exact.
    // `ImageReadPreview` drops the row when the load then fails; see
    // NativeMessage.test.tsx.
    expect(canLoadImagePreview("/Users/ada/Downloads/shot.png", undefined, undefined)).toBe(true);
  });
});

describe("canLoadImagePreview with inline or remote bytes", () => {
  test("accepts references that need no filesystem at all", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    expect(canLoadImagePreview("shot.png", dataUrl, undefined)).toBe(true);
    expect(canLoadImagePreview("shot.png", dataUrl, CONTAINER)).toBe(true);

    const remote = "https://example.test/shot.png";
    expect(canLoadImagePreview(remote, remote, undefined)).toBe(true);
    expect(canLoadImagePreview(remote, remote, CONTAINER)).toBe(true);
  });
});

describe("FilePart attachment routing", () => {
  const invokeMock = invoke as unknown as ReturnType<typeof mock>;

  afterEach(() => {
    cleanup();
    invokeMock.mockReset();
  });

  test("keeps the generic preview and original download for a ZIP under an image-named folder", async () => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "read_file_base64" ? "UEsDBAA=" : null),
    );
    renderInAppCommandScope(<FilePart path="/workspace/archive.png/export.zip" />);
    fireEvent.click(screen.getByRole("button", { name: /^Preview file: export\.zip/ }));
    expect(await screen.findByRole("button", { name: "Download original" })).toBeTruthy();
  });

  test("ignores image markers in a URL query and keeps known videos in the file viewer", () => {
    renderInAppCommandScope(
      <>
        <FilePart
          path="/workspace/export.zip"
          fileUrl="https://example.test/export.zip?thumbnail=photo.png"
        />
        <FilePart path="/workspace/archive.png/recording.mp4" />
      </>,
    );
    expect(screen.getByRole("button", { name: /^Preview file: export\.zip/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Preview file: recording\.mp4/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open full image/ })).toBeNull();
  });

  test.each(["?version=2", "#preview"])(
    "opens a genuine image with %s in the gallery",
    async (suffix) => {
      const fileUrl = `https://example.test/photo.webp${suffix}`;
      renderInAppCommandScope(<FilePart path={fileUrl} fileUrl={fileUrl} filename="photo.webp" />);
      fireEvent.click(screen.getByRole("button", { name: "Open full image: photo.webp" }));
      expect(await screen.findByRole("dialog")).toBeTruthy();
      expect(screen.getByRole("img").getAttribute("src")).toBe(fileUrl);
    },
  );

  test("falls back to file actions when a filename-based image hint fails to decode", async () => {
    const decode = spyOn(HTMLImageElement.prototype, "decode").mockRejectedValue(
      new DOMException("Cannot decode attachment", "EncodingError"),
    );
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "read_file_base64" ? "UEsDBAA=" : null),
    );
    try {
      renderInAppCommandScope(<FilePart path="/workspace/photo.png.bak" />);
      fireEvent.click(screen.getByRole("button", { name: "Open full image: photo.png.bak" }));
      fireEvent.click(
        await screen.findByRole("button", { name: /^Preview file: photo\.png\.bak/ }),
      );
      expect(await screen.findByRole("button", { name: "Download original" })).toBeTruthy();
      expect(decode).toHaveBeenCalledTimes(1);
    } finally {
      decode.mockRestore();
    }
  });
});
