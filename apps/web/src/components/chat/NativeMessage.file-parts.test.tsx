import { describe, expect, test } from "bun:test";

import { canLoadImagePreview } from "./NativeMessage.file-parts";

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
    expect(canLoadImagePreview("screens/shot.png", undefined, undefined)).toBe(false);
    expect(canLoadImagePreview("~/shot.png", undefined, undefined)).toBe(false);
  });

  test("is only a pre-filter: an absolute path outside the worktree still passes", () => {
    // The renderer does not know the worktree root the backend confines
    // `read_file_base64` to, so this cannot be exact. `ImageReadPreview` drops
    // the row when the load then fails; see NativeMessage.test.tsx.
    expect(canLoadImagePreview("/tmp/shot.png", undefined, undefined)).toBe(true);
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
