import { afterEach, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { clearMediaResolverInflight, resolveMediaUrl } from "./media-resolver";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  clearMediaResolverInflight();
  invokeMock.mockReset();
});

test.each(["?v=2", "#preview"])(
  "keeps image/webp on a local image path with %s",
  async (suffix) => {
    const path = `/workspace/photo.webp${suffix}`;
    invokeMock.mockResolvedValue("UklGRgAAAABXRUJQ");
    await expect(resolveMediaUrl({ path }, { cacheImage: true })).resolves.toBe(
      "data:image/webp;base64,UklGRgAAAABXRUJQ",
    );
    expect(invokeMock).toHaveBeenCalledWith("read_file_base64", { filePath: path });
  },
);

test("reads the path from a file URL without the query or fragment", async () => {
  invokeMock.mockResolvedValue("UklGRgAAAABXRUJQ");
  await expect(
    resolveMediaUrl(
      { path: "photo", fileUrl: "file:///workspace/photo.webp?v=2#preview" },
      { cacheImage: true },
    ),
  ).resolves.toBe("data:image/webp;base64,UklGRgAAAABXRUJQ");
  expect(invokeMock).toHaveBeenCalledWith("read_file_base64", {
    filePath: "/workspace/photo.webp",
  });
});
